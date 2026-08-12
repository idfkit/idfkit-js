#!/usr/bin/env node
/**
 * Build the content-addressed schema bundle from idfkit's bundled epJSON schemas.
 *
 * 87% of object-type definitions are byte-identical across EnergyPlus versions
 * (Zone has not changed since 8.9), so the bundle stores each unique definition
 * once and gives every version a manifest of `typeName -> hash`. Supporting all
 * 17 versions therefore costs barely more than supporting one.
 *
 * Usage: node scripts/build.mjs [--source <dir>]
 */

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const OUT = join(PKG, 'data');

const argv = process.argv.slice(2);
const sourceFlag = argv.indexOf('--source');
const SOURCE =
  sourceFlag !== -1
    ? resolve(argv[sourceFlag + 1])
    : resolve(PKG, '../../../idfkit/src/idfkit/schemas');

/** Directory name (`V26-1-0`) to semantic version (`26.1.0`). */
function dirToVersion(dir) {
  const [major, minor, patch] = dir.slice(1).split('-');
  return `${Number(major)}.${Number(minor)}.${Number(patch)}`;
}

/** Sort key so 8.9.0 < 9.0.1 < 22.1.0, which plain string sort gets wrong. */
function versionKey(v) {
  const [a, b, c] = v.split('.').map(Number);
  return a * 1_000_000 + b * 1_000 + c;
}

/**
 * Collapse a raw epJSON object-type definition into the slim form.
 * Everything dropped here is documentation metadata, not parsing metadata.
 */
function slimType(raw) {
  const legacy = raw.legacy_idd ?? {};
  const out = {};

  out.f = legacy.fields ?? [];

  const body = Object.values(raw.patternProperties ?? {})[0] ?? {};
  const props = body.properties ?? {};
  const slimProps = {};
  for (const [fieldName, def] of Object.entries(props)) {
    slimProps[fieldName] = slimField(def);
  }
  out.p = slimProps;
  if (body.required?.length) out.r = body.required;

  const name = raw.name;
  if (name) {
    if (name.reference?.length) out.nref = name.reference;
    if (name.is_required) out.nreq = 1;
  } else {
    out.anon = 1;
  }

  if (raw.maxProperties === 1) out.s = 1;
  if (legacy.extension && legacy.extensibles?.length) {
    // The inner field definitions live on the array's `items`, not alongside
    // the fixed fields. Without them the parser has no way to know that a
    // vertex coordinate is a number, and every extensible value round-trips
    // as a string.
    const items = props[legacy.extension]?.items?.properties ?? {};
    const inner = {};
    for (const fieldName of legacy.extensibles) {
      inner[fieldName] = slimField(items[fieldName] ?? {});
    }
    out.x = { key: legacy.extension, fields: legacy.extensibles, p: inner };
  }
  if (raw.group) out.g = raw.group;

  return out;
}

function slimField(def) {
  const out = {};

  // `anyOf` means "a number, or the literal Autosize/Autocalculate". Collapse it
  // to the numeric branch plus a flag, so the writer knows both are legal.
  let effective = def;
  if (Array.isArray(def.anyOf)) {
    const numeric = def.anyOf.find((b) => b.type === 'number');
    if (numeric) {
      effective = { ...numeric, ...pick(def, ['units', 'default', 'object_list', 'reference']) };
      out.auto = 1;
    } else {
      effective = { ...def.anyOf[0], ...pick(def, ['units', 'default']) };
    }
  }

  // Integers arrive two ways: `"type": "integer"` directly, or `"type":
  // "number"` carrying `"data_type": "integer"`. Both appear in the schema and
  // missing either one leaves the value as an uncoerced string.
  if (effective.type === 'array') {
    out.t = 'arr';
  } else if (effective.type === 'integer') {
    out.t = 'i';
  } else if (effective.type === 'number') {
    out.t = effective.data_type === 'integer' ? 'i' : 'n';
  } else {
    out.t = 'a';
  }

  if (effective.object_list?.length) out.ol = effective.object_list;
  if (effective.reference?.length) out.ref = effective.reference;
  if (effective.enum?.length) out.e = effective.enum.filter((v) => v !== '');
  if (effective.default !== undefined) out.d = effective.default;
  if (effective.minimum !== undefined) out.min = effective.minimum;
  if (effective.maximum !== undefined) out.max = effective.maximum;
  if (effective.exclusiveMinimum !== undefined) out.xmin = effective.exclusiveMinimum;
  if (effective.exclusiveMaximum !== undefined) out.xmax = effective.exclusiveMaximum;
  if (effective.units) out.u = effective.units;
  if (effective.retaincase) out.rc = 1;

  if (out.e && out.e.length === 0) delete out.e;
  return out;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/**
 * Deterministic serialization. The hash is the storage key, so it must be
 * stable across rebuilds or every regeneration churns the whole bundle and the
 * diff becomes unreadable. Sorted keys, fixed separators, no whitespace.
 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function main() {
  const dirs = readdirSync(SOURCE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^V\d+-\d+-\d+$/.test(e.name))
    .map((e) => e.name);

  if (dirs.length === 0) {
    console.error(`No schema directories found under ${SOURCE}`);
    process.exit(1);
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  /** hash -> canonical JSON text of one object-type definition. */
  const blobs = new Map();
  const manifests = {};
  const versions = [];

  for (const dir of dirs) {
    const version = dirToVersion(dir);
    versions.push(version);

    const gz = readFileSync(join(SOURCE, dir, 'Energy+.schema.epJSON.gz'));
    const schema = JSON.parse(gunzipSync(gz).toString('utf8'));

    const manifest = {};
    for (const [typeName, rawType] of Object.entries(schema.properties ?? {})) {
      const text = canonical(slimType(rawType));
      const h = hash(text);
      if (!blobs.has(h)) blobs.set(h, text);
      manifest[typeName] = h;
    }
    manifests[version] = manifest;
  }

  versions.sort((a, b) => versionKey(a) - versionKey(b));

  // One blob store for every version. Sorted by hash so the file is stable.
  const store = {};
  for (const h of [...blobs.keys()].sort()) store[h] = JSON.parse(blobs.get(h));
  writeBundleFile('types.json', store);

  const manifestFiles = {};
  for (const version of versions) {
    const fileName = `manifest-${version.replace(/\./g, '-')}.json`;
    writeBundleFile(fileName, manifests[version]);
    manifestFiles[version] = fileName;
  }

  writeBundleFile('index.json', { versions, manifests: manifestFiles });

  const totalDefs = Object.values(manifests).reduce((n, m) => n + Object.keys(m).length, 0);
  const gzTotal = readdirSync(OUT)
    .filter((f) => f.endsWith('.gz'))
    .reduce((n, f) => n + readFileSync(join(OUT, f)).length, 0);

  console.log(`versions        ${versions.length} (${versions[0]} .. ${versions.at(-1)})`);
  console.log(`type defs       ${totalDefs}`);
  console.log(`unique defs     ${blobs.size} (${((100 * blobs.size) / totalDefs).toFixed(1)}%)`);
  console.log(`bundle on disk  ${(gzTotal / 1024).toFixed(1)} KB gzipped`);
}

/**
 * Write one bundle file, gzipped only.
 *
 * The raw JSON is never shipped: Node inflates in-process (faster than the
 * extra disk read) and browsers inflate with `DecompressionStream`, which is
 * baseline-available. Shipping both would double the package for no benefit.
 */
function writeBundleFile(name, value) {
  const text = canonical(value);
  writeFileSync(join(OUT, `${name}.gz`), gzipSync(Buffer.from(text), { level: 9 }));
}

main();
