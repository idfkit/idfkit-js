import type { ProsePool, Schema, SlimField, SlimType } from '@idfkit/schemas';

/**
 * Description of a single field in an EnergyPlus object type.
 *
 * The field set mirrors Python's `idfkit.introspection.FieldDescription`
 * one-for-one, snake_case renamed to camelCase. Every member is always present,
 * so a description can be diffed against the Python dataclass key by key;
 * Python's `str | None` becomes `string | undefined`.
 */
export interface FieldDescription {
  /** Field name in epJSON spelling, e.g. `x_origin`. */
  readonly name: string;
  /**
   * epJSON JSON-Schema type: `"number"`, `"string"`, `"integer"`, `"array"`, or
   * a pipe-delimited union in declaration order for heterogeneous `anyOf`
   * fields, e.g. `"number|string"` for `Schedule:Compact`'s extensible `field`.
   *
   * `undefined` when the field appears in the positional order but carries no
   * schema definition at all.
   */
  readonly fieldType: string | undefined;
  /** Whether the field is listed in the object's `required` array. */
  readonly required: boolean;
  readonly default: string | number | undefined;
  /** SI units, e.g. `"m"`, `"W/m-K"`. */
  readonly units: string | undefined;
  /**
   * Permitted values for a choice field.
   *
   * Numbers rather than strings for the handful of fields that express a choice
   * numerically, matching Python, which also hands back the raw JSON values.
   */
  readonly enumValues: readonly (string | number)[] | undefined;
  readonly minimum: number | undefined;
  readonly maximum: number | undefined;
  /**
   * Exclusive minimum, as the schema for this version declares it.
   *
   * `true` rather than a number on 8.9.0 through 9.5.0, whose draft-04 schemas
   * use the keyword as a flag qualifying `minimum` instead of as a bound. Python
   * reports the same raw value, so a caller comparing the two sides sees no
   * difference; a caller comparing a value against it must check the type first.
   */
  readonly exclusiveMinimum: number | boolean | undefined;
  /** Exclusive maximum. Number or boolean, exactly as `exclusiveMinimum`. */
  readonly exclusiveMaximum: number | boolean | undefined;
  /**
   * Field documentation note.
   *
   * Always `undefined` here. The slim schema bundle deliberately drops `note`
   * (see the header of `@idfkit/schemas`'s `types.ts`), and no other faithful
   * source for it exists in this package. It is kept in the type because the
   * naming register requires the same field set on both sides, and because
   * inventing a value from the field name would be worse than admitting the
   * absence.
   */
  readonly note: string | undefined;
  /** Whether this field points into another object's reference list. */
  readonly isReference: boolean;
  /** Reference list names this field points into. */
  readonly objectList: readonly string[] | undefined;
}

/**
 * Description of an EnergyPlus object type.
 *
 * Field set mirrors Python's `idfkit.introspection.ObjectDescription`.
 */
export interface ObjectDescription {
  /** Canonical object type name, e.g. `"Zone"`. */
  readonly objType: string;
  /**
   * Object memo from the schema.
   *
   * Always `undefined` here, for the same reason as `FieldDescription.note`:
   * the slim bundle drops `memo`, and this package has no faithful source for
   * it. See that member's note.
   */
  readonly memo: string | undefined;
  readonly fields: readonly FieldDescription[];
  /** Required field names, in schema order. */
  readonly requiredFields: readonly string[];
  /** Whether the type carries a name field. `Version` and friends do not. */
  readonly hasName: boolean;
  /** Whether the type has a repeating extensible group. */
  readonly isExtensible: boolean;
  /** Number of fields in one extensible repeat group. */
  readonly extensibleSize: number | undefined;
}

/**
 * Describe an EnergyPlus object type: its fields, their order, and their
 * constraints.
 *
 * Synchronous and pure, like the rest of `@idfkit/core`'s root entry: the
 * schema is already in memory, and this only reads it.
 *
 * Ports `idfkit.introspection.describe_object_type`. Where the slim schema
 * cannot reproduce Python exactly the loss is recorded in a comment at the
 * point it happens rather than papered over with a plausible substitute.
 *
 * @throws If `objType` is not defined in this schema version. The message is
 * the one `Schema.require` already produces everywhere else in the package;
 * Python raises `UnknownObjectTypeError`, which has no registered TypeScript
 * counterpart and so must not become a new exported class.
 */
export function describeObjectType(
  schema: Schema,
  objType: string,
  prose?: ProsePool
): ObjectDescription {
  const type = schema.require(objType);
  // Exact-cased input resolves to itself, so this matches Python's verbatim
  // echo of the argument for every name Python accepts.
  const canonical = schema.resolve(objType) ?? objType;

  const properties = mergedProperties(type);
  const requiredFields = type.r ?? [];
  const required = new Set(requiredFields);

  const extensible = type.x;
  const fieldNames = orderedFieldNames(type);

  const fields: FieldDescription[] = fieldNames.map((name) =>
    describeField(name, properties[name], required.has(name), prose)
  );

  return {
    objType: canonical,
    // Resolved from the pool when one is supplied, and `undefined` otherwise —
    // which is exactly what this returned before the pool existed, so a caller
    // who passes nothing sees no change at all (FR-014). A type with no memo in
    // the source schema also reports `undefined`, in both languages: absence is
    // reported as absence rather than filled with a placeholder.
    memo: lookupProse(type.m, prose),
    fields,
    requiredFields: [...requiredFields],
    hasName: type.anon !== 1,
    isExtensible: extensible !== undefined,
    // Python reads `extensible_size` straight from the schema. The slim bundle
    // drops that key, but it is exactly the repeat-group width, which survives
    // as `x.fields.length`. Verified equal for every extensible type in all 17
    // bundled versions, so this is a derivation, not an approximation.
    extensibleSize: extensible === undefined ? undefined : extensible.fields.length,
  };
}

/**
 * Field names in the order Python produces them.
 *
 * @internal
 */
function orderedFieldNames(type: SlimType): string[] {
  // Python's `get_field_names` returns `legacy_idd.fields[1:]` — it drops the
  // first entry positionally, on the assumption that it is always the name.
  // That holds for every named type in all 17 bundled versions, but 154 types
  // in 26.1.0 are anonymous, and for those the first entry is a real field
  // (`GlobalGeometryRules.starting_vertex_position`, `Output:Variable.key_value`)
  // which Python silently drops. Dropping positionally rather than filtering on
  // `!== 'name'` is what keeps this port in agreement with the oracle; the
  // divergence to close is in Python, not here.
  const names = type.f.slice(1);
  // No legacy field order (or only the name): Python falls back to the key order
  // of the merged property map. Only the fixed half is taken from `p` here; the
  // extensible half is appended below from `x.fields`, which is an array and so
  // keeps its declaration order. Taking it from `x.p` instead would be wrong:
  // the bundle content-addresses each definition through a canonical serializer
  // that sorts object keys, so every `Record` in it is in alphabetical order,
  // not schema order. `AvailabilityManagerAssignmentList` is the type that shows
  // it — its two extensible fields are declared object-type first and sort
  // name first.
  // `fo` is the declaration order, recorded by the bundle for the three types
  // whose `f` holds only the name. Without it the fallback below returns the
  // key order of `p`, which `canonical()` sorted for content-addressing, and
  // the reader gets alphabetical order where Python gives declaration order.
  const ordered = names.length > 0 ? names : (type.fo ?? Object.keys(type.p)).slice();

  if (type.x !== undefined) {
    for (const name of type.x.fields) {
      if (!ordered.includes(name)) ordered.push(name);
    }
  }
  return ordered;
}

/**
 * Python flattens each extension array's `items.properties` into the top-level
 * property map so extensible fields look up the same way as fixed ones. Spread
 * order reproduces that: existing keys keep their position, new ones append.
 *
 * @internal
 */
function mergedProperties(type: SlimType): Record<string, SlimField> {
  return type.x === undefined ? type.p : { ...type.p, ...type.x.p };
}

/** @internal */
function describeField(
  name: string,
  field: SlimField | undefined,
  required: boolean,
  prose?: ProsePool
): FieldDescription {
  if (field === undefined) {
    // In the positional order but absent from the schema. Python reaches the
    // same state via `properties.get(field_name, {})`.
    return {
      name,
      fieldType: undefined,
      required,
      default: undefined,
      units: undefined,
      enumValues: undefined,
      minimum: undefined,
      maximum: undefined,
      exclusiveMinimum: undefined,
      exclusiveMaximum: undefined,
      note: undefined,
      isReference: false,
      objectList: undefined,
    };
  }

  // `auto` marks a field the bundle collapsed from `anyOf: [number, string]`.
  // Python's `describe_object_type` reads `minimum`/`maximum`/`exclusiveMinimum`/
  // `exclusiveMaximum` from the *top level* of the field schema only, and no
  // `anyOf` field in any of the 17 bundled versions carries those keys at the
  // top level — they live on the numeric branch, which that function never looks
  // at. The bundle hoists them; Python reports null. Suppressing them here is
  // what makes the two sides agree. Validation is a separate question and reads
  // the branch properly on both sides; see `validate/`.
  const collapsedAnyOf = field.auto === 1;

  return {
    name,
    fieldType: fieldTypeOf(field),
    required,
    default: field.d,
    units: field.u,
    enumValues: acceptedValues(field),
    minimum: collapsedAnyOf ? undefined : field.min,
    maximum: collapsedAnyOf ? undefined : field.max,
    exclusiveMinimum: collapsedAnyOf ? undefined : field.xmin,
    exclusiveMaximum: collapsedAnyOf ? undefined : field.xmax,
    note: lookupProse(field.n, prose),
    isReference: field.ol !== undefined,
    objectList: field.ol === undefined ? undefined : [...field.ol],
  };
}

/**
 * Resolve a prose index against the pool.
 *
 * Returns `undefined` for a record with no prose, and for every record when no
 * pool was supplied. Out-of-range is `undefined` too rather than a throw: a
 * caller who hands in a pool from a different bundle build gets no prose, which
 * is the same thing they had before, instead of a description that cannot be
 * produced at all.
 *
 * @internal
 */
function lookupProse(index: number | undefined, prose: ProsePool | undefined): string | undefined {
  if (index === undefined || prose === undefined) return undefined;
  return prose[index];
}

/**
 * The values a field accepts, as Python reports them.
 *
 * Two sources, and until feature 002 this read neither completely:
 *
 * - `e`, the choice list, with the empty string filtered out by the bundle
 *   because `e` is what validation checks against. Python keeps the blank, so
 *   `eb` records that it was there and it goes back on the front. It is always
 *   the front: measured across all 17 schemas, all 21,962 blank-bearing enums
 *   carry it at position 0.
 * - `se`, the collapsed `anyOf` string branch, which holds the sentinels.
 *   `Autosize` on 10,565 fields and `Autocalculate` on 1,781. Validation has
 *   always read it (`validate/validate.ts:543`); this path never did, so
 *   `WindowMaterial:Glazing:EquivalentLayer.diffuse_diffuse_solar_transmittance`
 *   reported nothing where Python reported `['', 'Autocalculate']`.
 *
 * A field carries one or the other, never both: `se` exists only when the field
 * was an `anyOf`, and `e` is then hoisted from the numeric branch. The 68
 * fields that carry both are the numeric-enum ones, and Python reports the
 * string branch for those, which is what taking `se` first does.
 *
 * @internal
 */
function acceptedValues(field: SlimField): (string | number)[] | undefined {
  if (field.se !== undefined) return [...field.se];
  if (field.e === undefined) return undefined;
  return field.eb === 1 ? ['', ...field.e] : [...field.e];
}

/**
 * Map the slim storage class back to the epJSON JSON-Schema type string Python
 * reports.
 *
 * The bundle stores four storage classes where Python reports the raw `type`
 * key, so the mapping is not automatically one-to-one. Measured against all 17
 * bundled schemas it is, with one exception:
 *
 * - `'a'` is `"string"`. Every `'a'` field is a raw `"type": "string"`, or an
 *   enum-only field, which Python also calls `"string"`.
 * - `'n'` is `"number"`, and `"number|string"` when `auto` is set. `auto` is set
 *   exactly when the raw field was `anyOf: [{number}, {string}]` — 13052 such
 *   fields across all versions, every one of them in that branch order, so the
 *   union string is reconstructed exactly rather than guessed.
 * - `'i'` is `"integer"`, and `"integer|string"` when `auto` is set, the
 *   `anyOf: [{integer}, {string}]` shape carried by one field per version from
 *   9.3.0 on, `AirTerminal:SingleDuct:ConstantVolume:CooledBeam.number_of_beams`.
 *   The bundle also folds `"type": "number"` carrying `"data_type": "integer"`
 *   into `'i'`, which would report `"number"` in Python — but no schema in any
 *   bundled version actually uses that form.
 * - `'arr'` is `"array"`.
 *
 * @internal
 */
function fieldTypeOf(field: SlimField): string {
  switch (field.t) {
    case 'arr':
      return 'array';
    case 'i':
      return field.auto === 1 ? 'integer|string' : 'integer';
    case 'n':
      return field.auto === 1 ? 'number|string' : 'number';
    case 'a':
      return 'string';
  }
}
