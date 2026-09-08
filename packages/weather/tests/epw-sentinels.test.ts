/**
 * A measurement that was not taken does not become a number.
 *
 * WRITTEN BEFORE THE CODE THAT SATISFIES IT, which is not the habit in this
 * repository and is deliberate here. Research found that the obvious fixture
 * set proves the wrong half of this feature: across all thirty-four station
 * archives retrieved while specifying it, the only reserved missing values
 * occurring anywhere are zenith luminance in six rows and a flag field. A check
 * built on those alone passes a reader that ignores reserved values entirely,
 * and albedo and precipitation, the two fields whose absence motivated the
 * requirement, never carry a sentinel in any of them.
 *
 * THE TWO SOURCES OF EVIDENCE, AND WHY BOTH.
 *
 * The corpus holds the real sentinel-bearing file, a TMY3 from the other common
 * producer, and the counts below are that file's. It is not committed here: it
 * belongs to the corpus, where the cross-language claim is made, and copying it
 * would give the same bytes two homes. So the corpus assertions run when a
 * corpus checkout is reachable and are reported as skipped when it is not.
 *
 * The constructed assertions run always. They are what makes this a guard rather
 * than a courtesy: `npm test` on a bare checkout still fails a reader that
 * ignores the table.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { monthlyMeans, parseEpw } from '@idfkit/weather';

import { buildEpw } from './epw-fixtures.js';

// ---------------------------------------------------------------------------
// The corpus fixture, when a checkout is reachable
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

/** The sentinel-bearing fixture, or `null` when no corpus checkout is at hand. */
function corpusSentinelFixture(): string | null {
  const candidates = [
    process.env.IDFKIT_CONFORMANCE_DIR,
    join(REPO, 'conformance'),
    resolve(REPO, '..', 'idfkit-conformance'),
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const path = join(
      candidate,
      'checks',
      'weather-monthly',
      'fixtures',
      'USA_IL_Chicago-OHare.Intl.AP.725300_TMY3.epw.gz'
    );
    if (existsSync(path)) return new TextDecoder('latin1').decode(gunzipSync(readFileSync(path)));
  }
  return null;
}

const CORPUS_TEXT = corpusSentinelFixture();

describe.skipIf(CORPUS_TEXT === null)('the corpus sentinel-bearing fixture', () => {
  const epw = () => parseEpw(CORPUS_TEXT!);

  it('reads the precipitation sentinels as absent, in 8,041 of 8,760 rows', () => {
    const hours = epw().hours;
    expect(hours.rowCount).toBe(8760);
    expect(hours.rowCount - hours.presentCount.liquidPrecipitationDepth).toBe(8041);
    expect(hours.rowCount - hours.presentCount.liquidPrecipitationQuantity).toBe(8041);
  });

  it('reads the albedo sentinel as absent, in 8,040 rows', () => {
    const hours = epw().hours;
    expect(hours.rowCount - hours.presentCount.albedo).toBe(8040);
  });

  it('leaves the 4,244 unlimited-ceiling rows alone, because they are an observation', () => {
    const hours = epw().hours;
    const unlimited = Array.from(hours.ceilingHeight).filter((value) => value === 77777);
    expect(unlimited).toHaveLength(4244);
    // Not one ceiling reading in this file is missing, though more than half of the
    // column carries a reserved value. A rule about magnitude blanks all 4,244.
    expect(hours.presentCount.ceilingHeight).toBe(8760);
  });

  it('reads the present weather observation flag as absent where it says no observation was made', () => {
    const hours = epw().hours;
    // Every row of this file carries 9, which the dictionary defines as "not made".
    expect(hours.presentCount.presentWeatherObservation).toBe(0);
  });

  it('does not blank a column the file measured', () => {
    const hours = epw().hours;
    expect(hours.presentCount.dryBulbTemperature).toBe(8760);
    expect(hours.presentCount.relativeHumidity).toBe(8760);
    expect(hours.presentCount.windSpeed).toBe(8760);
  });
});

// ---------------------------------------------------------------------------
// Constructed, and therefore unconditional
// ---------------------------------------------------------------------------

/** Rewrite one field of every row. */
function withField(position: number, value: string, options: { onlyMonth?: number } = {}): string {
  return buildEpw({
    row: (_index, month, _day, fields) => {
      if (options.onlyMonth !== undefined && month !== options.onlyMonth) return fields;
      const changed = [...fields];
      changed[position] = value;
      return changed;
    },
  });
}

describe('the reserved-value table, per field and per value', () => {
  it('maps a field’s own missing value to absent', () => {
    const hours = parseEpw(withField(32, '999.000')).hours;
    expect(hours.presentCount.albedo).toBe(0);
    expect(Number.isNaN(hours.albedo[0]!)).toBe(true);
  });

  it('leaves a reserved value that is an observation alone', () => {
    // 77777 is an unlimited ceiling, not a missing measurement. This is the case
    // that separates a per-value table from a rule about magnitude.
    const hours = parseEpw(withField(25, '77777')).hours;
    expect(hours.presentCount.ceilingHeight).toBe(hours.rowCount);
    expect(hours.ceilingHeight[0]).toBe(77777);

    // 88888 is a cirroform ceiling. It appears in none of the thirty-five sampled
    // files, is in the table anyway because the table is read from the document
    // rather than derived from the evidence, and is asserted here for that reason.
    const cirroform = parseEpw(withField(25, '88888')).hours;
    expect(cirroform.presentCount.ceilingHeight).toBe(cirroform.rowCount);
    expect(cirroform.ceilingHeight[0]).toBe(88888);

    // 99999 in the same field is missing.
    const unmeasured = parseEpw(withField(25, '99999')).hours;
    expect(unmeasured.presentCount.ceilingHeight).toBe(0);
  });

  it('reads a missing value only in the field that reserves it', () => {
    // 99 is missing for total sky cover and an ordinary reading for relative humidity.
    const hours = parseEpw(withField(8, '99')).hours;
    expect(hours.presentCount.relativeHumidity).toBe(hours.rowCount);
    expect(hours.relativeHumidity[0]).toBe(99);

    const skyCover = parseEpw(withField(22, '99')).hours;
    expect(skyCover.presentCount.totalSkyCover).toBe(0);
  });

  it('keeps a real zero, which is a measurement and not an absence', () => {
    const hours = parseEpw(withField(13, '0')).hours;
    expect(hours.presentCount.globalHorizontalRadiation).toBe(hours.rowCount);
    expect(hours.globalHorizontalRadiation[0]).toBe(0);
    expect(Number.isNaN(hours.globalHorizontalRadiation[0]!)).toBe(false);
  });

  it('distinguishes an absence from a failure', () => {
    // A reserved value is a well-formed file saying a measurement was not taken.
    expect(() => parseEpw(withField(32, '999.000'))).not.toThrow();
    // A field that is not a number at all is not a file saying anything.
    expect(() => parseEpw(withField(32, ''))).toThrow(/not a number/);
  });

  it('reads the observation flag both ways, since one of its two values means missing', () => {
    expect(parseEpw(withField(26, '0')).hours.presentCount.presentWeatherObservation).toBe(8760);
    expect(parseEpw(withField(26, '9')).hours.presentCount.presentWeatherObservation).toBe(0);
  });
});

describe('monthly means over a column that is partly absent', () => {
  it('returns absent, not zero, for a month with no present hour', () => {
    const means = monthlyMeans(parseEpw(withField(32, '999.000', { onlyMonth: 1 })), 'albedo');

    expect(Number.isNaN(means[0]!.mean)).toBe(true);
    expect(means[0]!.count).toBe(0);
    // February measured its albedo, so it is a number.
    expect(means[1]!.count).toBe(28 * 24);
    expect(means[1]!.mean).toBeCloseTo(0.195);
  });

  it('is distinguishable from a month whose mean is genuinely zero', () => {
    const zeroed = buildEpw({
      row: (_index, month, _day, fields) => {
        const changed = [...fields];
        changed[32] = month === 1 ? '0.000' : '999.000';
        return changed;
      },
    });
    const means = monthlyMeans(parseEpw(zeroed), 'albedo');

    expect(means[0]!.mean).toBe(0);
    expect(means[0]!.count).toBe(31 * 24);
    expect(Number.isNaN(means[1]!.mean)).toBe(true);
    expect(means[1]!.count).toBe(0);
  });

  it('divides by the hours that are present, not by the hours the month has', () => {
    // Three hours of every January day measured, and twenty-one absent. The mean of
    // what exists is 10; the sum spread over the month's own extent is 1.25.
    //
    // WHY THIS IS CONSTRUCTED AND NOT COMMITTED. In every sampled file, from both
    // producers, a field is either absent for a whole month or absent in exactly one
    // hour of it. A one-hour difference is about 0.14%, which falls inside the
    // summary's own rounding, so the corpus oracle cannot separate the two divisors
    // and this requirement has to carry its own guard.
    const text = buildEpw({
      row: (_index, month, _day, fields) => {
        if (month !== 1) return fields;
        const changed = [...fields];
        const hour = Number(fields[3]);
        changed[32] = hour <= 3 ? '0.010' : '999.000';
        return changed;
      },
    });
    const january = monthlyMeans(parseEpw(text), 'albedo')[0]!;

    expect(january.count).toBe(31 * 3);
    expect(january.mean).toBeCloseTo(0.01, 10);
    // The divisor bug produces this instead, and it looks like a number rather than an error.
    expect(january.mean).not.toBeCloseTo((0.01 * 31 * 3) / (31 * 24), 10);
  });
});
