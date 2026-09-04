import type { Region, Schema, SlimType, Statement } from '@idfkit/core';

/**
 * Which statement an offset falls in, which field, and which part.
 *
 * Everything a cursor answer needs, and nothing a whole file would have to be read to know.
 * `statement` is the one statement the offset sits in, scanned locally; `at` says which part of it
 * the offset is on; `fieldIndex` positions that part; and `typeName` and `fieldName` are what the
 * schema calls them, when a schema was supplied and knows.
 */
export interface CursorContext {
  /** The statement the offset falls in, scanned locally. */
  readonly statement: Statement;
  /** Where in the statement the offset is. */
  readonly at: 'typeName' | 'field' | 'comment' | 'betweenStatements';
  /**
   * Positional index of the field, when `at` is `'field'`.
   *
   * Counted the same way `Statement.fields` is indexed, so it maps onto schema field order
   * directly: index 0 is the first field after the type name, which on a named type is the name.
   */
  readonly fieldIndex: number | undefined;
  /** The canonical type name, when the schema defines it. */
  readonly typeName: string | undefined;
  /** The schema field name, when the type is known and the index is in range. */
  readonly fieldName: string | undefined;
}

/**
 * Where the cursor is, found by scanning outwards from it.
 *
 * **This never builds or consults a `SyntaxLayer`, and it must not start.** Building a layer to
 * answer a cursor is the reparse the whole design exists to avoid: it costs the file, on a
 * keystroke, for an answer that concerns one statement. The committed measurement asks the same
 * question of a large model and of a file a hundredth its size and requires the two to come out
 * within a small factor, which is a check a reparse cannot pass on any machine.
 *
 * The method is a backward scan to the nearest semicolon that is not inside a comment, then a
 * forward scan over that one statement. Both halves are sound only because of what this grammar
 * lacks: IDF has no nesting, no string literals and no escape sequences, so a semicolon terminates
 * a statement unconditionally unless a comment swallowed it, and a comment is an exclamation mark
 * running to the end of its line. Deciding whether a candidate semicolon is real therefore costs
 * the length of its line, and finding the statement costs the distance back to the previous real
 * terminator. Neither number grows with the file. Almost no other grammar would permit this, and
 * a language that gained a string literal would break it silently, so the property is stated here
 * rather than left for a reader to rediscover.
 *
 * The honest bound is the distance back to the previous real terminator rather than the length of
 * the statement. Those are the same number in ordinary files and differ in one real case: a cursor
 * in the first statement of a file that opens with a large comment header scans back through the
 * header. Headers are small, and the case is still linear with a tiny constant.
 *
 * Nothing throws, for any input. An offset outside `[0, text.length]` is clamped into range rather
 * than refused (FR-032): a cursor arrives from an editor that may be a keystroke ahead of the text
 * it was measured against, and answering about the nearest character beats answering nothing.
 *
 * The schema is optional. Without one the context still reports the statement, the part, and the
 * field index, which is what positions a finding about a type no schema defines.
 */
export function contextAt(text: string, offset: number, schema?: Schema): CursorContext {
  const at = clampOffset(offset, text.length);
  const scanned = scanStatement(text, statementScanStart(text, at), at);
  const statement = scanned.statement ?? emptyStatementAt(at);

  const part = partOf(scanned);
  const fieldIndex = part === 'field' ? scanned.slot - 1 : undefined;

  const typeName = schema?.resolve(statement.typeNameText);
  const type = typeName === undefined ? undefined : schema?.get(typeName);
  const fieldName =
    type === undefined || fieldIndex === undefined ? undefined : fieldNameAt(type, fieldIndex);

  return { statement, at: part, fieldIndex, typeName, fieldName };
}

/**
 * The schema field name at a positional index, or `undefined` past the end of the type.
 *
 * Positional order is the schema's own: the fixed fields in `f`, whose index 0 is the name on a
 * named type, and then the extensible group repeating its `fields` for as long as values were
 * written. This mirrors how `parseIdf` maps positional values onto named fields, deliberately and
 * exactly, because a cursor that disagreed with the reader about which field it was in would offer
 * the neighbouring field's values.
 *
 * @internal
 */
export function fieldNameAt(type: SlimType, index: number): string | undefined {
  if (index < 0) return undefined;
  const fixed = type.f;
  if (index < fixed.length) return fixed[index];
  const extensible = type.x;
  const width = extensible?.fields.length ?? 0;
  if (extensible === undefined || width === 0) return undefined;
  return extensible.fields[(index - fixed.length) % width];
}

/** Which part of the statement the scan put the offset on. */
function partOf(scanned: Scanned): CursorContext['at'] {
  // A comment wins over everything, including the field it interrupts: nothing completes and
  // nothing explains inside one, whether it sits between two statements or in the middle of a
  // field's value.
  if (scanned.inComment) return 'comment';
  // No statement had opened by the time the scan passed the offset, so the offset is in the
  // whitespace after a terminator and before whatever comes next, which includes trailing
  // whitespace at end of file. That is the state in which a new statement is beginning.
  if (scanned.statement === undefined) return 'betweenStatements';
  return scanned.slot === 0 ? 'typeName' : 'field';
}

/**
 * The statement a cursor is beginning to write, standing in for one that is not there yet.
 *
 * `CursorContext.statement` is not optional, and making it optional to describe an empty line
 * would push a branch onto every consumer to serve the one state in which there is nothing to
 * describe. An empty statement at the cursor is the truthful alternative: it selects nothing,
 * which is exactly the region an offer inserted here would replace, and it reports
 * `unterminated`, because a statement nobody has written carries no terminator.
 */
function emptyStatementAt(offset: number): Statement {
  const region: Region = { start: offset, end: offset };
  return { region, typeName: region, typeNameText: '', fields: [], unterminated: true };
}

/**
 * Offset to begin the forward scan at: one past the nearest real terminator before `offset`.
 *
 * Backwards through the semicolons with `lastIndexOf`, which is a native scan rather than a
 * character loop, testing each candidate for comment membership and skipping the ones a comment
 * swallowed. A file with no terminator before the offset starts at zero, which is the only other
 * place a statement can begin.
 */
function statementScanStart(text: string, offset: number): number {
  for (let at = offset - 1; at >= 0; at -= 1) {
    const found = text.lastIndexOf(';', at);
    if (found < 0) return 0;
    if (!insideComment(text, found)) return found + 1;
    // Step past the one a comment swallowed and keep looking. `at -= 1` runs next, so a candidate
    // at offset zero leaves the loop rather than finding itself again.
    at = found;
  }
  return 0;
}

/**
 * Whether the character at `index` sits inside a comment.
 *
 * Back to the start of its line, then forward for an exclamation mark before it. There are no
 * string literals and no escapes, so an exclamation mark on the line before this character always
 * opened a comment that is still open here, and one line is all it costs to know.
 */
function insideComment(text: string, index: number): boolean {
  const lineStart = index === 0 ? 0 : text.lastIndexOf('\n', index - 1) + 1;
  return text.lastIndexOf('!', index) >= lineStart;
}

/** What one forward pass over a single statement found. */
interface Scanned {
  /** The statement, or `undefined` when none had opened by the time the scan passed the offset. */
  readonly statement: Statement | undefined;
  /** Whether the offset falls inside a comment, the exclamation mark itself included. */
  readonly inComment: boolean;
  /** Separators seen strictly before the offset: 0 is the type name, 1 the first field after it. */
  readonly slot: number;
}

const EXCLAMATION = 0x21;
const COMMA = 0x2c;
const SEMICOLON = 0x3b;

/**
 * Read one statement forward from `from`, stopping as soon as the offset is placed.
 *
 * A second implementation of the character rules `@idfkit/core`'s internal scan already holds, and
 * that is a deliberate cost rather than an oversight. The scan is internal to core on purpose, so
 * that the syntax layer and the model-building read cannot drift apart; reaching it from here
 * would mean publishing it, which is the hazard that decision exists to prevent. The rules
 * reproduced here are the four that matter, and the field bounds are computed exactly as the layer
 * computes them, so that a region reported by a cursor and a region reported by a finding select
 * the same characters.
 *
 * The pass stops at the statement's terminator, or at end of input, or as soon as it is past the
 * offset with nothing open, which is what keeps the cost the statement's rather than the file's.
 */
function scanStatement(text: string, from: number, offset: number): Scanned {
  const length = text.length;

  /** 0 for the type name, 1 for the first field after it. */
  let fieldIndex = 0;
  /** True once the statement's first non-blank, non-comment character has been seen. */
  let open = false;
  /** Where that character was. */
  let openedAt = 0;
  /** First non-blank character of the current field's value, or -1 while it has none. */
  let valueStart = -1;
  /** One past the last non-blank character of the run `valueStart` falls in. */
  let valueEnd = -1;
  /** True once a comment has ended the run holding `valueStart`. */
  let valueClosed = false;

  let typeName: Region = { start: from, end: from };
  const fields: Region[] = [];
  let inComment = false;
  let slot = 0;
  let statement: Statement | undefined;

  /**
   * Record the field the scan is inside, closed at `at`.
   *
   * A field with no value text gets an empty region at `at`, the separator or terminator or end of
   * input that closed it, because everything before it was whitespace or comment. That is what
   * keeps positional indexing sound through a blank slot in the middle of an extensible group.
   *
   * A field written on both sides of a comment that interrupts it keeps the first run alone, which
   * is what the layer stores, so a value region and a comment region can never overlap.
   */
  const closeField = (at: number): void => {
    const region: Region =
      valueStart < 0 ? { start: at, end: at } : { start: valueStart, end: valueEnd };
    if (fieldIndex === 0) typeName = region;
    else fields.push(region);
    valueStart = -1;
    valueEnd = -1;
    valueClosed = false;
  };

  const finish = (end: number, unterminated: boolean): Statement => ({
    region: { start: openedAt, end },
    typeName,
    typeNameText: text.slice(typeName.start, typeName.end),
    fields,
    unterminated,
  });

  let index = from;
  while (index < length) {
    // Nothing has opened and the offset is behind us, so no statement contains it and none that
    // opens later can. Every comment that could hold the offset began at or before it and has
    // already been tested.
    if (!open && index > offset) break;

    const code = text.charCodeAt(index);

    if (code === EXCLAMATION) {
      const feed = text.indexOf('\n', index);
      const end = feed === -1 ? length : feed;
      // Inclusive at both ends. A cursor on the exclamation mark is in the comment it opens, and a
      // cursor one past its last character is at the end of the comment's text rather than in the
      // whitespace of the next line: typing there extends the comment.
      if (offset >= index && offset <= end) inComment = true;
      // The comment ends the run holding the value but not the field, so `Zone1, !- Name` leaves
      // the value at `Zone1` and text after the line feed still belongs to the same field.
      if (valueStart >= 0) valueClosed = true;
      if (feed === -1) break;
      index = feed + 1;
      continue;
    }

    const blank = isSpace(code);
    if (!open && !blank) {
      open = true;
      openedAt = index;
    }

    if (code === COMMA || code === SEMICOLON) {
      closeField(index);
      if (code === SEMICOLON) {
        statement = finish(index + 1, false);
        break;
      }
      if (index < offset) slot += 1;
      fieldIndex += 1;
      index += 1;
      continue;
    }

    if (!blank) {
      if (valueStart < 0) {
        valueStart = index;
        valueEnd = index + 1;
      } else if (!valueClosed) {
        valueEnd = index + 1;
      }
    }

    index += 1;
  }

  // Input ran out inside a statement. Its last field is closed like any other, so the cursor reads
  // what was written rather than reconstructing it from the leftovers, and the statement says it
  // runs to the end.
  if (statement === undefined && open) {
    closeField(length);
    statement = finish(length, true);
  }

  return { statement, inComment, slot };
}

/**
 * Whether a character is whitespace, by the definition `String.prototype.trim` uses.
 *
 * The same set the core scan tests, character for character. A field's value is trimmed, so a
 * disagreement about one character would put a region beside a value rather than on it, and the
 * cursor and the syntax layer would then report different bounds for the same field.
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

/** Into `[0, max]`, whole. `NaN` lands at 0, since no position is nearer than another. */
function clampOffset(value: number, max: number): number {
  if (Number.isNaN(value)) return 0;
  const whole = Math.trunc(value);
  if (whole < 0) return 0;
  return whole > max ? max : whole;
}
