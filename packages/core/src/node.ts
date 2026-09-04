/**
 * Node-only conveniences.
 *
 * This is the async edge of the library. The core is sync and pure; everything
 * that touches a disk or a network is here, so the portable surface never has
 * to be async "just in case" and browser bundles never pull in `node:fs`.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { SchemaBundle, type Schema } from '@idfkit/schemas';
import { localBundle } from '@idfkit/schemas/node';

import type { IdfDocument } from './document.js';
import { getEpJsonVersion, parseEpJson } from './parse/epjson.js';
import {
  getIdfVersion,
  IdfParseError,
  parseIdf,
  type ParseDiagnostic,
  type ParseOptions,
  type ParseResult,
} from './parse/idf.js';
import type { AnyTypeMap, UntypedMap } from './typemap.js';
import { resolveVersion } from './versions.js';
import { writeEpJson, type WriteEpJsonOptions } from './write/epjson.js';
import { writeIdf, type WriteIdfOptions } from './write/idf.js';

let defaultBundle: SchemaBundle | undefined;

/** The schema bundle shipped with `@idfkit/schemas`, created once per process. */
export function schemas(): SchemaBundle {
  defaultBundle ??= localBundle();
  return defaultBundle;
}

export interface LoadOptions extends ParseOptions {
  /** Force a schema version instead of reading it from the file. */
  version?: string;
  /** Use a specific bundle rather than the default. */
  bundle?: SchemaBundle;
}

/**
 * Resolve the schema for a file whose version was detected from its contents.
 *
 * Exported because callers who parse text themselves still need this step, and
 * getting it wrong (loading 26.1 for a 9.0 file) silently mis-maps every
 * positional field rather than failing loudly.
 */
export async function schemaFor(
  detected: string | undefined,
  options: LoadOptions = {}
): Promise<Schema> {
  const bundle = options.bundle ?? schemas();
  if (options.version !== undefined) return bundle.load(options.version);

  if (detected === undefined) {
    throw new Error(
      'No Version object found. Pass `version` explicitly to parse a versionless file.'
    );
  }
  const available = await bundle.versions();
  const resolved = resolveVersion(detected, available);
  if (resolved === undefined) {
    throw new Error(`EnergyPlus ${detected} is not supported. Available: ${available.join(', ')}`);
  }
  return bundle.load(resolved);
}

/** Read and parse an IDF file. */
export async function loadIdf<M extends AnyTypeMap = UntypedMap>(
  path: string,
  options: LoadOptions = {}
): Promise<IdfDocument<M>> {
  return (await loadIdfWithDiagnostics<M>(path, options)).document;
}

/** Read and parse an IDF file, keeping non-fatal diagnostics. */
export async function loadIdfWithDiagnostics<M extends AnyTypeMap = UntypedMap>(
  path: string,
  options: LoadOptions = {}
): Promise<ParseResult<M>> {
  // latin-1 rather than utf-8: EnergyPlus example files and vendor-exported
  // models routinely contain single high bytes (degree signs, accented station
  // names) that are not valid utf-8 and would otherwise decode to U+FFFD.
  const text = await readFile(path, 'latin1');
  const schema = await schemaFor(getIdfVersion(text), options);

  // `parseIdf` takes text and cannot know where the text came from, so the path is attached here,
  // at the one place that does. Python's parser opens the file itself and fills `filepath` from
  // its own constructor argument; this is the same field reaching a caller by the only route this
  // library has (FR-033).
  //
  // Stamped on both paths: the findings that stop the parse arrive on the error, and the ones that
  // do not arrive in the result. Neither is useful without saying which file it was.
  try {
    const result = parseIdf<M>(text, schema, options);
    return { ...result, diagnostics: result.diagnostics.map((d) => withPath(d, path)) };
  } catch (error) {
    if (error instanceof IdfParseError) {
      throw new IdfParseError(error.diagnostics.map((d) => withPath(d, path)));
    }
    throw error;
  }
}

/** Attach the source path to a finding, leaving one that already names a file alone. */
function withPath(diagnostic: ParseDiagnostic, path: string): ParseDiagnostic {
  return diagnostic.filepath === undefined ? { ...diagnostic, filepath: path } : diagnostic;
}

/** Read and parse an epJSON file. */
export async function loadEpJson<M extends AnyTypeMap = UntypedMap>(
  path: string,
  options: LoadOptions = {}
): Promise<IdfDocument<M>> {
  const text = await readFile(path, 'utf8');
  const schema = await schemaFor(getEpJsonVersion(text), options);
  return parseEpJson<M>(text, schema, options).document;
}

/** Write a document to an IDF file. */
export async function saveIdf<M extends AnyTypeMap>(
  document: IdfDocument<M>,
  path: string,
  options: WriteIdfOptions = {}
): Promise<void> {
  await writeFile(path, writeIdf(document, options), 'latin1');
}

/** Write a document to an epJSON file. */
export async function saveEpJson<M extends AnyTypeMap>(
  document: IdfDocument<M>,
  path: string,
  options: WriteEpJsonOptions = {}
): Promise<void> {
  await writeFile(path, writeEpJson(document, options), 'utf8');
}
