/** A raw object as it appears in the file, before schema interpretation. */
export interface RawObject {
  /** Type name exactly as written, e.g. `BuildingSurface:Detailed`. */
  typeName: string;
  /** Comma-separated values after the type name, trimmed, comments stripped. */
  values: string[];
  /** 1-based line where the object starts, for diagnostics. */
  line: number;
}

export interface LexDiagnostic {
  message: string;
  line: number;
  /**
   * Machine-readable kind, from the vocabulary both libraries share.
   *
   * Derived from Python's exception hierarchy by dropping the `Error` suffix, so neither language
   * invented it and the mapping stays mechanical. The conformance corpus compares a finding on
   * `(code, line, typeName)` and never on `message`: wording is a presentation choice each library
   * should stay free to improve, and pinning it would turn every improvement into a failure.
   */
  code?: ParseDiagnosticCode;
  /** 1-based column, when the lexer knew one. */
  column?: number;
  /** Path the text came from, when it came from a file rather than a string. */
  filepath?: string;
  /**
   * Object type the problem occurred in, when known.
   *
   * Declared here rather than only on `ParseDiagnostic` because the lexer knows it too: an
   * unterminated object has read its type name before it runs out of input, and a finding that
   * drops it says only that something went wrong somewhere.
   */
  typeName?: string;
}

/**
 * The shared diagnostic vocabulary. The table lives in
 * `idfkit-conformance/runners/compare.md`; a code outside it is a difference, not a near match.
 */
export type ParseDiagnosticCode =
  | 'UnknownObjectType'
  | 'InvalidField'
  | 'Range'
  | 'DuplicateObject'
  | 'ParseError'
  | 'VersionMismatch'
  | 'UnsupportedVersion'
  | 'SchemaNotFound';

export interface LexOptions {
  /** Report a problem instead of throwing. */
  onDiagnostic?: (diagnostic: LexDiagnostic) => void;
}

/**
 * Split IDF text into raw objects.
 *
 * A hand-written character scan rather than a regex. The Python library matches
 * objects with a `(?:[^;!]*(?:![^\n]*\n)?)*?` inner loop; that is a nested
 * quantifier, so it backtracks badly on malformed input and cannot report where
 * the problem was. A scanner is about the same amount of code, is linear in the
 * input, and always knows its line number.
 *
 * The grammar is small:
 *   - `!` starts a comment running to end of line
 *   - `,` separates fields
 *   - `;` terminates an object
 *   - everything else is field text, trimmed
 *
 * There are no string literals and no escape sequences, so a comma cannot occur
 * inside a field value. Real files depend on that.
 */
export function lex(text: string, options: LexOptions = {}): RawObject[] {
  const objects: RawObject[] = [];
  const report = options.onDiagnostic;
  const length = text.length;

  /** Field text pieces, split whenever a comment interrupts a field. */
  let chunks: string[] = [];
  /** Fields of the object being read; index 0 ends up being the type name. */
  let values: string[] = [];

  let index = 0;
  let line = 1;
  let fieldStart = 0;
  let objectLine = 1;
  let objectStarted = false;

  const endField = (end: number): string => {
    chunks.push(text.slice(fieldStart, end));
    const value = chunks.join('').trim();
    chunks = [];
    return value;
  };

  while (index < length) {
    const char = text[index];

    if (char === '!') {
      // Preserve any field text seen before the comment, then resume after the
      // newline. This is what lets `Zone1,  !- Name` work: the comment is not
      // part of the value, but the value is not finished either.
      chunks.push(text.slice(fieldStart, index));
      const newline = text.indexOf('\n', index);
      if (newline === -1) {
        index = length;
        fieldStart = length;
        break;
      }
      index = newline + 1;
      fieldStart = index;
      line += 1;
      if (!objectStarted && chunks.join('').trim() === '') {
        chunks = [];
        objectLine = line;
      }
      continue;
    }

    if (char === ',') {
      values.push(endField(index));
      objectStarted = true;
      index += 1;
      fieldStart = index;
      continue;
    }

    if (char === ';') {
      values.push(endField(index));
      index += 1;
      fieldStart = index;

      const typeName = values.shift() ?? '';
      if (typeName === '') {
        report?.({ message: 'Object with no type name', line: objectLine, code: 'ParseError' });
      } else {
        objects.push({ typeName, values, line: objectLine });
      }
      values = [];
      objectStarted = false;
      objectLine = line;
      continue;
    }

    if (char === '\n') {
      line += 1;
      if (
        !objectStarted &&
        chunks.join('').trim() === '' &&
        text.slice(fieldStart, index).trim() === ''
      ) {
        // Blank line before any object content: keep the start line current.
        chunks = [];
        fieldStart = index + 1;
        objectLine = line;
      }
    }

    index += 1;
  }

  const trailing = (chunks.join('') + text.slice(fieldStart, length)).trim();
  if (trailing !== '' || values.length > 0) {
    report?.({
      message: `Unterminated object near "${trailing.slice(0, 40) || values[0]}" (missing ";")`,
      line: objectLine,
      code: 'ParseError',
      // `values` has not been shifted, because the shift happens on `;` and there was none, so the
      // type name is still at the front. Reporting it is what lets the corpus compare this finding
      // against Python's on `(code, line, typeName)`.
      typeName: values[0],
    });
  }

  return objects;
}
