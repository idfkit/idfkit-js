import { OWNER } from '../internal.js';
import type { IdfObject } from '../object.js';
import { writeObject, type FieldAnnotation, type ObjectWriteOptions } from '../write/idf.js';
import { isUntouched, type PreservedSource } from './source.js';

/**
 * Reproduce the text a document was read from, per object.
 *
 * A walk over the statements the read scanned and the gaps between them. The gaps are
 * unconditional and only the statements are decided: every character is either inside a statement
 * or in a gap, because the layer tiles the text, and nothing in a gap belongs to an object. That
 * is what makes the one-object diff structural rather than careful, and it is why nothing is
 * reordered, no header is added and the version statement is not moved.
 *
 * A statement's region ends at its terminator, and a comment after that semicolon on the SAME LINE
 * is absorbed into the statement rather than left in the gap. See {@link extentEnds}. A comment on
 * the next line, or after a blank one, stays in the gap, which is where the guessing problem about
 * which object a comment belongs to actually starts.
 *
 * @internal
 */
export function writePreserved(
  document: { objects: () => Iterable<IdfObject> },
  source: PreservedSource,
  options: ObjectWriteOptions
): string {
  const text = source.layer.text;
  const statements = source.layer.statements;
  const ends = extentEnds(source);
  const parts: string[] = [];

  // Everything before the first statement, which for a file with none is the whole text: an empty
  // file and a file of comments are both reproduced by this line alone.
  parts.push(text.slice(0, statements[0]?.region.start ?? text.length));

  for (let index = 0; index < statements.length; index += 1) {
    parts.push(statementPart(source, index, text, ends[index]!, options));
    // Unconditional: the gap is emitted whether the statement was copied, reformatted or dropped.
    parts.push(text.slice(ends[index]!, statements[index + 1]?.region.start ?? text.length));
  }

  appendNewObjects(document, source, parts, options);
  return parts.join('');
}

/**
 * An anchor that is `undefined` is a statement the read rejected, an unknown type or a duplicate
 * name. Its characters are reproduced: the read already reported a diagnostic, and the write is
 * not the place to delete text the author wrote.
 */
function statementPart(
  source: PreservedSource,
  index: number,
  text: string,
  end: number,
  options: ObjectWriteOptions
): string {
  const statement = source.layer.statements[index]!;
  const verbatim = text.slice(statement.region.start, end);
  const anchored = source.anchors[index];
  if (anchored === undefined) return verbatim;
  // Removal is answered from ownership: `remove` already clears the owner, and recording it on
  // the object would mean holding a reference to something the document has let go.
  if (anchored[OWNER] === undefined) return '';
  if (isUntouched(anchored, source)) return verbatim;
  return renderStatement(source, index, options);
}

/**
 * One statement's object, rendered the way this walk renders it.
 *
 * Factored out rather than inlined because `IdfDocument.renderObject` has to produce exactly this
 * text: a consumer splicing something else into the range `regionOf` returns gets a file that
 * differs from `writeIdf`, silently. Two copies of this would be two answers to one question.
 *
 * Without a trailing newline. A statement's extent ends at its terminator, or at the comment on
 * that same line, and in neither case does it include the line break: the break is the first
 * character of the gap. `writeObject` ends with one because it is also used to write whole
 * documents, so emitting it here would put the break in twice and grow the file by a blank line
 * per reformatted object. Every object in a file, edited and saved twice, would grow it twice.
 *
 * @internal
 */
export function renderStatement(
  source: PreservedSource,
  index: number,
  options: ObjectWriteOptions
): string {
  // Re-render the VALUES, and keep the author's comments. An edit asks for the first and never for
  // the second, and rebuilding a comment destroys whatever the schema cannot regenerate: a note to
  // a colleague, and the field's unit, which the ordinary label does not carry.
  const written = writeObject(source.anchors[index]!, {
    ...options,
    annotations: annotations(source, index),
  });
  return written.endsWith('\n') ? written.slice(0, -1) : written;
}

/**
 * Objects no anchor names, formatted and appended after everything the layer holds.
 *
 * The end is the only placement that cannot disturb text the author wrote. The newline guard is
 * the file-with-no-trailing-newline case: appending must not run onto the author's last line.
 */
function appendNewObjects(
  document: { objects: () => Iterable<IdfObject> },
  source: PreservedSource,
  parts: string[],
  options: ObjectWriteOptions
): void {
  const anchored = new Set(source.anchors);
  // The last non-empty part rather than a join of everything so far, which would make appending N
  // objects cost N passes over the whole file.
  let tail = lastNonEmpty(parts);
  for (const obj of document.objects()) {
    if (anchored.has(obj)) continue;
    if (tail !== '' && !tail.endsWith('\n')) parts.push('\n');
    parts.push(writeObject(obj, options));
    parts.push('\n');
    tail = '\n';
  }
}

/** The last part that carries a character, which is what decides whether the output ends in one. */
function lastNonEmpty(parts: readonly string[]): string {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    if (part !== '') return part;
  }
  return '';
}

/**
 * Where each statement's text ends for this walk: its terminator, or the comment on that same line.
 *
 * A comment after the semicolon with nothing but horizontal whitespace between them is the last
 * field's comment. Leaving it in the gap is invisible while the statement is copied, because the
 * gap is copied too, and wrong the moment it is reformatted: the writer emits its own field comment
 * and the author's then arrives from the gap on the line below, so the output carries a line nobody
 * wrote. It is not even a duplicate, because the ordinary writer drops the unit the original
 * usually carries, so it reads as a stray fragment.
 *
 * This is not the writer guessing which comment belongs to which object. "On the same line as the
 * terminator" is a positional fact, and it is the one case where the owner is not in question.
 *
 * Three consequences, decided rather than discovered:
 *
 * - A file written unchanged is byte-identical still. The extent grows and the gap shrinks by
 *   exactly the same characters, so the concatenation does not move.
 * - Removing an object takes that comment with it, where it used to be left on a line of its own
 *   describing a field that no longer exists.
 * - Reformatting replaces it, which is the defect this closes.
 *
 * The tokens are in source order and so are the statements, so one cursor walks both.
 *
 * Exported so that `IdfDocument.regionOf` answers with the SAME extent this walk replaces.
 * Handing a consumer `statement.region` instead would stop one character short of the
 * terminator-line comment, and an edit built on it would leave that comment behind, which is
 * the defect this function exists to close.
 *
 * @internal
 */
export function extentEnds(source: PreservedSource): number[] {
  const { statements, tokens, text } = source.layer;
  const ends = statements.map((statement) => statement.region.end);

  let token = 0;
  for (let index = 0; index < statements.length; index += 1) {
    const end = ends[index]!;
    while (token < tokens.length && tokens.startAt(token) < end) token += 1;
    if (token >= tokens.length || tokens.kindAt(token) !== 'comment') continue;

    // Horizontal whitespace only. A line feed between the two puts the comment on its own line,
    // which makes it a comment about whatever comes next and none of this statement's business.
    const between = text.slice(end, tokens.startAt(token));
    if (between.includes('\n') || between.trim() !== '') continue;
    ends[index] = tokens.endAt(token);
  }
  return ends;
}

/**
 * What the author wrote around each of a statement's fields, positionally.
 *
 * Two kinds, and the second is the one nothing else carries. A field's own comment is the one after
 * its delimiter on the same line, which is the convention every writer of these files follows and
 * the only case where which field a comment belongs to is not a guess. A comment on its OWN line
 * inside the statement belongs to the field below it, and it is lost the moment the object is
 * reformatted unless it is emitted with that field: a comment between two statements is carried by
 * the gap, and one inside a statement is not.
 *
 * Positional against `Statement.fields`, which is positional against the cells `writeObject` emits:
 * the name first for a named type, then the fixed fields in order. An object that gained a field
 * runs past the end of this list, and a field with no entry has no author to be faithful to.
 *
 * A field the author left bare gets an entry with no `trailing`, which is how "written bare" is
 * told apart from "not written by this author at all". Absence is as much a thing the author wrote
 * as the words are.
 */
function annotations(source: PreservedSource, index: number): FieldAnnotation[] {
  const { statements, tokens, text } = source.layer;
  const statement = statements[index]!;
  const fields = statement.fields;
  const built: FieldAnnotation[] = fields.map(() => ({
    before: [],
    trailing: undefined,
    startsLine: true,
  }));

  // One cursor over the tokens, which are in source order, as the fields are. Every comment
  // between the previous field's delimiter and this one's value stands on its own line above it.
  let token = 0;
  let previousEnd = statement.typeName.end;
  for (let at = 0; at < fields.length; at += 1) {
    const field = fields[at]!;
    const before: string[] = [];

    while (token < tokens.length && tokens.startAt(token) < previousEnd) token += 1;
    while (token < tokens.length && tokens.startAt(token) < field.start) {
      if (
        tokens.kindAt(token) === 'comment' &&
        !onSameLine(text, previousEnd, tokens.startAt(token))
      ) {
        before.push(text.slice(tokens.startAt(token), tokens.endAt(token)).trimEnd());
      }
      token += 1;
    }

    // Past the value now: step over the delimiter that closes it and take the comment after it.
    while (token < tokens.length && tokens.startAt(token) < field.end) token += 1;
    while (
      token < tokens.length &&
      (tokens.kindAt(token) === 'separator' || tokens.kindAt(token) === 'terminator')
    ) {
      token += 1;
    }
    let trailing: string | undefined;
    if (
      token < tokens.length &&
      tokens.kindAt(token) === 'comment' &&
      onSameLine(text, field.end, tokens.startAt(token))
    ) {
      trailing = text.slice(tokens.startAt(token), tokens.endAt(token)).trimEnd();
    }

    // Whether the author began a line with this field, which is what keeps a vertex written
    // `0,0,4.572,` on one line rather than three.
    built[at] = { before, trailing, startsLine: !onSameLine(text, previousEnd, field.start) };
    previousEnd = field.end;
  }
  return built;
}

/** Whether two offsets sit on one line, which is what makes a comment a field's rather than its own. */
function onSameLine(text: string, from: number, to: number): boolean {
  return !text.slice(from, to).includes('\n');
}
