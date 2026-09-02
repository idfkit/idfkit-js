/**
 * On-demand validation against the schema.
 *
 * A port of the Python library's `idfkit.validation`, kept deliberately close
 * to it: the same checks in the same order producing the same `code` strings,
 * so the conformance corpus can hold the two implementations against one
 * another. Where the slim schema cannot express what the Python side reads out
 * of the full epJSON schema, the difference is called out at the check rather
 * than papered over.
 *
 * Nothing here is eager. Parsing never validates; you validate when you want
 * to, over the object types you care about.
 */

import type { Schema, SlimField } from '@idfkit/schemas';

import type { IdfDocument } from '../document.js';
import { DATA } from '../internal.js';
import type { IdfObject, StoredValue } from '../object.js';
import type { AnyTypeMap, UntypedMap } from '../typemap.js';
import { Severity, type ValidationError, type ValidationResult } from './types.js';

/** Which checks a document run performs. Every one defaults to on. */
interface ValidateDocumentOptions {
  /**
   * Schema to validate against. Defaults to the document's own, which is what
   * you want unless you are asking "would this model load under 25.2?".
   */
  schema?: Schema;
  /** Report references whose target no object provides. */
  checkReferences?: boolean;
  /** Report required fields that are absent or blank. */
  checkRequired?: boolean;
  /** Report values whose type the schema does not allow. */
  checkTypes?: boolean;
  /** Report numeric values outside their declared bounds. */
  checkRanges?: boolean;
  /** Report singleton types present more than once. */
  checkSingletons?: boolean;
  /** Restrict the run to these object types. Omit for all of them. */
  objectTypes?: readonly string[];
}

/** Which checks a single-object run performs. Every one defaults to on. */
interface ValidateObjectOptions {
  /** Report required fields that are absent or blank. */
  checkRequired?: boolean;
  /** Report values whose type the schema does not allow. */
  checkTypes?: boolean;
  /** Report numeric values outside their declared bounds. */
  checkRanges?: boolean;
  /** Report fields the schema does not define. */
  checkUnknown?: boolean;
}

/** Resolved check flags, threaded through the per-object walk. */
interface Checks {
  readonly required: boolean;
  readonly types: boolean;
  readonly ranges: boolean;
  readonly unknown: boolean;
}

/**
 * Validate a whole document.
 *
 * Findings are split by severity; `errors` being empty is what `isValid` means.
 * Nothing throws: a model that cannot load is described, not raised.
 *
 * @example
 * ```ts
 * const result = validateDocument(doc);
 * if (!result.isValid) {
 *   for (const error of result.errors) console.error(error.code, error.message);
 * }
 * ```
 */
export function validateDocument<M extends AnyTypeMap = UntypedMap>(
  doc: IdfDocument<M>,
  options: ValidateDocumentOptions = {}
): ValidationResult {
  const schema = options.schema ?? doc.schema;
  const checkReferences = options.checkReferences ?? true;
  const checkSingletons = options.checkSingletons ?? true;
  const checks: Checks = {
    required: options.checkRequired ?? true,
    types: options.checkTypes ?? true,
    ranges: options.checkRanges ?? true,
    // The Python original does not expose `check_unknown` on the document
    // entry point, so a document run always makes it.
    unknown: true,
  };

  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const info: ValidationError[] = [];

  // Types actually present, canonicalized, in document order. Asking the
  // document for a collection it does not have would create an empty one as a
  // side effect, so membership is settled before any lookup.
  const present = new Set(doc.types());
  const requested = options.objectTypes;
  const typesToCheck =
    requested === undefined
      ? [...present]
      : requested.map((name) => schema.resolve(name) ?? name).filter((name) => present.has(name));

  if (checkSingletons) {
    for (const objType of typesToCheck) {
      if (schema.get(objType)?.s !== 1) continue;
      const collection = doc.collection(objType);
      const count = collection.size;
      if (count <= 1) continue;
      const first = collection.first;
      errors.push({
        severity: Severity.ERROR,
        objType,
        objName: first !== undefined && first.name !== '' ? first.name : objType,
        field: undefined,
        message: `Singleton type '${objType}' has ${count} instances (maximum 1 allowed)`,
        code: 'E010',
      });
    }
  }

  for (const objType of typesToCheck) {
    for (const obj of doc.collection(objType)) {
      for (const finding of findingsFor(obj, schema, checks)) {
        if (finding.severity === Severity.ERROR) errors.push(finding);
        else if (finding.severity === Severity.WARNING) warnings.push(finding);
        else info.push(finding);
      }
    }
  }

  if (checkReferences) {
    for (const edge of doc.danglingReferences()) {
      errors.push({
        severity: Severity.ERROR,
        objType: edge.from.typeName,
        objName: edge.from.name,
        field: edge.field,
        message: `Reference to non-existent object '${edge.target}'`,
        code: 'E009',
      });
    }
  }

  return {
    errors,
    warnings,
    info,
    isValid: errors.length === 0,
    totalIssues: errors.length + warnings.length + info.length,
  };
}

/**
 * Validate one object, attached or detached.
 *
 * Useful right after building an object, before it goes anywhere near a
 * document. The schema is passed explicitly rather than taken from the object
 * so that "does this object hold up under another EnergyPlus version?" is
 * askable; a type the schema does not define is reported as `W002` rather than
 * throwing.
 *
 * @example
 * ```ts
 * const material = doc.add('Material', 'Gypsum', { roughness: 'Smooth' });
 * const findings = validateObject(material, doc.schema);
 * ```
 */
export function validateObject(
  obj: IdfObject,
  schema: Schema,
  options: ValidateObjectOptions = {}
): ValidationError[] {
  return findingsFor(obj, schema, {
    required: options.checkRequired ?? true,
    types: options.checkTypes ?? true,
    ranges: options.checkRanges ?? true,
    unknown: options.checkUnknown ?? true,
  });
}

// ---------------------------------------------------------------------------
// The per-object walk
// ---------------------------------------------------------------------------

function findingsFor(obj: IdfObject, schema: Schema, checks: Checks): ValidationError[] {
  const findings: ValidationError[] = [];
  const objType = obj.typeName;
  const objName = obj.name;

  const type = schema.get(objType);
  if (type === undefined) {
    findings.push({
      severity: Severity.WARNING,
      objType,
      objName,
      field: undefined,
      message: `Unknown object type '${objType}'`,
      code: 'W002',
    });
    return findings;
  }

  if (checks.required) {
    for (const field of type.r ?? []) {
      const value = obj[DATA][field];
      if (value === undefined || value === '') {
        findings.push({
          severity: Severity.ERROR,
          objType,
          objName,
          field,
          message: `Required field '${field}' is missing`,
          code: 'E001',
        });
      }
    }
  }

  // Read the backing store rather than `toJSON()`: this is the object's own
  // insertion order, which is what the Python original walks, and it avoids
  // copying every extensible group just to look at it.
  for (const [field, value] of Object.entries(obj[DATA])) {
    if (value === undefined || value === '') continue;

    const fieldSchema = type.p[field];
    if (fieldSchema === undefined) {
      // On an extensible type the field may belong to the repeat group rather
      // than the fixed list, so an unrecognized name there is not evidence of
      // anything.
      if (checks.unknown && type.x === undefined) {
        findings.push({
          severity: Severity.WARNING,
          objType,
          objName,
          field,
          message: `Unknown field '${field}'`,
          code: 'W003',
        });
      }
      continue;
    }

    if (checks.types) checkFieldType(obj, field, value, fieldSchema, findings);
    if (checks.ranges && typeof value === 'number') {
      checkFieldRange(obj, field, value, fieldSchema, findings);
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

function checkFieldType(
  obj: IdfObject,
  field: string,
  value: StoredValue,
  fieldSchema: SlimField,
  out: ValidationError[]
): void {
  // An auto-sizable field is an `anyOf` in the full epJSON schema: a numeric
  // branch, or the string branch holding `Autosize`/`Autocalculate`. Matching
  // either branch is enough, and matching the string branch is decided on the
  // type alone in the Python original, so any string passes. Reproduced rather
  // than tightened: tightening it here would make the two libraries disagree
  // about the same file for no recorded reason.
  if (fieldSchema.auto === 1) {
    if (typeof value === 'string' || matchesKind(value, fieldSchema.t)) return;
    out.push({
      severity: Severity.ERROR,
      objType: obj.typeName,
      objName: obj.name,
      field,
      message: `Value '${render(value)}' does not match any valid type`,
      code: 'E002',
    });
    return;
  }

  if (!matchesKind(value, fieldSchema.t)) {
    out.push({
      severity: Severity.ERROR,
      objType: obj.typeName,
      objName: obj.name,
      field,
      message: `Expected ${jsonTypeName(fieldSchema.t)}, got ${describeType(value)}`,
      code: 'E003',
    });
  }

  const allowed = fieldSchema.e;
  if (allowed === undefined) return;
  // Exact match first, then case-insensitively for strings, which is how
  // EnergyPlus reads a choice field and how the Python original checks it.
  // `choice` is guarded rather than trusted: `SlimField` types the list as
  // strings and the bundle stores numbers on a handful of fields.
  const matched = allowed.some(
    (choice) =>
      (choice as unknown) === value ||
      (typeof choice === 'string' &&
        typeof value === 'string' &&
        choice.toLowerCase() === value.toLowerCase())
  );
  if (!matched) {
    out.push({
      severity: Severity.ERROR,
      objType: obj.typeName,
      objName: obj.name,
      field,
      message: `Value '${render(value)}' not in allowed values: [${allowed
        .map((choice) => `'${choice}'`)
        .join(', ')}]`,
      code: 'E004',
    });
  }
}

/** Whether a stored value satisfies the schema's storage class for its field. */
function matchesKind(value: StoredValue, kind: SlimField['t']): boolean {
  switch (kind) {
    case 'n':
      return typeof value === 'number';
    case 'i':
      return typeof value === 'number' && Number.isInteger(value);
    case 'a':
      return typeof value === 'string';
    case 'arr':
      return Array.isArray(value);
  }
}

/** The epJSON `type` keyword the storage class stands for, for messages. */
function jsonTypeName(kind: SlimField['t']): string {
  switch (kind) {
    case 'n':
      return 'number';
    case 'i':
      return 'integer';
    case 'a':
      return 'string';
    case 'arr':
      return 'array';
  }
}

function describeType(value: StoredValue): string {
  return Array.isArray(value) ? 'array' : typeof value;
}

function render(value: StoredValue): string {
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

/**
 * Numeric bounds as the bundle actually stores them.
 *
 * `SlimField` declares `xmin`/`xmax` as numbers, but for EnergyPlus 8.9.0
 * through 9.5.0 the bundle carries the draft-04 form the epJSON schema shipped,
 * where `exclusiveMinimum` is the boolean `true` qualifying a sibling
 * `minimum` rather than a bound of its own. From 9.6.0 the same key holds the
 * bound. Reading `true` as a number would treat it as 1 and reject every value
 * at or below 1 in a positive-bounded field, which is the exact trap the
 * Python original documents.
 */
interface Bounds {
  min?: number;
  max?: number;
  xmin?: number | boolean;
  xmax?: number | boolean;
}

function checkFieldRange(
  obj: IdfObject,
  field: string,
  value: number,
  fieldSchema: SlimField,
  out: ValidationError[]
): void {
  // An auto-sizable field's bounds live inside the epJSON `anyOf`, and the
  // Python original reads bounds off the top level only, so it never range
  // checks one. The slim bundle hoists those bounds to the top level, which
  // would silently make this port stricter than Python on 598 fields in
  // 26.1.0 alone. Skipped on purpose; see the note in the task report.
  if (fieldSchema.auto === 1) return;

  const bounds: Bounds = fieldSchema;
  const { min, max, xmin, xmax } = bounds;

  const push = (message: string, code: string): void => {
    out.push({
      severity: Severity.ERROR,
      objType: obj.typeName,
      objName: obj.name,
      field,
      message,
      code,
    });
  };

  if (min !== undefined) {
    // draft-04: the sibling flag makes `min` exclusive.
    if (xmin === true) {
      if (value <= min) push(`Value ${value} must be greater than ${min}`, 'E006');
    } else if (value < min) {
      push(`Value ${value} is below minimum ${min}`, 'E005');
    }
  }
  // draft-06+: the key carries the bound itself.
  if (typeof xmin === 'number' && value <= xmin) {
    push(`Value ${value} must be greater than ${xmin}`, 'E006');
  }

  if (max !== undefined) {
    if (xmax === true) {
      if (value >= max) push(`Value ${value} must be less than ${max}`, 'E008');
    } else if (value > max) {
      push(`Value ${value} is above maximum ${max}`, 'E007');
    }
  }
  if (typeof xmax === 'number' && value >= xmax) {
    push(`Value ${value} must be less than ${xmax}`, 'E008');
  }
}
