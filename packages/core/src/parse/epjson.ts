import type { Schema } from '@idfkit/schemas';

import { IDFDocument } from '../document.js';
import type { FieldValues } from '../object.js';
import type { AnyTypeMap, UntypedMap } from '../typemap.js';
import type { ParseDiagnostic, ParseOptions, ParseResult } from './idf.js';
import { IdfParseError } from './idf.js';

/** epJSON document shape: type -> name -> field values. */
export type EpJson = Record<string, Record<string, Record<string, unknown>>>;

/**
 * Parse epJSON into a document.
 *
 * Trivial next to the IDF path, which is the point: epJSON is already named and
 * typed, so there is no positional mapping and no coercion to do. Most of the
 * work here is deciding what to do about input the schema does not recognize.
 */
export function parseEpJson<M extends AnyTypeMap = UntypedMap>(
  source: string | EpJson,
  schema: Schema,
  options: ParseOptions = {}
): ParseResult<M> {
  const strict = options.strict ?? true;
  const diagnostics: ParseDiagnostic[] = [];

  const report = (diagnostic: ParseDiagnostic): void => {
    if (strict) throw new IdfParseError(diagnostic);
    diagnostics.push(diagnostic);
    options.onDiagnostic?.(diagnostic);
  };

  let root: EpJson;
  try {
    root = typeof source === 'string' ? (JSON.parse(source) as EpJson) : source;
  } catch (error) {
    throw new IdfParseError({
      message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      line: 1,
    });
  }

  const document = new IDFDocument<M>(schema);

  for (const [typeName, body] of Object.entries(root)) {
    const canonical = schema.resolve(typeName);
    if (canonical === undefined) {
      report({
        message: `Unknown object type "${typeName}" in EnergyPlus ${schema.version}`,
        line: 1,
        typeName,
      });
      continue;
    }
    const definition = schema.require(canonical);

    for (const [name, fields] of Object.entries(body ?? {})) {
      const values: FieldValues = {};
      for (const [field, value] of Object.entries(fields ?? {})) {
        if (value === null || value === undefined) continue;
        if (!Object.hasOwn(definition.p, field) && field !== definition.x?.key) {
          report({
            message: `Unknown field "${field}" on ${canonical}`,
            line: 1,
            typeName: canonical,
          });
          continue;
        }
        values[field] = value as FieldValues[string];
      }
      try {
        document.addRaw(canonical, definition.anon === 1 ? null : name, values);
      } catch (error) {
        report({
          message: error instanceof Error ? error.message : String(error),
          line: 1,
          typeName: canonical,
        });
      }
    }
  }

  return { document, diagnostics };
}

/** Read the version identifier from epJSON without a schema. */
export function detectEpJsonVersion(source: string | EpJson): string | undefined {
  let root: EpJson;
  try {
    root = typeof source === 'string' ? (JSON.parse(source) as EpJson) : source;
  } catch {
    return undefined;
  }
  const versions = root['Version'];
  if (versions === undefined) return undefined;
  const first = Object.values(versions)[0];
  const raw = first?.['version_identifier'];
  if (raw === undefined) return undefined;
  const parts = String(raw)
    .split('.')
    .map((p) => Number(p) || 0);
  return `${parts[0] ?? 0}.${parts[1] ?? 0}.${parts[2] ?? 0}`;
}
