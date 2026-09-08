/**
 * Read an EPW weather file: the eight header records, and the hourly table as
 * columns.
 *
 * The text is what {@link fetchWeatherFiles} already hands back, so this is the
 * step between retrieving a station's weather and computing anything from it.
 * Nothing here touches the network, the filesystem, the clock or any global,
 * and nothing here is asynchronous.
 *
 * THE HOUR CONVENTION, STATED ONCE.
 *
 * The `hour` column runs 1 to 24, and hour 24 is the last hour of its OWN day
 * rather than hour 0 of the next. A chart that treats 24 as midnight of the
 * following day is off by one for every day of the year, and discovers it late.
 * This is the format's convention, not a choice made here.
 *
 * THE SHAPE OF A COLUMN.
 *
 * Every numeric field is one packed `Float64Array` and absence is `NaN`. Both
 * halves of that are load-bearing and are settled in the feature's contract
 * rather than here:
 *
 * - **Packed**, because thirty-five columns of 8,760 doubles is 2.45 MB, which
 *   is the arithmetic width of packed doubles and is reachable no other way. An
 *   array of nullable numbers cannot stay packed once a null appears and costs
 *   three to four times as much, which a browser holding an open weather file
 *   pays for.
 * - **Doubles rather than floats, and this is forced.** The two libraries must
 *   return the same values within a relative tolerance of 1e-12, and single
 *   precision carries about 1e-7. Halving the width is the first optimisation
 *   anyone looking at 2.45 MB will reach for; every test in this repository
 *   would still pass and the thing it breaks is agreement with Python, which
 *   only the shared corpus can see. It is a correctness constraint wearing the
 *   costume of a performance trade.
 * - **`NaN` for absence**, because no physical quantity in this format can be
 *   NaN and no EPW can express one, so it is not a value the file could have
 *   carried. It is distinguishable from a real zero, and it propagates loudly
 *   through arithmetic rather than quietly biasing a result.
 *
 * WHAT IS EXPORTED, AND WHY SO LITTLE.
 *
 * Four names are registered for this capability in the naming register:
 * `parseEpw`, `loadEpw`, `WeatherFile` and `monthlyMeans`. The record types
 * below are named for readability and are deliberately NOT exported, because a
 * name an importer can reach is a public name and the gate holds every public
 * name against the register. Reach them through the type that is exported:
 * `WeatherFile['location']`, `WeatherFile['hours']`.
 */

import { MISSING_VALUES } from './epw-sentinels.js';

// ---------------------------------------------------------------------------
// The hourly table's columns
// ---------------------------------------------------------------------------
//
// Positions are how the reader finds a field. No caller counts to one, which is
// what "access is by name" means. The order below IS the file's field order and
// the two text positions sit in it rather than beside it, so a reader of this
// list can check it against the data dictionary line by line.

const COLUMN_NAMES = [
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'sourceAndUncertaintyFlags',
  'dryBulbTemperature',
  'dewPointTemperature',
  'relativeHumidity',
  'atmosphericStationPressure',
  'extraterrestrialHorizontalRadiation',
  'extraterrestrialDirectNormalRadiation',
  'horizontalInfraredRadiationIntensityFromSky',
  'globalHorizontalRadiation',
  'directNormalRadiation',
  'diffuseHorizontalRadiation',
  'globalHorizontalIlluminance',
  'directNormalIlluminance',
  'diffuseHorizontalIlluminance',
  'zenithLuminance',
  'windDirection',
  'windSpeed',
  'totalSkyCover',
  'opaqueSkyCover',
  'visibility',
  'ceilingHeight',
  'presentWeatherObservation',
  'presentWeatherCodes',
  'precipitableWater',
  'aerosolOpticalDepth',
  'snowDepth',
  'daysSinceLastSnowfall',
  'albedo',
  'liquidPrecipitationDepth',
  'liquidPrecipitationQuantity',
] as const;

/** Every column of the hourly table, numeric and text alike. */
type ColumnName = (typeof COLUMN_NAMES)[number];

/**
 * The two text columns.
 *
 * Position 5 is obviously text. Position 27 is not: it holds a nine-digit code
 * such as `999999999`, which is nine single-digit observations written side by
 * side and not the number nine hundred and ninety-nine million. Coercing it
 * yields a column of meaningless integers, so it is text and is never parsed.
 */
const TEXT_COLUMNS = ['sourceAndUncertaintyFlags', 'presentWeatherCodes'] as const;

/** A column holding numbers, which is every column but the two above. */
type NumericColumnName = Exclude<ColumnName, (typeof TEXT_COLUMNS)[number]>;

const TEXT_POSITIONS: ReadonlySet<number> = new Set(
  TEXT_COLUMNS.map((name) => COLUMN_NAMES.indexOf(name))
);

/** How many comma-separated fields an hourly row must have. */
const FIELD_COUNT = COLUMN_NAMES.length;

/**
 * Per position, the values that mean the measurement was not made.
 *
 * Read from the generated table rather than written here, and applied PER FIELD
 * AND PER VALUE rather than as a rule about magnitude. 99 is missing for total
 * sky cover and an ordinary reading for relative humidity; 77777 in ceiling
 * height is an unlimited ceiling and stays a number. A reader that blanked large
 * numbers would blank 55% of the ceiling column in the sampled corpus and report
 * a real sky condition as unmeasured.
 */
const MISSING_AT_POSITION: readonly (readonly number[] | undefined)[] = (() => {
  const byPosition: (readonly number[] | undefined)[] = new Array<readonly number[] | undefined>(
    COLUMN_NAMES.length
  );
  for (const [position, values] of MISSING_VALUES) byPosition[position] = values;
  return byPosition;
})();

// ---------------------------------------------------------------------------
// The header records
// ---------------------------------------------------------------------------

/** Where the station is. The one header record a caller reads routinely. */
interface EpwLocation {
  readonly city: string;
  readonly stateProvinceRegion: string;
  readonly country: string;
  readonly dataSource: string;
  readonly wmoNumber: string;
  /** Degrees north, negative south. */
  readonly latitude: number;
  /** Degrees east, negative west. */
  readonly longitude: number;
  /** Hours from UTC, negative west. */
  readonly timeZone: number;
  /** Metres above sea level. */
  readonly elevation: number;
}

/** One named period from the `TYPICAL/EXTREME PERIODS` record. */
interface EpwPeriod {
  readonly name: string;
  /** `Typical` or `Extreme`, as the file spells it. */
  readonly kind: string;
  /** `month/day`, as the file spells it. */
  readonly start: string;
  readonly end: string;
}

/** One depth's worth of the `GROUND TEMPERATURES` record. */
interface EpwGroundTemperatures {
  /** Metres below grade. */
  readonly depth: number;
  /** Absent in every file sampled, and optional in the format. */
  readonly soilConductivity: number | null;
  readonly soilDensity: number | null;
  readonly soilSpecificHeat: number | null;
  /** Twelve monthly values, January first. */
  readonly monthly: readonly number[];
}

/** One entry of the `HOLIDAYS/DAYLIGHT SAVINGS` record's named-day list. */
interface EpwSpecialDay {
  readonly name: string;
  readonly kind: string;
  readonly start: string;
  readonly duration: number;
}

/** The `HOLIDAYS/DAYLIGHT SAVINGS` record. */
interface EpwHolidays {
  /**
   * Whether the file's calendar has a 29 February.
   *
   * Read, and used to say which calendar the data period's month/day dates are
   * read against. It is not itself what decides the row count: the declared
   * period is (see {@link EpwDataPeriod}), and a partial period holds what its
   * own extent holds whatever this says.
   */
  readonly leapYearObserved: boolean;
  readonly daylightSavingStart: string;
  readonly daylightSavingEnd: string;
  readonly specialDays: readonly EpwSpecialDay[];
}

/**
 * The `DATA PERIODS` record, which is load-bearing.
 *
 * It declares the interval and the extent, and the row count is taken from it
 * rather than from a constant of 8,760. A file whose rows disagree with its own
 * declaration fails rather than being truncated or padded.
 */
interface EpwDataPeriod {
  /** How many periods the record declares. One in every file sampled. */
  readonly periodCount: number;
  readonly recordsPerHour: number;
  readonly name: string;
  readonly startDayOfWeek: string;
  /** `month/day`, as the file spells it. */
  readonly startDate: string;
  readonly endDate: string;
}

// ---------------------------------------------------------------------------
// The hourly table
// ---------------------------------------------------------------------------

/**
 * The hourly table, as columns rather than rows.
 *
 * One entry per record of the declared period, in file order. Every numeric
 * column is a packed `Float64Array` carrying `NaN` where the file said the
 * measurement was not taken; the two text columns are string arrays.
 */
type HourlyTable = {
  readonly [K in NumericColumnName]: Float64Array;
} & {
  /** How many records the table holds. Equal to every column's length. */
  readonly rowCount: number;
  readonly sourceAndUncertaintyFlags: readonly string[];
  readonly presentWeatherCodes: readonly string[];
  /**
   * How many records of each numeric column are present, meaning not absent.
   *
   * Carried rather than recomputed: a caller that needed it would otherwise
   * rescan the column, and {@link monthlyMeans} needs it anyway.
   */
  readonly presentCount: Readonly<Record<NumericColumnName, number>>;
};

/**
 * One station's typical year, as read from EPW text.
 *
 * Not to be confused with `WeatherFiles`, plural, which is what retrieval hands
 * back: the EPW, DDY and STAT members of one archive. This is what reading ONE
 * of those members produces. The two names are one character apart, which is a
 * hazard worth naming here rather than discovering in review.
 */
export interface WeatherFile {
  readonly location: EpwLocation;
  /**
   * The `DESIGN CONDITIONS` record as it stands, uninterpreted.
   *
   * Retained rather than parsed. A caller who wants design conditions is sent
   * to the DDY member of the same archive, which is written in the model format
   * and which the ordinary parser reads.
   */
  readonly designConditions: string;
  readonly typicalPeriods: readonly EpwPeriod[];
  readonly groundTemperatures: readonly EpwGroundTemperatures[];
  readonly holidays: EpwHolidays;
  /** The two `COMMENTS` records, as text. They carry provenance and no structure worth imposing. */
  readonly comments: readonly [string, string];
  readonly dataPeriod: EpwDataPeriod;
  readonly hours: HourlyTable;
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/** The eight header records, in the order the format fixes them. */
const HEADER_KEYWORDS = [
  'LOCATION',
  'DESIGN CONDITIONS',
  'TYPICAL/EXTREME PERIODS',
  'GROUND TEMPERATURES',
  'HOLIDAYS/DAYLIGHT SAVINGS',
  'COMMENTS 1',
  'COMMENTS 2',
  'DATA PERIODS',
] as const;

/** Split a header record on commas. Header records carry no escaped commas outside quotes. */
function fields(line: string): string[] {
  return line.split(',').map((field) => field.trim());
}

/** Everything after the first comma, untrimmed of its own commas. Used for records kept as text. */
function remainder(line: string): string {
  const comma = line.indexOf(',');
  return comma === -1 ? '' : line.slice(comma + 1);
}

/**
 * The grammar of a number in this format, shared with the Python reader verbatim.
 *
 * Neither language's built-in conversion is used on its own, because the two disagree about what
 * text is a number and the disagreement is silent. `Number` accepts `0x10` as sixteen and
 * `Infinity` as infinity; Python's `float` rejects both and accepts `nan`, `inf` and `1_0`. A
 * file carrying `nan` in dry bulb would raise here and read as one absent hour there, and no
 * fixture in the corpus carries one to catch it. Both readers therefore match this grammar first
 * and convert second.
 */
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * The same, for a field that counts rather than measures. `1.5` records per hour is a corrupt
 * declaration, not a rounding problem, and this reader refuses what it cannot represent.
 */
const INTEGER = /^[+-]?\d+$/;

/** The number `raw` spells, or `null` when it spells none. */
function toNumber(raw: string): number | null {
  const text = raw.trim();
  return NUMBER.test(text) ? Number(text) : null;
}

/** The whole number `raw` spells, or `null` when it spells none. */
function toInteger(raw: string): number | null {
  const text = raw.trim();
  return INTEGER.test(text) ? Number(text) : null;
}

function numberAt(parts: readonly string[], index: number, what: string): number {
  const raw = parts[index];
  if (raw === undefined || raw === '') {
    throw new Error(`EPW header: ${what} is missing from the ${parts[0] ?? 'header'} record`);
  }
  const value = toNumber(raw);
  if (value === null) {
    throw new Error(`EPW header: ${what} is "${raw}", which is not a number`);
  }
  return value;
}

function integerAt(parts: readonly string[], index: number, what: string): number {
  const raw = parts[index];
  if (raw === undefined || raw === '') {
    throw new Error(`EPW header: ${what} is missing from the ${parts[0] ?? 'header'} record`);
  }
  const value = toInteger(raw);
  if (value === null) {
    throw new Error(`EPW header: ${what} is "${raw}", which is not a whole number`);
  }
  return value;
}

function optionalNumberAt(parts: readonly string[], index: number): number | null {
  const raw = parts[index];
  if (raw === undefined || raw === '') return null;
  return toNumber(raw);
}

function parseLocation(line: string): EpwLocation {
  const parts = fields(line);
  if (parts.length < 10) {
    throw new Error(`EPW header: the LOCATION record has ${parts.length - 1} fields, expected 9`);
  }
  return {
    city: parts[1] ?? '',
    stateProvinceRegion: parts[2] ?? '',
    country: parts[3] ?? '',
    dataSource: parts[4] ?? '',
    wmoNumber: parts[5] ?? '',
    latitude: numberAt(parts, 6, 'latitude'),
    longitude: numberAt(parts, 7, 'longitude'),
    timeZone: numberAt(parts, 8, 'time zone'),
    elevation: numberAt(parts, 9, 'elevation'),
  };
}

function parseTypicalPeriods(line: string): EpwPeriod[] {
  const parts = fields(line);
  // Truncated, as the Python reader's int() truncates: a fractional count would otherwise run
  // this loop one more time here than there.
  const declared = Math.trunc(optionalNumberAt(parts, 1) ?? 0);
  const periods: EpwPeriod[] = [];
  for (let i = 0; i < declared; i += 1) {
    const at = 2 + i * 4;
    if (parts.length < at + 4) {
      throw new Error(
        `EPW header: TYPICAL/EXTREME PERIODS declares ${declared} periods and carries ${i}`
      );
    }
    periods.push({
      name: parts[at] ?? '',
      kind: parts[at + 1] ?? '',
      start: parts[at + 2] ?? '',
      end: parts[at + 3] ?? '',
    });
  }
  return periods;
}

function parseGroundTemperatures(line: string): EpwGroundTemperatures[] {
  const parts = fields(line);
  const declared = Math.trunc(optionalNumberAt(parts, 1) ?? 0);
  const sets: EpwGroundTemperatures[] = [];
  let at = 2;
  for (let i = 0; i < declared; i += 1) {
    if (parts.length < at + 16) {
      throw new Error(`EPW header: GROUND TEMPERATURES declares ${declared} sets and carries ${i}`);
    }
    const monthly: number[] = [];
    for (let month = 0; month < 12; month += 1) {
      monthly.push(numberAt(parts, at + 4 + month, `ground temperature month ${month + 1}`));
    }
    sets.push({
      depth: numberAt(parts, at, 'ground temperature depth'),
      soilConductivity: optionalNumberAt(parts, at + 1),
      soilDensity: optionalNumberAt(parts, at + 2),
      soilSpecificHeat: optionalNumberAt(parts, at + 3),
      monthly,
    });
    at += 16;
  }
  return sets;
}

function parseHolidays(line: string): EpwHolidays {
  const parts = fields(line);
  const declared = Math.trunc(optionalNumberAt(parts, 4) ?? 0);
  const specialDays: EpwSpecialDay[] = [];
  for (let i = 0; i < declared; i += 1) {
    const at = 5 + i * 4;
    if (parts.length < at + 4) break;
    specialDays.push({
      name: parts[at] ?? '',
      kind: parts[at + 1] ?? '',
      start: parts[at + 2] ?? '',
      duration: Math.trunc(optionalNumberAt(parts, at + 3) ?? 0),
    });
  }
  return {
    leapYearObserved: (parts[1] ?? '').toLowerCase().startsWith('y'),
    daylightSavingStart: parts[2] ?? '0',
    daylightSavingEnd: parts[3] ?? '0',
    specialDays,
  };
}

function parseDataPeriod(line: string): EpwDataPeriod {
  const parts = fields(line);
  if (parts.length < 7) {
    throw new Error(
      `EPW header: the DATA PERIODS record has ${parts.length - 1} fields, expected at least 6`
    );
  }
  const periodCount = integerAt(parts, 1, 'the number of data periods');
  if (periodCount !== 1) {
    throw new Error(
      `EPW header: DATA PERIODS declares ${periodCount} periods. This reader reads a single-period file, ` +
        `and refuses what it cannot represent rather than guessing`
    );
  }
  return {
    periodCount,
    recordsPerHour: integerAt(parts, 2, 'records per hour'),
    name: parts[3] ?? '',
    startDayOfWeek: parts[4] ?? '',
    startDate: parts[5] ?? '',
    endDate: parts[6] ?? '',
  };
}

// ---------------------------------------------------------------------------
// How many records the declaration asks for
// ---------------------------------------------------------------------------

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** `1/ 1`, ` 1/1`, `1/1/2016`. The year, where one is written, is ignored: the calendar comes from the leap flag. */
function parseMonthDay(text: string, what: string): { month: number; day: number } {
  const parts = text.split('/').map((part) => part.trim());
  const month = parts[0] === undefined ? null : toInteger(parts[0]);
  const day = parts[1] === undefined ? null : toInteger(parts[1]);
  if (month === null || day === null || month < 1 || month > 12 || day < 1) {
    throw new Error(
      `EPW header: the data period's ${what} is "${text}", which is not a month/day date`
    );
  }
  return { month, day };
}

/** Day of the year, 1-based, on the calendar the leap flag selects. */
function dayOfYear(month: number, day: number, leap: boolean): number {
  let total = day;
  for (let m = 1; m < month; m += 1) {
    total += (DAYS_IN_MONTH[m - 1] ?? 0) + (leap && m === 2 ? 1 : 0);
  }
  return total;
}

/**
 * How many records the declared period asks for.
 *
 * FR-004: taken from the declaration, never from a constant. The leap flag says
 * which calendar the declared month/day dates are read against, which is how a
 * leap-year file declaring 1/1 to 12/31 asks for 8,784 records rather than
 * 8,760. That is the period's own extent, not a flag overriding it.
 */
function declaredRowCount(period: EpwDataPeriod, leapYearObserved: boolean): number {
  const start = parseMonthDay(period.startDate, 'start date');
  const end = parseMonthDay(period.endDate, 'end date');
  const first = dayOfYear(start.month, start.day, leapYearObserved);
  const last = dayOfYear(end.month, end.day, leapYearObserved);
  const yearLength = leapYearObserved ? 366 : 365;
  // A period may wrap the end of the year, which the format permits.
  const days = last >= first ? last - first + 1 : yearLength - first + 1 + last;
  if (period.recordsPerHour < 1) {
    throw new Error(
      `EPW header: the data period declares ${period.recordsPerHour} records per hour, which is not a count`
    );
  }
  return days * 24 * period.recordsPerHour;
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/** Both line-ending conventions, and a mixture of them, with identical results. */
const LINE_BREAK = /\r\n|\n|\r/;

/**
 * Read an EPW weather file from text.
 *
 * The primary form, and the one the common case needs: retrieval hands the
 * caller text, and no filesystem is involved. Synchronous, pure, and usable in
 * a browser, a worker or an edge runtime.
 *
 * @param text - The file's decoded text. Decode it as the weather formats are
 *   written, which is Latin-1 and not UTF-8; {@link fetchWeatherFiles} already
 *   does, and so does {@link loadEpw} in `@idfkit/weather/node`.
 * @returns The header records and the hourly table as columns.
 * @throws If the header is short of its eight records, if a row has the wrong
 *   field count, or if the file disagrees with its own declared data period.
 *   Nothing partial is ever returned: a short or partly populated table is the
 *   failure this refuses to hand back.
 *
 * @example
 * ```ts
 * const files = await fetchWeatherFiles(station);
 * const epw = parseEpw(files.epw);
 * epw.hours.dryBulbTemperature[0]; // the first hour's dry bulb, in C
 * ```
 */
export function parseEpw(text: string): WeatherFile {
  const lines = text.split(LINE_BREAK);
  // A final newline is a line terminator, not an empty record.
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();

  if (lines.length < HEADER_KEYWORDS.length) {
    throw new Error(
      `EPW: the file has ${lines.length} lines, which is short of the ${HEADER_KEYWORDS.length} header records`
    );
  }

  const header: string[] = [];
  for (let i = 0; i < HEADER_KEYWORDS.length; i += 1) {
    const line = lines[i] ?? '';
    const keyword = HEADER_KEYWORDS[i] ?? '';
    if (!line.toUpperCase().startsWith(keyword)) {
      throw new Error(
        `EPW: line ${i + 1} should be the ${keyword} record and starts "${line.slice(0, 32)}"`
      );
    }
    header.push(line);
  }

  const holidays = parseHolidays(header[4] ?? '');
  const dataPeriod = parseDataPeriod(header[7] ?? '');
  const expected = declaredRowCount(dataPeriod, holidays.leapYearObserved);
  const present = lines.length - HEADER_KEYWORDS.length;
  if (present !== expected) {
    throw new Error(
      `EPW: the data period declares ${dataPeriod.startDate} to ${dataPeriod.endDate} at ` +
        `${dataPeriod.recordsPerHour} record(s) per hour, which is ${expected} records, and the file carries ${present}`
    );
  }

  return {
    location: parseLocation(header[0] ?? ''),
    designConditions: remainder(header[1] ?? ''),
    typicalPeriods: parseTypicalPeriods(header[2] ?? ''),
    groundTemperatures: parseGroundTemperatures(header[3] ?? ''),
    holidays,
    comments: [remainder(header[5] ?? ''), remainder(header[6] ?? '')],
    dataPeriod,
    hours: readTable(lines, HEADER_KEYWORDS.length, expected),
  };
}

/** Fill one packed column per numeric field, and one string array per text field. */
function readTable(lines: readonly string[], offset: number, rowCount: number): HourlyTable {
  const numeric = new Map<NumericColumnName, Float64Array>();
  for (const name of COLUMN_NAMES) {
    if (!isTextColumn(name)) numeric.set(name, new Float64Array(rowCount));
  }
  const sourceAndUncertaintyFlags: string[] = new Array<string>(rowCount);
  const presentWeatherCodes: string[] = new Array<string>(rowCount);

  // Positions come from TEXT_POSITIONS rather than being written out again, so the file order and
  // the two text columns stay one fact. Writing 5 and 27 here as well would let a reordered
  // COLUMN_NAMES put a string array where a Float64Array belongs.
  const textColumns: Record<string, string[]> = {
    sourceAndUncertaintyFlags,
    presentWeatherCodes,
  };
  const columns: (Float64Array | string[])[] = COLUMN_NAMES.map((name, position) =>
    TEXT_POSITIONS.has(position) ? textColumns[name]! : numeric.get(name as NumericColumnName)!
  );

  for (let row = 0; row < rowCount; row += 1) {
    const line = lines[offset + row] ?? '';
    const parts = line.split(',');
    if (parts.length !== FIELD_COUNT) {
      throw new Error(
        `EPW: line ${offset + row + 1}, which is row ${row + 1} of the hourly table, has ` +
          `${parts.length} fields and the format has ${FIELD_COUNT}`
      );
    }
    for (let position = 0; position < FIELD_COUNT; position += 1) {
      const raw = parts[position] ?? '';
      const column = columns[position]!;
      if (TEXT_POSITIONS.has(position)) {
        (column as string[])[row] = raw;
        continue;
      }
      const value = toNumber(raw);
      if (value === null) {
        throw new Error(
          `EPW: line ${offset + row + 1}, which is row ${row + 1} of the hourly table, holds "${raw}" at ` +
            `field ${position + 1} (${COLUMN_NAMES[position]}), which is not a number`
        );
      }
      // A value the field reserves for "not measured" becomes absent here, and
      // absence is NaN: out of the domain the field can take, distinguishable
      // from a real zero, and loud rather than quiet in later arithmetic.
      const missing = MISSING_AT_POSITION[position];
      (column as Float64Array)[row] =
        missing !== undefined && missing.includes(value) ? NaN : value;
    }
  }

  return finishTable(numeric, sourceAndUncertaintyFlags, presentWeatherCodes, rowCount);
}

function isTextColumn(name: ColumnName): name is (typeof TEXT_COLUMNS)[number] {
  return (TEXT_COLUMNS as readonly string[]).includes(name);
}

function finishTable(
  numeric: ReadonlyMap<NumericColumnName, Float64Array>,
  sourceAndUncertaintyFlags: readonly string[],
  presentWeatherCodes: readonly string[],
  rowCount: number
): HourlyTable {
  const presentCount: Record<string, number> = {};
  const table: Record<string, unknown> = {
    rowCount,
    sourceAndUncertaintyFlags,
    presentWeatherCodes,
    presentCount,
  };
  for (const [name, column] of numeric) {
    table[name] = column;
    let counted = 0;
    for (let i = 0; i < column.length; i += 1) if (!Number.isNaN(column[i]!)) counted += 1;
    presentCount[name] = counted;
  }
  return table as HourlyTable;
}

// ---------------------------------------------------------------------------
// Monthly aggregates
// ---------------------------------------------------------------------------

/** Twelve of these, one per month, for one column. */
interface MonthlyMean {
  /** 1 to 12. */
  readonly month: number;
  /** The mean of the hours that were present, or `NaN` when none was. */
  readonly mean: number;
  /** How many hours went into it. Zero when the whole month is absent. */
  readonly count: number;
}

/**
 * The monthly means of one numeric column, each carrying the count of hours it
 * included.
 *
 * **Absent hours are excluded from the sum AND from the divisor**, so the result
 * is the mean of the values that exist rather than their sum spread over hours
 * that do not. Fusing the two yields a number biased towards zero in proportion
 * to how much is absent, which looks plausible rather than wrong and which no
 * committed fixture can detect.
 *
 * The month's extent and the divisor are different numbers. February in a leap
 * year holds 696 records rather than 672; that decides which records belong to
 * the month, and it is not what the mean divides by.
 *
 * **The count is part of the answer rather than derivable from it.** Without it
 * a caller cannot tell a mean over 744 hours from a mean over three, and both
 * look like numbers.
 *
 * @param file - A weather file, as {@link parseEpw} returned it.
 * @param field - Which numeric column to aggregate, by its name on the hourly table.
 * @returns Twelve entries, January first.
 * @throws If `field` is not a numeric column. The type says so, and the check is still made:
 *   this function is reachable from plain JavaScript through the `idfkit` facade, where a text
 *   column would otherwise be coerced hour by hour and yield twelve plausible-looking numbers
 *   over the nine-digit weather codes rather than an error.
 *
 * @example
 * ```ts
 * const january = monthlyMeans(epw, 'dryBulbTemperature')[0];
 * january.mean;  // NaN when the month held no measurement at all
 * january.count; // and 0 beside it, which says why
 * ```
 */
export function monthlyMeans(file: WeatherFile, field: NumericColumnName): MonthlyMean[] {
  // `presentCount` holds exactly the numeric columns, so this also rejects the two text ones.
  if (!Object.hasOwn(file.hours.presentCount, field)) {
    throw new Error(`${JSON.stringify(field)} is not a numeric column of the hourly table`);
  }
  const values = file.hours[field];
  const months = file.hours.month;
  const sums = new Float64Array(12);
  const counts = new Int32Array(12);

  for (let row = 0; row < file.hours.rowCount; row += 1) {
    const value = values[row]!;
    if (Number.isNaN(value)) continue;
    const month = months[row]!;
    if (!Number.isInteger(month) || month < 1 || month > 12) continue;
    sums[month - 1]! += value;
    counts[month - 1]! += 1;
  }

  const result: MonthlyMean[] = [];
  for (let month = 1; month <= 12; month += 1) {
    const count = counts[month - 1]!;
    // A month with no present hour is absent, not zero, and the count says which.
    result.push({ month, mean: count === 0 ? NaN : sums[month - 1]! / count, count });
  }
  return result;
}
