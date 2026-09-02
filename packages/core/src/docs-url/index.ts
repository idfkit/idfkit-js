/**
 * Documentation URL builder for docs.idfkit.com.
 *
 * Port of `idfkit/src/idfkit/docs.py`. The two libraries must produce
 * byte-identical addresses, so every rule here mirrors the Python one exactly:
 * the same version gate, the same bundled object-type mapping, the same
 * schema-group fallback, and the same labels down to the em dash.
 *
 * Synchronous and free of I/O, like the rest of the `@idfkit/core` root entry.
 * The one place Python is not — it lazily loads the latest schema when the
 * caller omits one — is the single documented divergence; see
 * {@link ioReferenceUrl}.
 */

import type { Schema } from '@idfkit/schemas';

import { versionKey } from '../versions.js';
import { DOC_LOCATIONS } from './locations.js';

/** @internal Not public API: `baseUrl` overrides exist for tests. */
const BASE_URL = 'https://docs.idfkit.com';

/** A resolved documentation URL with metadata. */
export interface DocsUrl {
  readonly url: string;
  /** Python spells this `doc_set`; the field-casing rule renames it here. */
  readonly docSet: 'io-reference' | 'engineering-reference' | 'search';
  /** Short version used in the URL path, e.g. `v25.2`. */
  readonly version: string;
  /** Human-readable label, e.g. `Zone — I/O Reference`. */
  readonly label: string;
}

/**
 * EnergyPlus versions that have documentation on docs.idfkit.com.
 *
 * Mirrors `ENERGYPLUS_VERSIONS` in `idfkit/src/idfkit/versions.py`, which is
 * what `is_supported_version` gates on. The set has to be identical in both
 * libraries: a version in one and not the other means one emits a link where
 * the other emits nothing. `docs-url.test.ts` holds this against the versions
 * the schema bundle actually ships.
 *
 * @internal
 */
const DOCUMENTED_VERSIONS: readonly string[] = [
  '8.9.0',
  '9.0.1',
  '9.1.0',
  '9.2.0',
  '9.3.0',
  '9.4.0',
  '9.5.0',
  '9.6.0',
  '22.1.0',
  '22.2.0',
  '23.1.0',
  '23.2.0',
  '24.1.0',
  '24.2.0',
  '25.1.0',
  '25.2.0',
  '26.1.0',
];

/**
 * Numeric version key -> the `vM.m` path segment.
 *
 * Keyed numerically rather than by string so that `9.01.0` and `9.1.0` are the
 * same version, the way the Python tuple `(9, 1, 0)` is one value however it
 * was spelled. The short form is taken from the registered version rather than
 * from the caller's string, so the emitted path is canonical either way.
 *
 * @internal
 */
const SHORT_VERSIONS: ReadonlyMap<number, string> = new Map(
  DOCUMENTED_VERSIONS.map((version) => {
    const [major, minor] = version.split('.');
    return [versionKey(version), `v${major}.${minor}`];
  })
);

/**
 * Object type -> documentation location, built on first use.
 *
 * Deferred the way Python defers reading `doc_locations.json`, so importing
 * `@idfkit/core` costs nothing until something asks for a documentation URL.
 *
 * @internal
 */
let locations: Map<string, string> | undefined;

/** @internal */
function docLocations(): Map<string, string> {
  if (locations === undefined) {
    locations = new Map();
    for (const [path, types] of DOC_LOCATIONS) {
      for (const objType of types.split('\t')) {
        locations.set(objType, `${path}${objectAnchor(objType)}`);
      }
    }
  }
  return locations;
}

/** @internal Mirrors `_object_anchor`: strip `:`, `/`, `(`, `)` and spaces. */
function objectAnchor(objType: string): string {
  return objType.toLowerCase().replace(/[:/() ]/g, '');
}

/**
 * The `vM.m` path segment, or undefined when the version has no documentation.
 *
 * @internal
 */
function resolveDocVersion(version: string): string | undefined {
  return SHORT_VERSIONS.get(versionKey(version));
}

/**
 * The IDD group for an object type, matching Python's `schema.get_group`.
 *
 * That lookup is a plain dict access, so it is exact-case. `Schema.get` is
 * case-insensitive, which would make this library emit a URL for `zone` where
 * Python emits nothing, so the case check is reinstated here. `resolve` returns
 * the input unchanged exactly when the schema holds that spelling.
 *
 * @internal
 */
function resolveGroup(objType: string, schema: Schema | undefined): string | undefined {
  if (schema === undefined) return undefined;
  if (schema.resolve(objType) !== objType) return undefined;
  return schema.get(objType)?.g;
}

/**
 * Build a docs.idfkit.com URL for an object's I/O Reference page.
 *
 * Uses a bundled mapping from the documentation search index for accurate URLs.
 * Falls back to schema-based group slug construction when the object type is
 * not in the mapping.
 *
 * Returns undefined when the object type cannot be resolved or the version has
 * no documentation.
 *
 * DIVERGENCE FROM PYTHON. `idfkit.docs.io_reference_url` also takes an optional
 * schema, but when it is omitted and the mapping misses, it loads the schema for
 * the latest EnergyPlus version from disk and tries the group fallback against
 * that. Loading a schema is I/O and asynchronous here, and the `@idfkit/core`
 * root entry is neither, so this returns undefined in that case instead. Pass a
 * schema to get the fallback. The two libraries agree whenever the object type
 * is in the mapping (which is every type the search index covers) and whenever
 * a schema is supplied.
 *
 * @param objType EnergyPlus object type name, e.g. `Zone`.
 * @param version EnergyPlus version, e.g. `26.1.0`.
 * @param schema Schema for the fallback group lookup. Without it, an object
 *   type outside the bundled mapping resolves to undefined.
 * @param options `baseUrl` overrides the documentation site root, for tests.
 */
export function ioReferenceUrl(
  objType: string,
  version: string,
  schema?: Schema,
  options?: { baseUrl?: string }
): DocsUrl | undefined {
  const ver = resolveDocVersion(version);
  if (ver === undefined) return undefined;
  const baseUrl = options?.baseUrl ?? BASE_URL;
  const label = `${objType} — I/O Reference`;

  // Primary: the bundled mapping, which is accurate because it comes from the
  // documentation search index rather than from a guess about the URL shape.
  const location = docLocations().get(objType);
  if (location !== undefined) {
    return { url: `${baseUrl}/${ver}/${location}`, docSet: 'io-reference', version: ver, label };
  }

  // Fallback: derive from the schema group. May be inaccurate for some groups.
  const group = resolveGroup(objType, schema);
  if (group === undefined) return undefined;
  const slug = group.toLowerCase().replaceAll(' ', '-');
  const url = `${baseUrl}/${ver}/io-reference/overview/group-${slug}/#${objectAnchor(objType)}`;
  return { url, docSet: 'io-reference', version: ver, label };
}

/**
 * Build a docs.idfkit.com URL for the Engineering Reference landing page.
 *
 * Returns undefined if the version has no documentation.
 */
export function engineeringReferenceUrl(
  version: string,
  options?: { baseUrl?: string }
): DocsUrl | undefined {
  const ver = resolveDocVersion(version);
  if (ver === undefined) return undefined;
  return {
    url: `${options?.baseUrl ?? BASE_URL}/${ver}/engineering-reference/`,
    docSet: 'engineering-reference',
    version: ver,
    label: 'Engineering Reference',
  };
}

/**
 * Build a docs.idfkit.com URL for searching or browsing documentation.
 *
 * Links to the version's I/O Reference overview page, where the reader can
 * browse or search for the object type. Returns undefined if the version has no
 * documentation.
 */
export function searchUrl(
  query: string,
  version: string,
  options?: { baseUrl?: string }
): DocsUrl | undefined {
  const ver = resolveDocVersion(version);
  if (ver === undefined) return undefined;
  return {
    url: `${options?.baseUrl ?? BASE_URL}/${ver}/io-reference/overview/`,
    docSet: 'search',
    version: ver,
    label: `Search: ${query}`,
  };
}

/**
 * The best documentation URL for an object type.
 *
 * Tries the I/O Reference; returns undefined if the object type cannot be
 * resolved or the version has no documentation. Carries the same omitted-schema
 * divergence as {@link ioReferenceUrl}.
 */
export function docsUrlForObject(
  objType: string,
  version: string,
  schema?: Schema,
  options?: { baseUrl?: string }
): DocsUrl | undefined {
  return ioReferenceUrl(objType, version, schema, options);
}
