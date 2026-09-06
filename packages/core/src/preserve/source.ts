import { SOURCE } from '../internal.js';
import type { IdfObject } from '../object.js';
import type { RawObject } from '../parse/lexer.js';
import type { SyntaxLayer } from '../syntax/layer.js';

/**
 * What a preserving read retains, so that a later write can give the file back.
 *
 * Held by the document rather than returned beside it: `ParseResult` carries exactly
 * `{ diagnostics, document }` and a test pins that it does. Built only when the read asked for it,
 * so a caller who does not ask pays neither the time nor the memory.
 *
 * @internal
 */
export interface PreservedSource {
  /**
   * Which reader retained this, and therefore which writer may reproduce it.
   *
   * A document read from the object notation carries JSON text, and the two formats preserve on
   * different terms, per object against all-or-nothing. The writers must not share a path by
   * accident.
   */
  readonly format: 'idf' | 'epjson';
  /**
   * The syntax layer the read scanned, holding the text and every region.
   *
   * For the object notation there is no layer: the format has no statements to anchor, so this
   * holds the text alone and `anchors` runs one entry per object in document order. That is what
   * makes preservation all-or-nothing there.
   */
  readonly layer: SyntaxLayer;
  /**
   * The object each statement produced, positionally.
   *
   * `anchors.length === layer.statements.length`. An entry is `undefined` when the statement
   * produced no object, which is a statement the read rejected: an unknown type, or a duplicate
   * name `addRaw` refused. Its characters are reproduced as written.
   *
   * Positional, never by name: an object may carry no name, may share one, or may be renamed after
   * the read, so a name index would be wrong in three ordinary situations.
   */
  readonly anchors: readonly (IdfObject | undefined)[];
  /**
   * Whether every object the read produced is still exactly the characters it came from.
   *
   * The object notation's whole question, answered as the contract states it: nothing touched,
   * nothing added and nothing removed. The count catches the removal, which asking the survivors
   * cannot, and the identity check catches the other two, because an object added after the read
   * carries no index and a touched one has had its index cleared.
   */
  /**
   * How many objects the document held when the read finished.
   *
   * Every object left after a removal is still pristine, so without the count a removal is
   * invisible and the retained text comes back with the removed object still in it.
   */
  readonly countAtRead: number;
}

/**
 * Whether an object is still exactly the characters it was read from.
 *
 * The third clause is not redundant: an object carrying an index from a file it is no longer in
 * fails the identity check, which is what makes a document assembled from more than one source
 * fall out rather than need handling.
 *
 * @internal
 */
export function isWholeDocumentUntouched(
  document: { size: number; objects: () => Iterable<IdfObject> },
  source: PreservedSource
): boolean {
  if (document.size !== source.countAtRead) return false;
  for (const obj of document.objects()) {
    if (!isUntouched(obj, source)) return false;
  }
  return true;
}

export function isUntouched(obj: IdfObject, source: PreservedSource | undefined): boolean {
  if (source === undefined) return false;
  const at = obj[SOURCE];
  if (at === undefined) return false;
  return source.anchors[at] === obj;
}

/**
 * The statement each raw object was read from, by index into `objects`.
 *
 * The lexer records one offset per object and the layer records the same offset as the start of
 * that statement's region, so the two match on a number both already hold. One pass with two
 * cursors: the lexer's sequence is a subsequence of the layer's, because some statements produce
 * no object.
 *
 * An object matching no statement gets `undefined` and is written by formatting, which is the
 * honest answer for one whose characters cannot be located.
 *
 * @internal
 */
export function statementIndexes(
  layer: SyntaxLayer,
  objects: readonly RawObject[]
): (number | undefined)[] {
  const found: (number | undefined)[] = new Array(objects.length).fill(undefined);
  const statements = layer.statements;
  let at = 0;
  for (let index = 0; index < objects.length; index += 1) {
    const offset = objects[index]?.offset;
    if (offset === undefined) continue;
    while (at < statements.length && statements[at]!.region.start < offset) at += 1;
    if (at >= statements.length) break;
    if (statements[at]!.region.start === offset) {
      found[index] = at;
      at += 1;
    }
  }
  return found;
}
