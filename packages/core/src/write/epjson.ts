import type { IdfDocument } from '../document.js';
import type { AnyTypeMap } from '../typemap.js';
import type { EpJson } from '../parse/epjson.js';

export interface WriteEpJsonOptions {
  /**
   * Indent width. `0` emits compact JSON.
   * @defaultValue 2
   */
  indent?: number;
}

/** Serialize a document to epJSON text. */
export function writeEpJson<M extends AnyTypeMap>(
  document: IdfDocument<M>,
  options: WriteEpJsonOptions = {}
): string {
  const indent = options.indent ?? 2;
  return JSON.stringify(document.toJSON(), null, indent);
}

/** Serialize a document to a plain epJSON object. */
export function toEpJson<M extends AnyTypeMap>(document: IdfDocument<M>): EpJson {
  return document.toJSON();
}
