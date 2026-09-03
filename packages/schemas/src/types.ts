/**
 * Slim schema representation.
 *
 * This is deliberately NOT the raw epJSON schema. Keys are single letters and
 * documentation metadata (`note`, `ip-units`, `field_info`) is dropped, because
 * this bundle is on the critical path of every parse and, in a browser, every
 * page load. This package republishes that metadata nowhere; tooling that
 * renders documentation reads the raw epJSON schemas directly, or uses
 * idfkit-docs (https://docs.idfkit.com).
 */

/** Field storage class, mirroring how the IDF writer must format the value. */
export type FieldKind =
  /** Alpha: written verbatim. */
  | 'a'
  /** Real: written with a decimal point preserved. */
  | 'n'
  /** Integer: written without a decimal point. */
  | 'i'
  /** Extensible array wrapper. */
  | 'arr';

export interface SlimField {
  /** Storage class. */
  t: FieldKind;
  /**
   * Field is an `anyOf` of a numeric branch and a string branch, in that order.
   *
   * Set for every one of the 13060 such fields across the 17 bundled versions.
   * The numeric branch's type, enum and bounds are hoisted onto this record;
   * the string branch survives as `se`.
   */
  auto?: 1;
  /**
   * String literals the `anyOf` string branch accepts, verbatim from the schema.
   *
   * Only meaningful together with `auto`. Absent while `auto` is set means the
   * string branch carries no enum at all and ANY string is legal there, which is
   * the shape of 646 fields including `Schedule:Compact`'s extensible `field`.
   * That is why the empty string is kept here rather than filtered out the way
   * `e` filters it: `se: ['']` (the whole string branch of the 68 fields whose
   * number branch carries a numeric enum) and no `se` at all mean the opposite
   * of one another.
   *
   * The sentinel is not a constant: 10565 fields take `Autosize` and 1781 take
   * `Autocalculate`, so a validator that accepts either everywhere accepts a
   * value EnergyPlus rejects.
   */
  se?: string[];
  /** Names of reference lists this field points *into* (i.e. it is a foreign key). */
  ol?: string[];
  /** Names of reference lists this field contributes *to* (i.e. it is a key). */
  ref?: string[];
  /**
   * Permitted values for a choice field.
   *
   * Numbers, not strings, on the 68 fields across the versions that express a
   * choice numerically (`e: [1, 3]` on `Site:GroundDomain:Slab.phase`). Compare
   * strings case-insensitively and numbers by value.
   */
  e?: (string | number)[];
  /** Schema default, applied on write when the field is absent. */
  d?: string | number;
  min?: number;
  max?: number;
  /**
   * Exclusive minimum, in whichever JSON Schema dialect the version shipped.
   *
   * A number is the bound itself (draft-06+, 9.6.0 onwards). The boolean `true`
   * qualifies the sibling `min`, making it exclusive (draft-04, 8.9.0 through
   * 9.5.0). Measured across the bundled schemas: `xmin` is boolean 9013 times
   * in the older seven versions and numeric 13840 times in the newer ten;
   * `xmax` behaves identically, and no version mixes the two. Branch on the
   * value's type, never on the version.
   */
  xmin?: number | boolean;
  /** Exclusive maximum. Number or boolean, exactly as `xmin`. */
  xmax?: number | boolean;
  /** SI units, used by the unit-conversion helpers. */
  u?: string;
  /** Value is case-sensitive and must not be normalized. */
  rc?: 1;
}

export interface SlimExtensible {
  /** epJSON key holding the array, e.g. `vertices`. */
  key: string;
  /** Field names inside each repeat group, in IDF order. */
  fields: string[];
  /** Definitions for the inner fields, from the array's `items`. */
  p: Record<string, SlimField>;
}

export interface SlimType {
  /** All field names in IDF positional order, from `legacy_idd.fields`. */
  f: string[];
  /** Field definitions, keyed by epJSON field name. */
  p: Record<string, SlimField>;
  /** Required field names. */
  r?: string[];
  /** Reference lists the object's *name* contributes to. */
  nref?: string[];
  /** Object's name is required. */
  nreq?: 1;
  /** Object is a singleton (`maxProperties: 1`), e.g. `Version`, `Building`. */
  s?: 1;
  /** Object has no name field at all, e.g. `Version`, `GlobalGeometryRules`. */
  anon?: 1;
  /** Extensible group definition, if the object has one. */
  x?: SlimExtensible;
  /** IDD group, e.g. `Thermal Zones and Surfaces`. */
  g?: string;
}

/** A manifest maps object type name to a blob hash in the shared store. */
export type Manifest = Record<string, string>;

export interface BundleIndex {
  /** Versions present, as `"26.1.0"` strings, sorted oldest first. */
  versions: string[];
  /** Per-version manifest file names, keyed by version string. */
  manifests: Record<string, string>;
}
