/**
 * Constructed EPW text for the reader's own suite.
 *
 * The corpus carries the real files and is where the numbers are checked
 * against something neither library wrote. What belongs here instead is the
 * shape: files small enough to read, and files deliberately malformed, neither
 * of which any upstream archive publishes.
 *
 * The leap-year builder is the clearest case for constructing rather than
 * committing. Every archive published upstream is 8,760 hourly rows from
 * 1 January to 31 December, so there is no leap-year file to commit and no
 * oracle behind one if there were.
 */

/** How many days each month holds, January first, on a common year. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Options for {@link buildEpw}. */
export interface BuildEpwOptions {
  /** The station name written into the LOCATION record. */
  city?: string;
  /** Whether the file's calendar carries a 29 February. */
  leapYear?: boolean;
  /** Records per hour, as the DATA PERIODS record declares it. */
  recordsPerHour?: number;
  /** `\n` by default; pass `\r\n` for the other convention. */
  lineEnding?: string;
  /**
   * Rewrite one row's fields. Called for every record with its zero-based
   * index, the row's month and day, and the 35 fields as strings.
   */
  row?: (index: number, month: number, day: number, fields: string[]) => string[];
}

/** The eight header records, with `%LEAP%` and `%CITY%` still to fill in. */
const HEADER = [
  'LOCATION,%CITY%,IL,USA,TMYx,725300,41.98,-87.92,-6.0,201.0',
  'DESIGN CONDITIONS,0',
  'TYPICAL/EXTREME PERIODS,1,Summer - Week Nearest Max Temperature For Period,Extreme,7/13,7/19',
  'GROUND TEMPERATURES,1,.5,,,,-1.89,-3.06,-0.99,2.23,10.68,17.20,21.60,22.94,20.66,15.60,8.83,2.56',
  'HOLIDAYS/DAYLIGHT SAVINGS,%LEAP%,0,0,0',
  'COMMENTS 1,Constructed for the reader test suite. Not an upstream file.',
  'COMMENTS 2, -- no provenance to record',
];

/**
 * One plausible hourly row, as thirty-five fields.
 *
 * The values are ordinary readings rather than round numbers, so a column read
 * from the wrong position looks wrong instead of looking empty.
 */
function templateRow(year: number, month: number, day: number, hour: number): string[] {
  return [
    String(year),
    String(month),
    String(day),
    String(hour),
    '0',
    '?9?9?9?9E0?9?9?9?9?9?9?9?9?9?9?9?9?9?9?9?9?9?9',
    '2.80',
    '-3.30',
    '62',
    '92453',
    '0',
    '0',
    '256',
    '0',
    '0',
    '0',
    '0',
    '0',
    '0',
    '0',
    '160',
    '2.60',
    '0',
    '0',
    '777.7',
    '77777',
    '9',
    '999999999',
    '7',
    '0.0850',
    '0',
    '88',
    '0.195',
    '0.0',
    '0.0',
  ];
}

/**
 * Build a whole year of EPW text, 1 January to 31 December.
 *
 * @returns The file's text, header records and all.
 */
export function buildEpw(options: BuildEpwOptions = {}): string {
  const leapYear = options.leapYear ?? false;
  const recordsPerHour = options.recordsPerHour ?? 1;
  const lineEnding = options.lineEnding ?? '\n';
  const year = leapYear ? 2016 : 2015;

  const lines = HEADER.map((line) =>
    line
      .replace('%LEAP%', leapYear ? 'Yes' : 'No')
      .replace('%CITY%', options.city ?? 'Chicago Ohare Intl Ap')
  );
  lines.push(`DATA PERIODS,1,${recordsPerHour},Data,Sunday, 1/ 1,12/31`);

  let index = 0;
  for (let month = 1; month <= 12; month += 1) {
    const days = (DAYS_IN_MONTH[month - 1] ?? 0) + (leapYear && month === 2 ? 1 : 0);
    for (let day = 1; day <= days; day += 1) {
      for (let hour = 1; hour <= 24; hour += 1) {
        for (let sub = 0; sub < recordsPerHour; sub += 1) {
          const fields = templateRow(year, month, day, hour);
          lines.push((options.row ? options.row(index, month, day, fields) : fields).join(','));
          index += 1;
        }
      }
    }
  }

  return lines.join(lineEnding) + lineEnding;
}

/** How many records {@link buildEpw} writes for a whole year. */
export function yearRowCount(leapYear: boolean, recordsPerHour = 1): number {
  return (leapYear ? 366 : 365) * 24 * recordsPerHour;
}
