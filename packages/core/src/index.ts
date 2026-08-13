/**
 * `@idfkit/core` — EnergyPlus IDF and epJSON parsing and manipulation.
 *
 * Everything exported here is synchronous and free of I/O, so it runs
 * unchanged in Node, a browser, a worker, or an edge runtime. Reading files and
 * loading schema bundles lives in `@idfkit/core/node`, or is done by the caller
 * via `@idfkit/schemas`.
 */

export { IdfCollection } from './collection.js';
export { IDFDocument } from './document.js';
export { IdfObject } from './object.js';
export type {
  ExtensibleGroup,
  FieldValue,
  FieldValues,
  ObjectOwner,
  StoredValue,
} from './object.js';
export { ReferenceGraph } from './references.js';
export type { ReferenceEdge } from './references.js';
export { ObjectShape, shapeFor, shapeOf } from './shape.js';
export type { AnyTypeMap, ObjectOf, TypeNameOf, UntypedMap, ValuesOf } from './typemap.js';
export { compareVersions, resolveVersion, versionKey } from './versions.js';

export { lex } from './parse/lexer.js';
export type { LexDiagnostic, LexOptions, RawObject } from './parse/lexer.js';
export { detectVersion, IdfParseError, parseIdf } from './parse/idf.js';
export type { ParseDiagnostic, ParseOptions, ParseResult } from './parse/idf.js';
export { detectEpJsonVersion, parseEpJson } from './parse/epjson.js';
export type { EpJson } from './parse/epjson.js';

export { writeIdf, writeObject } from './write/idf.js';
export type { ObjectWriteOptions, WriteIdfOptions } from './write/idf.js';
export { toEpJson, writeEpJson } from './write/epjson.js';
export type { WriteEpJsonOptions } from './write/epjson.js';

export { Schema, SchemaBundle, httpSource } from '@idfkit/schemas';
export type { BundleSource, SchemaDelta, SlimField, SlimType } from '@idfkit/schemas';
