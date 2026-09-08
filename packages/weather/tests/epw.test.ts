import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { monthlyMeans, parseEpw } from '@idfkit/weather';
import { loadEpw } from '@idfkit/weather/node';

import { buildEpw, yearRowCount } from './epw-fixtures.js';

describe('parseEpw', () => {
  it('reads the header records', () => {
    const epw = parseEpw(buildEpw());

    expect(epw.location.city).toBe('Chicago Ohare Intl Ap');
    expect(epw.location.country).toBe('USA');
    expect(epw.location.latitude).toBeCloseTo(41.98);
    expect(epw.location.timeZone).toBe(-6);
    expect(epw.location.elevation).toBe(201);

    expect(epw.typicalPeriods).toHaveLength(1);
    expect(epw.typicalPeriods[0]?.kind).toBe('Extreme');
    expect(epw.groundTemperatures).toHaveLength(1);
    expect(epw.groundTemperatures[0]?.depth).toBeCloseTo(0.5);
    expect(epw.groundTemperatures[0]?.monthly).toHaveLength(12);
    expect(epw.holidays.leapYearObserved).toBe(false);
    expect(epw.dataPeriod.recordsPerHour).toBe(1);
    expect(epw.comments[0]).toContain('Constructed for the reader test suite');
  });

  it('takes the row count from the declared data period', () => {
    expect(parseEpw(buildEpw()).hours.rowCount).toBe(yearRowCount(false));
    expect(parseEpw(buildEpw({ leapYear: true })).hours.rowCount).toBe(yearRowCount(true));
  });

  it('exposes every numeric field as a named column', () => {
    const hours = parseEpw(buildEpw()).hours;

    expect(hours.dryBulbTemperature).toBeInstanceOf(Float64Array);
    expect(hours.dryBulbTemperature).toHaveLength(yearRowCount(false));
    expect(hours.dryBulbTemperature[0]).toBeCloseTo(2.8);
    expect(hours.dewPointTemperature[0]).toBeCloseTo(-3.3);
    expect(hours.relativeHumidity[0]).toBe(62);
    expect(hours.atmosphericStationPressure[0]).toBe(92453);
    expect(hours.windSpeed[0]).toBeCloseTo(2.6);
    expect(hours.windDirection[0]).toBe(160);
    expect(hours.horizontalInfraredRadiationIntensityFromSky[0]).toBe(256);
    expect(hours.visibility[0]).toBeCloseTo(777.7);
  });

  it('keeps the two text fields as text, and does not coerce the weather codes', () => {
    const hours = parseEpw(buildEpw()).hours;

    expect(typeof hours.sourceAndUncertaintyFlags[0]).toBe('string');
    // Nine single-digit observations side by side, not nine hundred and ninety-nine million.
    expect(hours.presentWeatherCodes[0]).toBe('999999999');
  });

  it('runs the hour column 1 to 24, with 24 the last hour of its own day', () => {
    const hours = parseEpw(buildEpw()).hours;

    expect(hours.hour[0]).toBe(1);
    expect(hours.hour[23]).toBe(24);
    // Hour 24 belongs to 1 January, not to 2 January.
    expect(hours.day[23]).toBe(1);
    expect(hours.hour[24]).toBe(1);
    expect(hours.day[24]).toBe(2);
  });

  it('reads both line-ending conventions, and a mixture, identically', () => {
    const lf = parseEpw(buildEpw({ lineEnding: '\n' }));
    const crlf = parseEpw(buildEpw({ lineEnding: '\r\n' }));

    expect(crlf.hours.rowCount).toBe(lf.hours.rowCount);
    expect(crlf.location.city).toBe(lf.location.city);
    expect(Array.from(crlf.hours.dryBulbTemperature)).toEqual(
      Array.from(lf.hours.dryBulbTemperature)
    );
    expect(crlf.hours.presentWeatherCodes[0]).toBe(lf.hours.presentWeatherCodes[0]);

    // A file whose lines do not agree with each other, which is what a hand-edited file looks like.
    const mixed = buildEpw({ lineEnding: '\n' })
      .split('\n')
      .map((line, index) => (index % 3 === 0 ? `${line}\r` : line))
      .join('\n');
    const parsed = parseEpw(mixed);
    expect(parsed.hours.rowCount).toBe(lf.hours.rowCount);
    expect(Array.from(parsed.hours.dryBulbTemperature)).toEqual(
      Array.from(lf.hours.dryBulbTemperature)
    );
  });

  it('keeps a station name outside ASCII', () => {
    const epw = parseEpw(buildEpw({ city: 'Montréal-Trudeau' }));
    expect(epw.location.city).toBe('Montréal-Trudeau');
  });

  describe('refuses a file it cannot read, and returns nothing at all', () => {
    it('on a header short of its eight records', () => {
      const truncated = buildEpw().split('\n').slice(0, 5).join('\n');
      expect(() => parseEpw(truncated)).toThrow(/header/i);
    });

    it('on a header record out of order', () => {
      const lines = buildEpw().split('\n');
      [lines[2], lines[3]] = [lines[3] ?? '', lines[2] ?? ''];
      expect(() => parseEpw(lines.join('\n'))).toThrow(/TYPICAL\/EXTREME PERIODS/);
    });

    it('on a row with the wrong field count, naming the row', () => {
      const text = buildEpw({
        row: (index, _month, _day, fields) => (index === 41 ? fields.slice(0, 34) : fields),
      });
      // Line 50 of the file is row 42 of the table: eight header records come first.
      expect(() => parseEpw(text)).toThrow(
        /line 50, which is row 42 .* has 34 fields and the format has 35/
      );
    });

    it('on a numeric field that is not a number, naming the row and the field', () => {
      const text = buildEpw({
        row: (index, _month, _day, fields) => {
          if (index !== 0) return fields;
          const broken = [...fields];
          broken[6] = 'warm';
          return broken;
        },
      });
      expect(() => parseEpw(text)).toThrow(/row 1 .*"warm".*dryBulbTemperature/);
    });

    it('on a file truncated part way through the year', () => {
      const lines = buildEpw().split('\n');
      const truncated = lines.slice(0, 4000).join('\n');
      expect(() => parseEpw(truncated)).toThrow(
        /declares .* which is 8760 records, and the file carries 3992/
      );
    });

    it('on a file longer than its own declaration', () => {
      const lines = buildEpw().trimEnd().split('\n');
      lines.push(lines[lines.length - 1] ?? '');
      expect(() => parseEpw(lines.join('\n'))).toThrow(/8760 records, and the file carries 8761/);
    });
  });
});

describe('monthlyMeans', () => {
  it('returns twelve entries, January first, each carrying its count', () => {
    const epw = parseEpw(buildEpw());
    const means = monthlyMeans(epw, 'dryBulbTemperature');

    expect(means).toHaveLength(12);
    expect(means.map((entry) => entry.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(means[0]?.count).toBe(31 * 24);
    expect(means[1]?.count).toBe(28 * 24);
    expect(means[0]?.mean).toBeCloseTo(2.8);
  });

  it('takes a month extent from the calendar, so leap February holds 696 records', () => {
    const means = monthlyMeans(parseEpw(buildEpw({ leapYear: true })), 'dryBulbTemperature');
    expect(means[1]?.count).toBe(696);
  });

  it('is the mean of the values that exist, not of the hours the month has', () => {
    // Half of January carries a real reading, and the rest is the same value.
    const text = buildEpw({
      row: (index, month, _day, fields) => {
        if (month !== 1) return fields;
        const changed = [...fields];
        changed[6] = index % 2 === 0 ? '10.0' : '20.0';
        return changed;
      },
    });
    const january = monthlyMeans(parseEpw(text), 'dryBulbTemperature')[0];
    expect(january?.mean).toBeCloseTo(15);
    expect(january?.count).toBe(31 * 24);
  });
});

describe('loadEpw', () => {
  it('reads a path, decoding as the weather formats are written rather than as UTF-8', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'idfkit-epw-'));
    try {
      const path = join(directory, 'accented.epw');
      // Latin-1 on the way out, which is how `saveWeatherFiles` writes and how the
      // archives arrive. Read as UTF-8 the é is a lone high byte and becomes U+FFFD.
      writeFileSync(path, buildEpw({ city: 'Montréal-Trudeau' }), 'latin1');

      const epw = await loadEpw(path);
      expect(epw.location.city).toBe('Montréal-Trudeau');
      expect(epw.hours.rowCount).toBe(yearRowCount(false));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('a leap year, which no upstream archive publishes', () => {
  // Kept out of the corpus because a file neither EnergyPlus nor the Weather Converter produced has
  // no oracle behind it. This is the month's extent, not a mean's divisor: those are different
  // numbers and fusing them is the defect the sentinel suite guards.

  it('reads 8,784 rows and a February of 696', () => {
    const epw = parseEpw(buildEpw({ leapYear: true }));

    expect(epw.hours.rowCount).toBe(8784);
    expect(epw.holidays.leapYearObserved).toBe(true);

    const february: number[] = [];
    for (let row = 0; row < epw.hours.rowCount; row += 1) {
      if (epw.hours.month[row] === 2) february.push(row);
    }
    expect(february).toHaveLength(696);
    expect(Math.max(...february.map((row) => epw.hours.day[row]!))).toBe(29);
  });

  it('holds 672 in a common year', () => {
    const epw = parseEpw(buildEpw());
    expect(epw.hours.rowCount).toBe(8760);
    let february = 0;
    for (let row = 0; row < epw.hours.rowCount; row += 1)
      if (epw.hours.month[row] === 2) february += 1;
    expect(february).toBe(672);
  });

  it('refuses a leap-year file whose header declares a common-year extent', () => {
    // The declaration and the file have to agree, and a leap file whose header says otherwise is
    // exactly the disagreement FR-004 refuses to paper over.
    const text = buildEpw({ leapYear: true }).replace(
      'HOLIDAYS/DAYLIGHT SAVINGS,Yes',
      'HOLIDAYS/DAYLIGHT SAVINGS,No'
    );
    expect(() => parseEpw(text)).toThrow(/which is 8760 records, and the file carries 8784/);
  });
});
