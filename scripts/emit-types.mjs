#!/usr/bin/env node
/**
 * Generate one opt-in type package per EnergyPlus schema version.
 *
 * WHAT THIS EXISTS FOR
 *
 * This is the piece that has no Python counterpart and is the main reason a
 * JavaScript port is worth doing rather than merely possible. The Python
 * library resolves `zone.ceiling_height` at runtime through `__getattr__`; an
 * editor cannot see through that, so nothing completes and nothing is checked.
 * Here the same information is emitted as static types, so a typo in a field
 * name is a compile error and every field, unit, and choice list is one
 * keystroke away in the editor.
 *
 * WHY IT WRITES A PACKAGE RATHER THAN A MODULE IN CORE
 *
 * The two maps are 5.3 MB of the 5.5 MB `@idfkit/core` used to weigh, so a
 * reader who never parameterised a document still paid for every EnergyPlus
 * object type in both releases. They now ship as `@idfkit/types-v26-1` and
 * `@idfkit/types-v9-4`, installed by name and by nobody who does not want them
 * (FR-039, FR-040, SC-014). Regeneration writes the whole package, not only the
 * declaration, so a split this script could quietly undo is not possible: run
 * it for a version that has no package yet and the package appears.
 *
 * WHY THE OUTPUT IS `.d.ts` AND NOT `.ts`
 *
 * A type package contains declarations only; any runtime code in one is a build
 * failure (data-model section 7, `runtime_bytes` "Must be zero"). A declaration
 * file is never compiled, so nothing here can produce a byte of JavaScript, and
 * the `export const VERSION` this script used to append — which nothing
 * imported and which quietly compiled to a 256-byte `.js` — has nowhere to go.
 *
 * TypeScript will still *accept* `export const VERSION = '26.1.0'` inside a
 * `.d.ts`; it just emits nothing for it, which makes it a phantom export that
 * crashes whoever imports it. So the file shape is a strong guard and not a
 * complete one, and `npm run check:type-packages` closes the gap: it fails on a
 * single runtime byte and on any exported value declaration.
 *
 * Usage: node scripts/emit-types.mjs [version...] [--packages <dir>] [--no-notes]
 */

import { gunzipSync } from 'node:zlib';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SCHEMA_SRC = resolve(REPO, '../idfkit/src/idfkit/schemas');

const argv = process.argv.slice(2);
const packagesFlag = argv.indexOf('--packages');
const PACKAGES = packagesFlag !== -1 ? resolve(argv[packagesFlag + 1]) : join(REPO, 'packages');
const WITH_NOTES = !argv.includes('--no-notes');
const versions = argv.filter((a) => /^\d+\.\d+\.\d+$/.test(a));
if (versions.length === 0) versions.push('26.1.0', '9.4.0');

/**
 * The peer range each generated package declares against `@idfkit/core`.
 *
 * A range, never an exact pin (FR-041). Every version in this repository is the
 * `0.0.0` placeholder the release workflow overwrites from the git tag, so a
 * caret would be degenerate here — `^0.0.0` matches `0.0.0` and nothing else —
 * and would read as a pin dressed up as a range. The floor is what the
 * placeholder can honestly state; `.github/workflows/publish.yml` stamps the
 * released floor in its place at publish time.
 *
 * The range is deliberately open above. A generated package borrows exactly one
 * type from core, `ExtensibleGroup`, and carries no runtime, so skew between
 * the two surfaces as a type error at the consumer's build and never as a
 * runtime failure (contracts/distribution.md, "Generated types, split out").
 */
const CORE_PEER_RANGE = '>=0.0.0';

/** `26.1.0` -> `V26-1-0`. */
function versionDir(version) {
  return `V${version.split('.').join('-')}`;
}

/** `26.1.0` -> `v26-1`, the version tag in the package name. */
function moduleName(version) {
  const [major, minor] = version.split('.');
  return `v${major}-${minor}`;
}

/**
 * Turn an EnergyPlus type name into a TypeScript identifier.
 * `Coil:Cooling:DX:SingleSpeed` -> `Coil_Cooling_DX_SingleSpeed`
 */
function identifier(typeName) {
  let id = typeName.replace(/[^A-Za-z0-9_$]/g, '_');
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return id;
}

const RESERVED = new Set(['default', 'function', 'new', 'delete', 'class', 'enum', 'interface']);

/** Quote a field name if it is not a bare JS identifier. */
function propertyKey(field) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field) && !RESERVED.has(field)) return field;
  return JSON.stringify(field);
}

function escapeComment(text) {
  return String(text).replace(/\*\//g, '*\\/').trim();
}

/** Render one field's TypeScript type. */
function fieldType(def) {
  let effective = def;
  let auto = false;
  if (Array.isArray(def.anyOf)) {
    const numeric = def.anyOf.find((b) => b.type === 'number');
    if (numeric) {
      effective = { ...numeric, enum: def.enum };
      auto = true;
    } else {
      effective = def.anyOf[0] ?? {};
    }
  }

  if (effective.type === 'array') return null; // handled by the extensible key

  const choices = (effective.enum ?? []).filter((v) => v !== '');
  if (effective.type === 'number' || effective.type === 'integer') {
    // `Autosize` and `Autocalculate` are legal in numeric fields, so the type
    // has to admit them or ordinary models will not typecheck.
    return auto ? "number | 'Autosize' | 'Autocalculate'" : 'number';
  }
  if (choices.length > 0 && choices.length <= 60) {
    // Union of literals, so choice fields autocomplete. Very large choice lists
    // (schedule type limits, refrigerant names) fall back to `string`: they are
    // open-ended in practice and the union hurts editor performance.
    return choices.map((c) => JSON.stringify(c)).join(' | ');
  }
  return 'string';
}

function docComment(indent, lines) {
  const kept = lines.filter((line) => line !== undefined && line !== '');
  if (kept.length === 0) return '';
  if (kept.length === 1) return `${indent}/** ${escapeComment(kept[0])} */\n`;
  return `${indent}/**\n${kept.map((l) => `${indent} * ${escapeComment(l)}`).join('\n')}\n${indent} */\n`;
}

/** The declaration file: one interface per object type, plus the map. */
function declarations(version, packageName) {
  const path = join(SCHEMA_SRC, versionDir(version), 'Energy+.schema.epJSON.gz');
  const schema = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'));
  const types = schema.properties ?? {};

  const out = [];
  out.push(`// Generated by scripts/emit-types.mjs for EnergyPlus ${version}. Do not edit.`);
  out.push(`// Regenerate with: npm run codegen -- ${version}`);
  out.push('//');
  out.push('// A declaration file on purpose: this package must contain no runtime code at all');
  out.push('// (FR-039, data-model section 7), and nothing compiles a .d.ts into any.');
  out.push('// Types and interfaces only: an exported value here would be a phantom export,');
  out.push('// and `npm run check:type-packages` fails the build on one.');
  out.push('');
  out.push("import type { ExtensibleGroup } from '@idfkit/core';");
  out.push('');

  const exported = new Map();

  for (const [typeName, raw] of Object.entries(types)) {
    const id = identifier(typeName);
    if (exported.has(id)) continue;
    exported.set(id, typeName);

    const legacy = raw.legacy_idd ?? {};
    const fieldInfo = legacy.field_info ?? {};
    const body = Object.values(raw.patternProperties ?? {})[0] ?? {};
    const props = body.properties ?? {};
    const required = new Set(body.required ?? []);
    const order = (legacy.fields ?? []).filter((f) => f !== 'name');

    out.push(
      docComment('', [
        typeName,
        WITH_NOTES ? raw.memo : undefined,
        raw.group ? `Group: ${raw.group}` : undefined,
      ]).trimEnd()
    );
    out.push(`export interface ${id} {`);

    for (const field of order) {
      const def = props[field];
      if (def === undefined) continue;
      const rendered = fieldType(def);
      if (rendered === null) continue;

      const info = fieldInfo[field] ?? {};
      const comment = docComment('  ', [
        info.field_name,
        WITH_NOTES ? def.note : undefined,
        def.units ? `Units: ${def.units}` : undefined,
        def.default !== undefined ? `Default: ${JSON.stringify(def.default)}` : undefined,
      ]);
      const optional = required.has(field) ? '' : '?';
      out.push(`${comment}  ${propertyKey(field)}${optional}: ${rendered};`);
    }

    if (legacy.extension && legacy.extensibles?.length) {
      const comment = docComment('  ', [`Repeating group: ${legacy.extensibles.join(', ')}`]);
      out.push(`${comment}  ${propertyKey(legacy.extension)}?: ExtensibleGroup[];`);
    }

    out.push('}');
    out.push('');
  }

  // The map is the only thing a caller needs to import. It is a type, so it
  // costs nothing at runtime and disappears entirely from the emitted JS.
  out.push('/**');
  out.push(` * Object type name to field interface, for EnergyPlus ${version}.`);
  out.push(' *');
  out.push(' * Parameterize a document with this to get static field checking:');
  out.push(' * ```ts');
  out.push(` * import type { TypeMap } from '${packageName}';`);
  out.push(' * const doc = await loadIdf<TypeMap>(path);');
  out.push(" * doc.all('Zone').first?.ceiling_height;  // number | 'Autosize' | 'Autocalculate' | undefined");
  out.push(' * ```');
  out.push(' */');
  out.push('export type TypeMap = {');
  for (const [id, typeName] of exported) {
    out.push(`  ${propertyKey(typeName)}: ${id};`);
  }
  out.push('};');
  out.push('');

  return { text: `${out.join('\n')}\n`, count: exported.size };
}

/**
 * The package manifest.
 *
 * No `main`, no `default` export condition, and no `dependencies`: there is
 * nothing to run and nothing to load. The only export condition is `types`,
 * which is what `import type` resolves and all any consumer needs, and it is
 * also what makes an accidental runtime entry point visible — adding one would
 * mean adding a condition that is not here.
 */
function manifest(version, packageName) {
  return {
    name: packageName,
    version: '0.0.0',
    description: `Generated TypeScript interfaces and TypeMap for EnergyPlus ${version}`,
    type: 'module',
    license: 'MIT',
    author: 'Samuel Letellier-Duchesne <developers@idfkit.com>',
    repository: {
      type: 'git',
      url: 'git+https://github.com/idfkit/idfkit-js.git',
      directory: `packages/types-${moduleName(version)}`,
    },
    homepage: 'https://js.idfkit.com/',
    bugs: { url: 'https://github.com/idfkit/idfkit-js/issues' },
    keywords: ['energyplus', 'idf', 'epjson', 'types', 'typescript'],
    types: './index.d.ts',
    exports: { '.': { types: './index.d.ts' } },
    files: ['index.d.ts', 'LICENSE'],
    publishConfig: { access: 'public' },
    engines: { node: '>=20' },
    peerDependencies: { '@idfkit/core': CORE_PEER_RANGE },
  };
}

/**
 * The package's tsconfig.
 *
 * `emitDeclarationOnly` with a single `.d.ts` input means `tsc --build` emits
 * nothing but a `.tsbuildinfo`: declaration files are not re-emitted. The
 * project exists so the solution build typechecks the generated file against
 * the `@idfkit/core` it references, not to produce anything — which is why it
 * has to turn `skipLibCheck` back off.
 */
function tsconfig() {
  // A literal, not JSON.stringify, so the output is already in the repository's
  // Prettier style and `npm run codegen` never leaves `format:check` red.
  //
  // `skipLibCheck: false` overrides the base config and is the point of having a
  // project here at all. The base turns it on, which tells TypeScript to skip
  // every `.d.ts` — including this package's only file, so with it on the
  // solution build would compile a generated declaration that references a type
  // core no longer exports and say nothing. Off, `tsc --build` reports it.
  // It costs about a second.
  return `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist",
    "emitDeclarationOnly": true,
    "declarationMap": false,
    "sourceMap": false,
    "skipLibCheck": false
  },
  "files": ["index.d.ts"],
  "references": [{ "path": "../core" }]
}
`;
}

function readme(version, packageName) {
  return `# ${packageName}

Generated TypeScript interfaces and a \`TypeMap\` for EnergyPlus ${version}.

Opt-in. \`@idfkit/core\` is fully usable without it: a document with no map is
typed permissively rather than not at all, so nothing here is needed to read,
edit, or write a model (FR-040, SC-014). Install it when you want the editor to
complete field names and check them for one EnergyPlus version.

\`\`\`bash
npm install --save-dev ${packageName}
\`\`\`

\`\`\`ts
import { loadIdf } from '@idfkit/core/node';
import type { TypeMap } from '${packageName}';

const doc = await loadIdf<TypeMap>('model.idf');
doc.all('Zone').first?.ceiling_height; // number | 'Autosize' | 'Autocalculate' | undefined
\`\`\`

## What is in here

One \`index.d.ts\`. No JavaScript, no \`main\`, no dependencies: the package is
declarations and nothing else, and CI fails the build if a single runtime byte
appears in it (\`npm run check:type-packages\`).

## Versioning

\`@idfkit/core\` is a **peer range**, not a pin. The map borrows one type from
core, \`ExtensibleGroup\`, and carries no runtime, so a version skew between the
two is a type error at your build and never a failure at run time. Pick the
package whose version tag matches the EnergyPlus release you are reading; the
core you install alongside it does not have to match anything.

## Regenerating

\`\`\`bash
npm run codegen -- ${version}
\`\`\`

Run from the repository root, against the schemas in the sibling \`idfkit\`
Python checkout. Do not edit \`index.d.ts\` by hand.

## License

MIT
`;
}

function emitVersion(version) {
  const tag = moduleName(version);
  const packageName = `@idfkit/types-${tag}`;
  const dir = join(PACKAGES, `types-${tag}`);
  mkdirSync(dir, { recursive: true });

  const { text, count } = declarations(version, packageName);
  const file = join(dir, 'index.d.ts');
  writeFileSync(file, text);

  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(manifest(version, packageName), null, 2)}\n`
  );
  writeFileSync(join(dir, 'tsconfig.json'), tsconfig());
  writeFileSync(join(dir, 'README.md'), readme(version, packageName));

  // One licence text, copied rather than restated, so the packages cannot drift
  // apart on the one file a consumer is entitled to read verbatim.
  const license = join(dir, 'LICENSE');
  if (!existsSync(license)) copyFileSync(join(PACKAGES, 'core', 'LICENSE'), license);

  return { packageName, file, bytes: text.length, count };
}

for (const version of versions) {
  const { packageName, file, bytes, count } = emitVersion(version);
  console.log(
    `${version}  ${count} types  ${(bytes / 1024).toFixed(0)} KB  -> ${packageName} (${file})`
  );
}

console.log(
  '\nA new version also needs a { "path": "./packages/types-<tag>" } reference in tsconfig.json' +
    ' and an entry in the publish loop in .github/workflows/publish.yml.'
);
