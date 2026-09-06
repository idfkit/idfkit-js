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
 * A statement's region ends at its terminator, so a comment trailing the semicolon on the same
 * line is in the gap: removing an object leaves it, and reformatting one leaves it below the new
 * text. Behaviour rather than defects, and the alternative is a writer that guesses which comments
 * are about which object.
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
  const parts: string[] = [];

  // Everything before the first statement, which for a file with none is the whole text: an empty
  // file and a file of comments are both reproduced by this line alone.
  parts.push(text.slice(0, statements[0]?.region.start ?? text.length));

  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]!;
    parts.push(statementPart(source, index, text, options));
    // Unconditional: the gap is emitted whether the statement was copied, reformatted or dropped.
    parts.push(
      text.slice(statement.region.end, statements[index + 1]?.region.start ?? text.length)
    );
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
  options: ObjectWriteOptions
): string {
  const statement = source.layer.statements[index]!;
  const verbatim = text.slice(statement.region.start, statement.region.end);
  const anchored = source.anchors[index];
  if (anchored === undefined) return verbatim;
  // Removal is answered from ownership: `remove` already clears the owner, and recording it on
  // the object would mean holding a reference to something the document has let go.
  if (anchored[OWNER] === undefined) return '';
  if (isUntouched(anchored, source)) return verbatim;
  return writeObject(anchored, options);
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
