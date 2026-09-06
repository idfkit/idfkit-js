import { OWNER } from '../internal.js';
import type { IdfObject } from '../object.js';
import { writeObject, type ObjectWriteOptions } from '../write/idf.js';
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
  // Re-render the VALUES, and keep the author's comments. An edit asks for the first and never for
  // the second, and rebuilding a comment destroys whatever the schema cannot regenerate: a note to
  // a colleague, and the field's unit, which the ordinary label does not carry.
  //
  // Without its trailing newline. A statement's extent ends at its terminator, or at the comment on
  // that same line, and in neither case does it include the line break: the break is the first
  // character of the gap. `writeObject` ends with one because it is also used to write whole
  // documents, so emitting it here would put the break in twice and grow the file by a blank line
  // per reformatted object. Every object in a file, edited and saved twice, would grow it twice.
  const written = writeObject(anchored, {
    ...options,
    fieldComments: fieldComments(source, index),
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
 */
function extentEnds(source: PreservedSource): number[] {
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
 * The author's comment for each of a statement's fields, positionally, where one exists.
 *
 * A field's comment is the one after its separator on the same line, which is the same positional
 * rule {@link extentEnds} uses for the terminator and is the convention every writer of these files
 * follows. A comment on its own line belongs to no field and is left in the gap.
 *
 * Positional against `Statement.fields`, which is positional against the cells `writeObject` emits:
 * the name first for a named type, then the fixed fields in order. An object that gained fields
 * runs past the end of this list and generates the rest, which is right, since the author never
 * wrote a comment for a field that was not there.
 *
 * The last entry is the comment on the terminator's line, so this subsumes the duplicate that
 * {@link extentEnds} exists to prevent: the comment is emitted once, by the writer, in place.
 */
function fieldComments(source: PreservedSource, index: number): (string | undefined)[] {
  const { statements, tokens, text } = source.layer;
  const fields = statements[index]!.fields;
  const comments: (string | undefined)[] = new Array<string | undefined>(fields.length).fill(
    undefined
  );

  // One cursor over the tokens, which are in source order, as the fields are.
  let token = 0;
  for (let at = 0; at < fields.length; at += 1) {
    const end = fields[at]!.end;
    while (token < tokens.length && tokens.startAt(token) < end) token += 1;
    // The separator or terminator that closes the field sits between it and its comment, and is a
    // token of its own. Step over it; a field's comment is the next thing after it.
    while (
      token < tokens.length &&
      (tokens.kindAt(token) === 'separator' || tokens.kindAt(token) === 'terminator')
    ) {
      token += 1;
    }
    if (token >= tokens.length || tokens.kindAt(token) !== 'comment') continue;
    const between = text.slice(end, tokens.startAt(token));
    // Horizontal whitespace and the delimiter only. A line feed puts the comment on its own line,
    // where it belongs to no field.
    if (between.includes('\n') || between.replace(/[,;]/g, '').trim() !== '') continue;
    comments[at] = text.slice(tokens.startAt(token), tokens.endAt(token)).trimEnd();
  }
  return comments;
}
