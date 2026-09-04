/**
 * `@idfkit/core` — EnergyPlus IDF and epJSON parsing and manipulation.
 *
 * Everything exported here is synchronous and free of I/O, so it runs
 * unchanged in Node, a browser, a worker, or an edge runtime. Reading files and
 * loading schema bundles lives in `@idfkit/core/node`, or is done by the caller
 * via `@idfkit/schemas`.
 *
 * This package carries no generated per-version types and does not need to. A
 * document with no type map is typed through `UntypedMap`, so everything below
 * works and field names are accepted as strings. Static field checking is
 * opt-in and installed by its own name, `@idfkit/types-v26-1` or
 * `@idfkit/types-v9-4`, because the two maps together are 5.3 MB against
 * roughly 170 KB of everything else and a reader who never parameterises a
 * document should not pay for them (FR-039, FR-040, SC-014). `./typemap.ts`
 * says how a map attaches.
 */

export { IdfCollection } from './collection.js';
export { IdfDocument } from './document.js';
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

// The conformance corpus level this release declares (FR-024), generated from
// `idfkit.conformance` in package.json so the claim and the pin stay one fact.
export { CONFORMANCE_LEVEL } from './conformance.js';

export { lex } from './parse/lexer.js';
export type { LexDiagnostic, LexOptions, RawObject } from './parse/lexer.js';
export { getIdfVersion, IdfParseError, parseIdf } from './parse/idf.js';
export type { ParseDiagnostic, ParseOptions, ParseResult } from './parse/idf.js';
export { getEpJsonVersion, parseEpJson } from './parse/epjson.js';
export type { EpJson } from './parse/epjson.js';

export { scanIdf } from './syntax/layer.js';
export type { Statement, SyntaxLayer } from './syntax/layer.js';
export { classify } from './syntax/classify.js';
export type { Token, TokenKind } from './syntax/tokens.js';
export { lineColumnAt, offsetAt } from './syntax/region.js';
export type { LineColumn, Region } from './syntax/region.js';

export { writeIdf, writeObject } from './write/idf.js';
export type { ObjectWriteOptions, WriteIdfOptions } from './write/idf.js';
export { toEpJson, writeEpJson } from './write/epjson.js';
export type { WriteEpJsonOptions } from './write/epjson.js';

export { Severity, validateDocument, validateObject } from './validate/index.js';
export type { ValidationError, ValidationResult } from './validate/index.js';

export { describeObjectType } from './introspect/describe.js';
export type { FieldDescription, ObjectDescription } from './introspect/describe.js';

export {
  docsUrlForObject,
  engineeringReferenceUrl,
  ioReferenceUrl,
  searchUrl,
} from './docs-url/index.js';
export type { DocsUrl } from './docs-url/index.js';

export { Schema, SchemaBundle, httpSource } from '@idfkit/schemas';
export type { BundleSource, ProsePool, SchemaDelta, SlimField, SlimType } from '@idfkit/schemas';
