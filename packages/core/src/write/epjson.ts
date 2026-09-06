import type { IdfDocument } from '../document.js';
import { isWholeDocumentUntouched } from '../preserve/source.js';
import type { AnyTypeMap } from '../typemap.js';
import type { EpJson } from '../parse/epjson.js';

export interface WriteEpJsonOptions {
  /**
   * Indent width. `0` emits compact JSON.
   * @defaultValue 2
   */
  indent?: number;
  /**
   * Reproduce the text the document was read from, on this format's own terms.
   *
   * **All or nothing, which is not what the text format does.** The object notation has no
   * statements, so there is nothing to anchor an object's own characters to and no way to
   * reproduce one object while reformatting another. The retained text is therefore reproduced
   * only while nothing has been touched, nothing added and nothing removed, and any change at all
   * falls the whole document back to the ordinary writer.
   *
   * Both languages preserve this format on these terms. The difference is a property of the
   * format, not of either library, and it is stated here because a reader who knows the text
   * format's per-object terms would otherwise assume them.
   *
   * Tri-state as it is on the text writer: absent decides, `true` preserves and is a quiet
   * fallback when there is nothing to preserve, `false` formats.
   *
   * @defaultValue undefined, meaning decide
   */
  preserveFormatting?: boolean;
}

/** Serialize a document to epJSON text. */
export function writeEpJson<M extends AnyTypeMap>(
  document: IdfDocument<M>,
  options: WriteEpJsonOptions = {}
): string {
  const source = document.preservedSource;
  if (
    options.preserveFormatting !== false &&
    source !== undefined &&
    source.format === 'epjson' &&
    // Removal is decided from the count and from anchor identity, never from a scan of the
    // survivors: every object left after a removal is still exactly its own characters, so asking
    // only the survivors reproduces the original text with the removed object still in it. That is
    // a file that loads and misrepresents the model, and it is the defect this clause exists for.
    isWholeDocumentUntouched(document, source)
  ) {
    return source.layer.text;
  }
  const indent = options.indent ?? 2;
  return JSON.stringify(document.toJSON(), null, indent);
}

/** Serialize a document to a plain epJSON object. */
export function toEpJson<M extends AnyTypeMap>(document: IdfDocument<M>): EpJson {
  return document.toJSON();
}
