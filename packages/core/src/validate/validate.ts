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
    const unpopulated = unpopulatedLists(schema);
    const dangling = doc.danglingReferences();
    // Both sets cost a full document walk, so they are built once, and only
    // when there is something to test them against.
    const names = dangling.length > 0 ? declaredNames(doc.objects()) : undefined;
    for (const edge of dangling) {
      // A field pointing only into lists nothing can ever contribute to is not
      // naming an object at all, so its value cannot be dangling.
      if (pointsOnlyIntoUnpopulated(schema, edge.from.typeName, edge.field, unpopulated)) continue;
      // A name EnergyPlus mints itself is not dangling either, even though no
      // object declares it: one instance of a ZoneList assignment expanded per
      // member, or the leftover space of a partly covered zone.
      if (names !== undefined && isZoneListExpansion(edge.target, names)) continue;
      if (names !== undefined && isRemainderSpace(edge.target, names)) continue;
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

    // One finding per field, whatever the field is. A value that is both the
    // wrong type and out of range is one defect described twice, and reporting
    // it twice makes a caller fix it twice.
    //
    // An `anyOf` field is evaluated as a single unit, because its type, its enum
    // and its bounds all belong to a branch and cannot be checked in separate
    // passes: a value satisfying one branch's type and another branch's absence
    // of bounds satisfies neither branch. Which switch silences the result is
    // therefore decided after the fact, from the code the evaluation produced.
    if (fieldSchema.auto === 1) {
      const failure = anyOfFailure(value, fieldSchema);
      if (failure === undefined) continue;
      if (RANGE_CODES.has(failure.code) ? checks.ranges : checks.types) {
        findings.push(error(obj, field, failure));
      }
      continue;
    }

    // A plain field is three ordered checks — type, then enum, then bounds —
    // under the two switches that have always gated them.
    const failure =
      (checks.types ? plainFailure(value, fieldSchema) : undefined) ??
      (checks.ranges && typeof value === 'number'
        ? rangeFailures(value, fieldSchema)[0]
        : undefined);
    if (failure !== undefined) findings.push(error(obj, field, failure));
  }

  return findings;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** Per-schema cache: the answer depends only on the schema, and costs a full walk. */
const UNPOPULATED_BY_SCHEMA = new WeakMap<Schema, ReadonlySet<string>>();

/**
 * Reference lists that are pointed INTO and never contributed TO.
 *
 * `object_list` says a field points into a list; `reference` says a name
 * contributes to one. Four lists in 26.1.0 — `validBranchEquipmentTypes`,
 * `validCondenserEquipmentTypes`, `validOASysEquipmentTypes` and
 * `validPlantEquipmentTypes` — are only ever pointed into. They enumerate object
 * TYPE names rather than object names, so `component_object_type` holding
 * `Pipe:Adiabatic` is a correct value that no object in any model will ever
 * declare. Reporting those as dangling is 19783 false findings over the 760
 * EnergyPlus example files, one for nearly every branch component in every model.
 *
 * Derived from the schema rather than listed here: the set is version-dependent
 * (older versions carry a couple more), and a hardcoded list would go stale
 * silently on the next EnergyPlus release.
 */
function unpopulatedLists(schema: Schema): ReadonlySet<string> {
  const cached = UNPOPULATED_BY_SCHEMA.get(schema);
  if (cached !== undefined) return cached;

  const pointedInto = new Set<string>();
  const contributedTo = new Set<string>();
  for (const typeName of schema.typeNames) {
    const type = schema.get(typeName);
    if (type === undefined) continue;
    for (const list of type.nref ?? []) contributedTo.add(list);
    for (const props of [type.p, type.x?.p]) {
      for (const fieldSchema of Object.values(props ?? {})) {
        for (const list of fieldSchema.ol ?? []) pointedInto.add(list);
        for (const list of fieldSchema.ref ?? []) contributedTo.add(list);
      }
    }
  }

  const unpopulated = new Set<string>();
  for (const list of pointedInto) if (!contributedTo.has(list)) unpopulated.add(list);
  UNPOPULATED_BY_SCHEMA.set(schema, unpopulated);
  return unpopulated;
}

/**
 * Whether every list this field points into is one nothing can populate.
 *
 * Every, not any: a field naming several lists is dangling as long as one of
 * them is a list some object could have contributed to. A field the schema does
 * not describe keeps its finding, because silence there would be a guess.
 */
function pointsOnlyIntoUnpopulated(
  schema: Schema,
  typeName: string,
  field: string,
  unpopulated: ReadonlySet<string>
): boolean {
  if (unpopulated.size === 0) return false;
  const type = schema.get(typeName);
  // Extensible reference fields (`Branch.component_object_type`) are defined on
  // the repeat group, not alongside the fixed fields.
  const fieldSchema = type?.p[field] ?? type?.x?.p[field];
  const lists = fieldSchema?.ol;
  if (lists === undefined || lists.length === 0) return false;
  return lists.every((list) => unpopulated.has(list));
}

/**
 * The name sets the implicit-name tests need, lowercased.
 *
 * Names are compared case-insensitively, the way EnergyPlus resolves them and
 * the way every other name comparison in this library does.
 */
interface DeclaredNames {
  /** Every name any object declares, including field-declared ones. */
  readonly all: ReadonlySet<string>;
  /** Names declared by a `Zone` or a `Space`: the valid ZoneList-expansion prefixes. */
  readonly zonesAndSpaces: ReadonlySet<string>;
  /** Names declared by a `Zone` alone: the valid remainder-space prefixes. */
  readonly zones: ReadonlySet<string>;
}

/** Collect every name set in a single document walk. */
function declaredNames(objects: Iterable<IdfObject>): DeclaredNames {
  const all = new Set<string>();
  const zonesAndSpaces = new Set<string>();
  const zones = new Set<string>();
  for (const obj of objects) {
    // Same reasoning as `danglingReferences()`: anonymous types declare the
    // name others reference from an ordinary field, so `name` alone is short.
    for (const declared of obj.declaredNames()) {
      const lower = declared.toLowerCase();
      all.add(lower);
      if (obj.typeName === 'Zone' || obj.typeName === 'Space') zonesAndSpaces.add(lower);
      if (obj.typeName === 'Zone') zones.add(lower);
    }
  }
  return { all, zonesAndSpaces, zones };
}

/**
 * Whether a target names an object EnergyPlus creates by expanding a ZoneList.
 *
 * An object assigned to a `ZoneList` (or a `SpaceList`) is expanded by
 * EnergyPlus into one instance per member, named `<member name>` + a single
 * space + `<object name>`, and other objects legitimately reference those
 * expanded names. `DemandManager:ElectricEquipment.electric_equipment_name`
 * documents the convention in the schema itself: "if ZoneList option is used on
 * the ElectricEquipment object, a single equipment object from that assignment
 * can be selected by entering <Zone Name><space><Global ElectricEquipment
 * Object Name>". No object in the file declares that name, so the reference
 * looks dangling and is not.
 *
 * Every space is tried, not only the first: zone names and object names both
 * routinely contain spaces, so the split point cannot be assumed.
 *
 * Deliberately an approximation. It does not verify that the suffix object is
 * actually assigned to a ZoneList containing the prefix zone; doing so needs
 * ZoneList membership resolution that this library and its Python counterpart
 * do not share today. The approximation can only ever suppress a finding, never
 * invent one, so it cannot produce a false NEGATIVE on a valid model, which is
 * the property that matters here. This is a choice, not an oversight.
 */
function isZoneListExpansion(target: string, names: DeclaredNames): boolean {
  if (names.zonesAndSpaces.size === 0) return false;
  const lower = target.toLowerCase();
  for (let at = lower.indexOf(' '); at !== -1; at = lower.indexOf(' ', at + 1)) {
    if (!names.zonesAndSpaces.has(lower.slice(0, at))) continue;
    if (names.all.has(lower.slice(at + 1))) return true;
  }
  return false;
}

/** The name EnergyPlus gives a zone's leftover space is its zone name plus this. */
const REMAINDER_SUFFIX = '-remainder';

/**
 * Whether a target names the implicit remainder space of a declared zone.
 *
 * A zone that carries `Space` objects covering only part of it gets one more
 * space from EnergyPlus, holding whatever is left over and named
 * `<Zone Name>-Remainder`. Nothing declares that name, and objects reference it
 * like any other space. `5ZoneAirCooledWithSpacesHVAC.idf` names
 * `Zone 5-Remainder` twelve times: `Zone 5` is declared and carries the spaces
 * `Space 5 Office` and `Space 5 Conference`, while `Zone 5-Remainder` is
 * declared nowhere.
 *
 * Kept separate from `isZoneListExpansion` rather than folded into it: the two
 * joins differ, a hyphen against a space, and only a `Zone` can prefix this one
 * where a `Space` may prefix that one. Merging them would obscure both.
 *
 * An approximation in the same spirit as the ZoneList rule: it does not verify
 * that the zone's declared spaces actually leave a remainder. It can only
 * suppress a finding, never invent one, so no valid model gains a false
 * NEGATIVE from it. A choice, not an oversight.
 */
function isRemainderSpace(target: string, names: DeclaredNames): boolean {
  if (names.zones.size === 0) return false;
  const lower = target.toLowerCase();
  if (!lower.endsWith(REMAINDER_SUFFIX)) return false;
  return names.zones.has(lower.slice(0, lower.length - REMAINDER_SUFFIX.length));
}

// ---------------------------------------------------------------------------
// Type, enum and range
// ---------------------------------------------------------------------------

/** One failure of one branch: the code to report and the sentence to report it with. */
interface Failure {
  readonly code: string;
  readonly message: string;
}

/** Codes that belong to the range check rather than the type check. */
const RANGE_CODES: ReadonlySet<string> = new Set(['E005', 'E006', 'E007', 'E008']);

function error(obj: IdfObject, field: string, failure: Failure): ValidationError {
  return {
    severity: Severity.ERROR,
    objType: obj.typeName,
    objName: obj.name,
    field,
    message: failure.message,
    code: failure.code,
  };
}

/**
 * Evaluate a field the schema declares as `anyOf: [{number}, {string}]`.
 *
 * Ordinary JSON Schema `anyOf`: the value is valid when it satisfies at least
 * one branch *completely* — that branch's type, its enum if it has one, and its
 * bounds if it has any. Checking the type against one branch and the constraints
 * against another is exactly the defect this replaces; a value could satisfy the
 * number branch's type and the string branch's absence of bounds and be accepted
 * having satisfied neither.
 *
 * The branches are reconstructed from the slim record: the numeric branch is
 * `t` plus `e`, `min`, `max`, `xmin` and `xmax`, all of which the bundle hoists
 * off it, and the string branch is `se`, which is absent exactly when the branch
 * carried no enum and any string is legal.
 *
 * At most one finding, and it names the failure rather than the shape: an
 * out-of-range number reported as "not a number" tells the caller nothing.
 */
function anyOfFailure(value: StoredValue, fieldSchema: SlimField): Failure | undefined {
  // 1. The branches whose TYPE the value satisfies. A value is a number or a
  //    string, never both, so at most one of these holds; the code is written
  //    as a set anyway because the rule is.
  const numeric = matchesKind(value, fieldSchema.t);
  const stringly = typeof value === 'string';

  // 2. No branch matched on type: an array where a number or a string belongs.
  if (!numeric && !stringly) {
    return { code: 'E002', message: `Value '${render(value)}' does not match any valid type` };
  }

  // 3. A branch satisfied whole makes the value valid, whatever the other says.
  const numericFailure = numeric ? numericBranchFailure(value as number, fieldSchema) : undefined;
  if (numeric && numericFailure === undefined) return undefined;
  const stringFailure = stringly ? stringBranchFailure(value as string, fieldSchema) : undefined;
  if (stringly && stringFailure === undefined) return undefined;

  // 4. Matched on type, failed on a constraint. Report the first branch in
  //    declaration order, which is the numeric one in every `anyOf` in all 17
  //    bundled versions.
  return numericFailure ?? stringFailure;
}

/** The numeric branch: its enum, then its bounds. `undefined` when satisfied. */
function numericBranchFailure(value: number, fieldSchema: SlimField): Failure | undefined {
  const allowed = fieldSchema.e;
  if (allowed !== undefined && !satisfiesEnum(allowed, value)) {
    return enumFailure(allowed, value);
  }
  return rangeFailures(value, fieldSchema)[0];
}

/**
 * The string branch: its enum, if it has one.
 *
 * No `se` means the branch declared no enum and any string satisfies it, which
 * is the shape of 646 fields including `Schedule:Compact`'s extensible `field`.
 * `se` is never inferred: the sentinel is `Autosize` on some fields and
 * `Autocalculate` on others, and accepting either everywhere would accept a
 * value EnergyPlus rejects.
 */
function stringBranchFailure(value: string, fieldSchema: SlimField): Failure | undefined {
  const allowed = fieldSchema.se;
  if (allowed === undefined || satisfiesEnum(allowed, value)) return undefined;
  return enumFailure(allowed, value);
}

/**
 * A field the schema declares with one type: its type, then its enum.
 *
 * The bounds are the caller's business, because they answer to a different
 * switch. Stopping at the first failure is what keeps a wrong-typed value from
 * also being reported against a choice list it was never going to satisfy.
 */
function plainFailure(value: StoredValue, fieldSchema: SlimField): Failure | undefined {
  if (!matchesKind(value, fieldSchema.t)) {
    return {
      code: 'E003',
      message: `Expected ${jsonTypeName(fieldSchema.t)}, got ${describeType(value)}`,
    };
  }

  const allowed = fieldSchema.e;
  if (allowed === undefined || satisfiesEnum(allowed, value)) return undefined;
  return enumFailure(allowed, value);
}

/**
 * Enum membership.
 *
 * Exact match first, then case-insensitively for strings, which is how
 * EnergyPlus reads a choice field and how the Python original checks it. Numbers
 * compare by value: 68 fields across the versions state their choices
 * numerically, and `3` is not one of `[0, 1]`.
 */
function satisfiesEnum(allowed: readonly (string | number)[], value: StoredValue): boolean {
  return allowed.some(
    (choice) =>
      (choice as unknown) === value ||
      (typeof choice === 'string' &&
        typeof value === 'string' &&
        choice.toLowerCase() === value.toLowerCase())
  );
}

function enumFailure(allowed: readonly (string | number)[], value: StoredValue): Failure {
  return {
    code: 'E004',
    message: `Value '${render(value)}' not in allowed values: [${allowed
      .map((choice) => `'${choice}'`)
      .join(', ')}]`,
  };
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
 * Every bound the value breaks, in `minimum`, `exclusiveMinimum`, `maximum`,
 * `exclusiveMaximum` order.
 *
 * `xmin`/`xmax` arrive in either of the two JSON Schema dialects the bundled
 * schemas ship. From 9.6.0 they are draft-06+ and carry the bound itself; for
 * 8.9.0 through 9.5.0 they are draft-04 and are the boolean `true`, qualifying
 * the sibling `minimum`/`maximum`. Reading `true` as a number would treat it as
 * 1 and reject every value at or below 1 in a positive-bounded field, so this
 * branches on the type of the value and never on the version.
 */
function rangeFailures(value: number, bounds: SlimField): Failure[] {
  const { min, max, xmin, xmax } = bounds;
  const out: Failure[] = [];

  if (min !== undefined) {
    // draft-04: the sibling flag makes `min` exclusive.
    if (xmin === true) {
      if (value <= min)
        out.push({ code: 'E006', message: `Value ${value} must be greater than ${min}` });
    } else if (value < min) {
      out.push({ code: 'E005', message: `Value ${value} is below minimum ${min}` });
    }
  }
  // draft-06+: the key carries the bound itself.
  if (typeof xmin === 'number' && value <= xmin) {
    out.push({ code: 'E006', message: `Value ${value} must be greater than ${xmin}` });
  }

  if (max !== undefined) {
    if (xmax === true) {
      if (value >= max)
        out.push({ code: 'E008', message: `Value ${value} must be less than ${max}` });
    } else if (value > max) {
      out.push({ code: 'E007', message: `Value ${value} is above maximum ${max}` });
    }
  }
  if (typeof xmax === 'number' && value >= xmax) {
    out.push({ code: 'E008', message: `Value ${value} must be less than ${xmax}` });
  }

  return out;
}
