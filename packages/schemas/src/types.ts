/**
 * Slim schema representation.
 *
 * This is deliberately NOT the raw epJSON schema. Keys are single letters and
 * documentation metadata (`note`, `ip-units`, `field_info`) is dropped, because
 * this bundle is on the critical path of every parse and, in a browser, every
 * page load. Human-facing metadata lives in `@idfkit/schemas/docs`, which only
 * tooling that renders documentation needs to pull in.
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
  /** Field accepts `Autosize` / `Autocalculate` in addition to a number. */
  auto?: 1;
  /** Names of reference lists this field points *into* (i.e. it is a foreign key). */
  ol?: string[];
  /** Names of reference lists this field contributes *to* (i.e. it is a key). */
  ref?: string[];
  /** Permitted values for a choice field. */
  e?: string[];
  /** Schema default, applied on write when the field is absent. */
  d?: string | number;
  min?: number;
  max?: number;
  /** Exclusive minimum. */
  xmin?: number;
  /** Exclusive maximum. */
  xmax?: number;
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
