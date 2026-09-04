/**
 * The IDF character rules, in one place.
 *
 * The grammar is small:
 *   - `!` starts a comment running to the end of its line
 *   - `,` separates fields
 *   - `;` terminates a statement
 *   - everything else is field text
 *
 * There are no string literals and no escape sequences, so a comma cannot occur inside a field
 * value and an `!` always starts a comment. Real files depend on both.
 *
 * A hand-written character walk rather than a regex. The Python library matches objects with a
 * `(?:[^;!]*(?:![^\n]*\n)?)*?` inner loop; that is a nested quantifier, so it backtracks badly on
 * malformed input and cannot report where the problem was. A scan is about the same amount of
 * code, is linear in the input, and always knows its line number.
 *
 * **Why this file exists at all.** Every position this library reports depends on the syntax layer
 * and the model-building read agreeing about where a field begins and ends. Two implementations of
 * "step over a comment between a separator and its value" that differ by one character put a
 * finding on the wrong field, and that class of bug stays invisible until a file puts a comment
 * somewhere unusual. The rules used to exist twice, once inside `lex` and once inside the
 * `fieldLine` helper of `idf.ts`; both are now callers of this scan (research R3).
 *
 * **This module is internal and stays internal.** It is not exported from the package root. The
 * syntax layer, which is public, is what a consumer outside the package reaches for; keeping the
 * scan itself unexported is the reason the layer ships in core rather than beside the language
 * service, because a package boundary drawn around both halves would have forced this file into a
 * published export purely so the other half could reach it.
 *
 * @internal
 */

const EXCLAMATION = 0x21;
const COMMA = 0x2c;
const SEMICOLON = 0x3b;
const LINE_FEED = 0x0a;

/**
 * What a caller wants told to it, and therefore what the scan pays for.
 *
 * The parameterisation is the handler itself: an absent member costs one `undefined` check and
 * nothing else, so a caller that never asks for comments never pays to locate their ends, and a
 * caller that never asks for field regions never pays to bound them. This is what keeps `lex` at
 * its present cost while the syntax layer reads the same characters through the same rules.
 *
 * Whitespace is never reported. It is the complement of everything below and is derived by
 * subtraction rather than stored, which is the same decision the layer makes about trivia
 * (research R5).
 *
 * Every member may return `false` to stop the scan where it stands. Nothing is emitted afterwards.
 * A caller that wants one field out of a statement uses this rather than reading to end of input.
 *
 * @internal
 */
export interface ScanHandler {
  /**
   * The first non-blank character of a statement, which is where the statement starts.
   *
   * A leading comment is not a statement start: `line` and `column` are those of the first
   * character that is neither whitespace nor part of a comment. `column` is 1-based and counted
   * from the start of its own line, which is what the conformance corpus compares, and it is the
   * column of the type name rather than of the indentation before it.
   */
  statementStart?(offset: number, line: number, column: number): boolean | void;

  /**
   * One run of the current field's raw text, exactly as written and untrimmed.
   *
   * A field interrupted by a comment reports one run per side of it, so a caller that wants the
   * value as a string joins the runs and trims the result. Only non-empty runs are reported, which
   * changes no join.
   */
  fieldText?(start: number, end: number): boolean | void;

  /**
   * The current field is complete, closed by a separator, a terminator, or end of input.
   *
   * `index` is 0 for the type name and 1 for the first field after it, so a field at `index`
   * corresponds to `RawObject.values[index - 1]` and to `Statement.fields[index - 1]`, both of
   * which have had the type name shifted off.
   *
   * `start` and `end` bound the value text, trimmed, with any comment excluded. A field written
   * empty between two commas still reports, with `start === end` positioned where its value would
   * have begun, which is what keeps positional indexing sound through a blank extensible slot.
   *
   * `line` is the 1-based line `start` falls on. It is carried here because the scan already knows
   * it and a caller that only wants a line should not have to index the text to recover one.
   *
   * A comment interrupting a field is not part of the field's region: the region covers the value
   * text only, which is what makes an underline land on the value rather than on the annotation
   * beside it. When text appears on both sides of an interrupting comment, which is malformed but
   * representable, the region covers the first run alone rather than spanning the comment, so a
   * region and a comment can never overlap and the layer's tiling invariant holds by construction.
   * `lex` still joins both runs into its value, so the two disagree only on that input.
   */
  fieldEnd?(index: number, start: number, end: number, line: number): boolean | void;

  /** A comma, at `offset`. Reported after the {@link ScanHandler.fieldEnd} it closes. */
  separator?(offset: number): boolean | void;

  /** A semicolon, at `offset`. Reported after the {@link ScanHandler.fieldEnd} it closes. */
  terminator?(offset: number): boolean | void;

  /**
   * A comment, from its exclamation mark through the last character before the line feed.
   *
   * The mark is included and the line feed is not. A carriage return before that feed stays inside
   * the comment, because line endings are counted as written and that is what every editor does.
   */
  comment?(start: number, end: number): boolean | void;

  /**
   * The statement ended. `end` is one past its last character.
   *
   * `unterminated` is true when the input ran out before a semicolon did, in which case the
   * statement runs to end of input and its last field has just been reported. Malformed input is
   * represented rather than stopped at, so the scan reports what was written and moves on.
   */
  statementEnd?(end: number, unterminated: boolean): boolean | void;
}

/**
 * Where to begin, for a caller resuming inside text it has already positioned.
 *
 * `line` and `column` describe `from` itself, so a caller that knows a statement's line and column
 * can scan that statement alone and get line numbers in the whole file's terms rather than in the
 * fragment's.
 *
 * @internal
 */
export interface ScanOptions {
  /** Offset to start at. @defaultValue 0 */
  from?: number;
  /** 1-based line `from` falls on. @defaultValue 1 */
  line?: number;
  /** 1-based column `from` falls on. @defaultValue 1 */
  column?: number;
}

/**
 * Walk IDF text, reporting what the handler asked for.
 *
 * One linear pass, no allocation of its own, and it never throws: text that violates the grammar
 * is reported as what it is rather than stopped at.
 *
 * @internal
 */
export function scan(text: string, handler: ScanHandler, options: ScanOptions = {}): void {
  const length = text.length;

  let index = options.from ?? 0;
  let line = options.line ?? 1;
  /** Offset of the current line's first character, which is what turns an offset into a column. */
  let lineStart = index - ((options.column ?? 1) - 1);

  /** Start of the current field's text run, moved past every comment that interrupts it. */
  let fieldStart = index;
  /** 0 for the type name, 1 for the first field after it. */
  let fieldIndex = 0;
  /** True once the current statement's first non-blank, non-comment character has been seen. */
  let open = false;
  /** First non-blank character of the current field's value, or -1 while it has none. */
  let valueStart = -1;
  /** One past the last non-blank character of the run `valueStart` falls in. */
  let valueEnd = -1;
  /** Line `valueStart` falls on. */
  let valueLine = 1;
  /** True once a comment has ended the run holding `valueStart`. */
  let valueClosed = false;

  /**
   * Report the field the scan is inside, closed at `at`. False when a handler asked to stop.
   *
   * A field with no value text is positioned at `at`, which is the separator, the terminator, or
   * the end of input that closed it. That is the offset a value would have begun at, because
   * everything between the field's start and `at` was whitespace or comment.
   */
  const closeField = (at: number): boolean => {
    if (at > fieldStart && handler.fieldText?.(fieldStart, at) === false) return false;
    const empty = valueStart < 0;
    const stop =
      handler.fieldEnd?.(
        fieldIndex,
        empty ? at : valueStart,
        empty ? at : valueEnd,
        empty ? line : valueLine
      ) === false;
    valueStart = -1;
    valueEnd = -1;
    valueClosed = false;
    return !stop;
  };

  while (index < length) {
    const code = text.charCodeAt(index);

    if (code === EXCLAMATION) {
      // Text seen before the comment still belongs to the field, and so does text after the line
      // feed: the comment interrupts the field without ending it. This is what lets
      // `Zone1,  !- Name` work, where the comment is no part of the value and the value is no part
      // of the comment.
      if (index > fieldStart && handler.fieldText?.(fieldStart, index) === false) return;
      const feed = text.indexOf('\n', index);
      const end = feed === -1 ? length : feed;
      if (handler.comment?.(index, end) === false) return;
      if (valueStart >= 0) valueClosed = true;
      if (feed === -1) {
        fieldStart = length;
        break;
      }
      index = feed + 1;
      fieldStart = index;
      line += 1;
      lineStart = index;
      continue;
    }

    const blank = isSpace(code);

    if (!open && !blank) {
      open = true;
      if (handler.statementStart?.(index, line, index - lineStart + 1) === false) return;
    }

    if (code === COMMA || code === SEMICOLON) {
      if (!closeField(index)) return;
      if (code === COMMA) {
        if (handler.separator?.(index) === false) return;
        fieldIndex += 1;
      } else {
        if (handler.terminator?.(index) === false) return;
        if (handler.statementEnd?.(index + 1, false) === false) return;
        fieldIndex = 0;
        open = false;
      }
      index += 1;
      fieldStart = index;
      continue;
    }

    if (code === LINE_FEED) {
      line += 1;
      lineStart = index + 1;
    } else if (!blank) {
      if (valueStart < 0) {
        valueStart = index;
        valueEnd = index + 1;
        valueLine = line;
      } else if (!valueClosed) {
        valueEnd = index + 1;
      }
    }

    index += 1;
  }

  // Input ran out inside a statement. Its last field is reported like any other, so a caller reads
  // what was written rather than having to reconstruct it from the leftovers.
  if (!open) return;
  if (!closeField(length)) return;
  handler.statementEnd?.(length, true);
}

/**
 * Whether a character is whitespace, by the same definition `String.prototype.trim` uses.
 *
 * A field's value is trimmed, so a scan that disagreed with `trim` about one character would put
 * a region beside the value rather than on it. ASCII is one comparison; the rest of the set costs
 * a branch nothing outside a comment ever takes.
 */
function isSpace(code: number): boolean {
  if (code < 0x80) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}
