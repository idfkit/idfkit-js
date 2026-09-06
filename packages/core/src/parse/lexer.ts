import { scan, type ScanHandler } from './scan.js';

/** A raw object as it appears in the file, before schema interpretation. */
export interface RawObject {
  /** Type name exactly as written, e.g. `BuildingSurface:Detailed`. */
  typeName: string;
  /** Comma-separated values after the type name, trimmed, comments stripped. */
  values: string[];
  /** 1-based line where the object starts, for diagnostics. */
  line: number;
  /** 1-based column where the object starts, for diagnostics. */
  column?: number;
  /**
   * Absolute offset of the object's first character in the source text.
   *
   * One number per object, so that a finding about a FIELD can be positioned without the lexer
   * recording a line for every field of every object. The rescan that uses it runs only when a
   * finding is being built.
   */
  offset?: number;
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
 * The character rules are not here: they live in `scan.ts`, which the syntax layer reads through
 * as well. Two copies of "step over a comment between a separator and its value" that differ by
 * one character put a finding on the wrong field, so there is one copy (research R3).
 *
 * This function is what remains once those rules are elsewhere: assembling values from the text
 * runs the scan reports, and turning a statement into a `RawObject` or into a diagnostic. It asks
 * for no comment and no region, so it pays for neither, and it builds no syntax layer.
 */
export function lex(text: string, options: LexOptions = {}): RawObject[] {
  const collector = objectCollector(text, options);
  scan(text, collector.handler);
  return collector.objects;
}

/**
 * The lexer's own scan handler, and the objects it fills, separately.
 *
 * Split out for the same reason the layer's is: a caller that wants the raw objects AND the syntax
 * layer from one pass composes the two handlers rather than scanning twice. The preserving read is
 * that caller.
 *
 * `objects` is the live array the handler pushes into, so a caller reads it after its own scan
 * returns. The handler is exactly what {@link lex} passes, unchanged, so nothing here decides
 * anything the single-pass version did not.
 *
 * @internal
 */
export function objectCollector(
  text: string,
  options: LexOptions = {}
): { handler: ScanHandler; objects: RawObject[] } {
  const objects: RawObject[] = [];
  const report = options.onDiagnostic;

  /** Field text pieces, one per run the scan reports, joined when the field closes. */
  let chunks: string[] = [];
  /** Fields of the object being read; index 0 ends up being the type name. */
  let values: string[] = [];

  /**
   * Where the current statement starts.
   *
   * The first NON-BLANK character, not the start of the field text: Python's regex matches the
   * type name itself, so an object indented three spaces reports column 4 there and has to report
   * column 4 here too, or the corpus compares two different notions of position.
   */
  let objectLine = 1;
  let objectColumn = 0;
  let objectOffset = -1;

  const handler: ScanHandler = {
    statementStart(offset, line, column) {
      objectLine = line;
      objectColumn = column;
      objectOffset = offset;
    },

    fieldText(start, end) {
      chunks.push(text.slice(start, end));
    },

    fieldEnd() {
      values.push(chunks.join('').trim());
      chunks = [];
    },

    statementEnd(_end, unterminated) {
      if (unterminated) {
        // The scan closes the field the input ran out inside, so the trailing text arrived as the
        // last value rather than as a leftover. Popping it leaves `values` holding exactly what a
        // terminated statement would have held, which is what the message reads from.
        const trailing = values.pop() ?? '';
        if (trailing !== '' || values.length > 0) {
          report?.({
            message: `Unterminated object near "${trailing.slice(0, 40) || values[0]}" (missing ";")`,
            line: objectLine,
            code: 'ParseError',
            column: objectColumn || undefined,
            // `values` has not been shifted, because the shift happens on `;` and there was none,
            // so the type name is still at the front. Reporting it is what lets the corpus compare
            // this finding against Python's on `(code, line, typeName)`.
            typeName: values[0],
          });
        }
        values = [];
        return;
      }

      const typeName = values.shift() ?? '';
      if (typeName === '') {
        report?.({
          message: 'Object with no type name',
          line: objectLine,
          column: objectColumn || undefined,
          code: 'ParseError',
        });
      } else {
        objects.push({
          typeName,
          values,
          line: objectLine,
          column: objectColumn || undefined,
          offset: objectOffset >= 0 ? objectOffset : undefined,
        });
      }
      values = [];
    },
  };

  return { handler, objects };
}
