/**
 * A span of source text, half-open.
 *
 * `end` is one past the last character, so `text.slice(start, end)` is exactly the text the
 * region selects, an empty region is `start === end`, and two adjacent regions share a number
 * rather than straddling one. An empty region is what a cursor between two characters is.
 *
 * Offsets are indices into the JavaScript string, which are UTF-16 code units. Nothing converts
 * them, because no consumer wants them converted: the Language Server Protocol's default
 * `positionEncoding` is UTF-16, Monaco measures columns in UTF-16 code units, and CodeMirror
 * addresses its document by the same offsets. The Python library counts code points instead,
 * because Python string indices are code points; the two agree for every character below the
 * astral planes and differ for anything above them, which in practice means an emoji in a
 * comment. That divergence is registered rather than papered over.
 */
export interface Region {
  /** Offset of the first character, into the source string. */
  readonly start: number;
  /** Offset one past the last character. */
  readonly end: number;
}

/**
 * A position as a human reads it, derived from an offset rather than stored.
 *
 * Storing line and column on every region would double its size to hold two numbers that are a
 * function of one. Both count from one, which is what the existing findings already report; a
 * consumer whose own convention counts a column from zero subtracts one, and that subtraction is
 * the consumer's, because a service that guessed which convention its caller wanted would be
 * modelling a protocol.
 */
export interface LineColumn {
  /** 1-based, counting from the start of the text. */
  readonly line: number;
  /** 1-based, in UTF-16 code units, from the start of the line. */
  readonly column: number;
}

/**
 * The minimum a position query needs: the text its offsets index into.
 *
 * Declared structurally rather than by importing `SyntaxLayer`, so that positions stay usable
 * without one and this module depends on nothing. A `SyntaxLayer` holds its text and therefore
 * satisfies this, which is what lets `lineColumnAt(layer, offset)` read as the contract writes it.
 */
export interface TextSource {
  /** The text offsets are measured into. */
  readonly text: string;
}

/**
 * Line index per source, built once and reused.
 *
 * Keyed by the source object rather than by its text, because a `SyntaxLayer` is immutable and
 * lives as long as the document does, while keying on the string itself would hold megabytes of
 * text alive for the sake of a few kilobytes of offsets. A caller that passes a fresh object
 * literal each time gets a fresh index each time, which is the documented cost of doing that.
 */
const lineIndexes = new WeakMap<TextSource, Int32Array>();

/**
 * Offsets at which each line begins, one entry per line, ascending.
 *
 * A line break is a line feed, and nothing else. A carriage return before it belongs to the line
 * it ends, so a column at the end of a CRLF line is one greater than the same column in a file
 * using line feeds alone, which is what every editor reports. A lone carriage return is *not* a
 * break: the existing lexer does not treat it as one and Python's `_line_and_column` counts line
 * feeds, and the conformance corpus compares a finding on its line, so a third opinion here would
 * put the two libraries one line apart on a file no gate would explain.
 *
 * @internal
 */
export function lineStartsOf(source: TextSource): Int32Array {
  const cached = lineIndexes.get(source);
  if (cached !== undefined) return cached;
  const starts = buildLineStarts(source.text);
  lineIndexes.set(source, starts);
  return starts;
}

/**
 * The line and column an offset falls on.
 *
 * Binary search over the line index, so a query costs the logarithm of the line count rather than
 * a scan of the text. An offset outside `[0, text.length]` is clamped into range rather than
 * throwing: a cursor arrives from an editor that may be a keystroke ahead of the text this layer
 * was built from, and refusing to answer is worse than answering about the nearest character.
 *
 * The column of a *statement* is the column of its first non-blank character, not of the
 * whitespace indenting it. This function does not enforce that rule, because a statement's region
 * already starts at that character; it is stated here because every column this feature reports
 * obeys it, and because the conformance corpus compares findings on their line and type name and
 * would notice the number moving.
 */
export function lineColumnAt(source: TextSource, offset: number): LineColumn {
  const clamped = clampOffset(offset, source.text.length);
  const starts = lineStartsOf(source);
  const line = lineIndexAt(starts, clamped);
  return { line: line + 1, column: clamped - starts[line]! + 1 };
}

/**
 * The offset a line and column names.
 *
 * The inverse of {@link lineColumnAt} for every position that exists, and clamped for every one
 * that does not: a line past the end resolves on the last line, a column past the end of its line
 * resolves at the line's last position, which is the offset of the break that ends it. Round
 * tripping an out-of-range position therefore returns the clamped position rather than the one
 * asked for, which is the only honest answer available.
 */
export function offsetAt(source: TextSource, position: LineColumn): number {
  const text = source.text;
  const starts = lineStartsOf(source);
  const line = clampOffset(position.line - 1, starts.length - 1);
  const lineStart = starts[line]!;
  // One past the last position on this line is where the next line starts, so the last position on
  // it is one before that: the offset of the line feed, at which a cursor is still on this line.
  const lineEnd = line + 1 < starts.length ? starts[line + 1]! - 1 : text.length;
  const offset = lineStart + clampOffset(position.column - 1, text.length);
  return offset > lineEnd ? lineEnd : offset;
}

/** Two passes so the array is allocated once at its exact size; `indexOf` does the scanning. */
function buildLineStarts(text: string): Int32Array {
  let count = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count += 1;
  const starts = new Int32Array(count);
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    starts[line] = at + 1;
    line += 1;
  }
  return starts;
}

/** Index of the greatest line start that is at or before `offset`. */
function lineIndexAt(starts: Int32Array, offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Into `[0, max]`, whole. `NaN` lands at 0, since no position is nearer than another. */
function clampOffset(value: number, max: number): number {
  if (Number.isNaN(value)) return 0;
  const whole = Math.trunc(value);
  if (whole < 0) return 0;
  return whole > max ? max : whole;
}
