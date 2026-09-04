#!/usr/bin/env node
/**
 * The facade gate for `idfkit`, the shared install name (tasks T090 to T095).
 *
 * WHAT THE FACADE IS
 *
 * `packages/idfkit/` contains no implementation. It is a manifest and ten
 * one-line-ish re-export files, so that `npm install idfkit` gives a working
 * library without the reader ever learning the scoped names, while the scoped
 * packages stay published and stay the real implementations (FR-036, FR-037).
 * Its whole content is therefore its published *surface*, and a surface is
 * exactly the kind of thing that goes wrong quietly.
 *
 * WHY THIS GATE EXISTS
 *
 * Four failures, each cheap to make and none of them noisy:
 *
 *   1. A DEAD SUBPATH (FR-077). The naming register reserves names for
 *      capabilities that do not exist yet. A reserved name that finds its way
 *      into this export map ships a subpath that resolves to nothing: `npm
 *      install idfkit` succeeds, `import 'idfkit/results'` fails at run time,
 *      and the failure lands on the reader rather than on CI. The export map is
 *      therefore pinned to exactly the four entries in
 *      `contracts/distribution.md` plus the `./language` entry added by
 *      `005-idf-language-service/contracts/language-service.md`, and every one
 *      of them must resolve to a package that is really there.
 *
 *   2. AN OPT-IN COMPONENT STOPS BEING OPT-IN (FR-043, SC-016, SC-015). Moving
 *      `@idfkit/weather` or `@idfkit/language` from `peerDependencies` into
 *      `dependencies` is a one-word edit that no test would notice, and it puts
 *      a 1.6 MB station index, or a language service nobody without an editor
 *      can use, on disk for every reader who never asked for either.
 *      `optionalDependencies` is not the mechanism either despite the name: npm
 *      installs those by default and merely tolerates failure.
 *
 *   3. THE ENGINE ARRIVES (FR-070). `@idfkit/engine-assets` is 51 MB of
 *      WebAssembly and datasets, and it versions on the EnergyPlus release it
 *      bundles rather than on this library. One `dependencies` entry, or one
 *      helpful `./engine` subpath, breaks the install-size and bundle-purity
 *      criteria at a stroke and pins every facade user to one engine version.
 *
 *   4. AN OPT-IN SHIM DRIFTS (FR-074, FR-046). `weather.js` and `language.js`
 *      cannot use `export *`, because the whole point of them is to catch the
 *      missing-peer failure and name the install, and a static re-export is
 *      linked before any code in them runs. So they write the names out. A name
 *      added to `@idfkit/weather` then exists under `@idfkit/weather` and not
 *      under `idfkit/weather`, with the types insisting otherwise, and nothing
 *      says so. This gate reads both surfaces and fails on any difference.
 *
 * WHAT IT READS
 *
 *   packages/idfkit/package.json     the export map, the dependency shape
 *   packages/idfkit/*.js, *.d.ts     the specifier each subpath re-exports
 *   node_modules, walking up         whether each specifier resolves
 *   each optional peer               its real runtime exports, for the drift check
 *
 * Resolution is done by hand rather than through `import.meta.resolve` so a
 * failure can say which package was missing and where it looked, and so the
 * check is the same on a workspace and on an installed tree.
 *
 * EXIT CODES, the same contract the naming, parity and type-package gates use:
 *
 *   0  the facade is exactly the contracted surface
 *   1  at least one finding, one line each
 *   2  the gate could not run
 *
 * Plain ESM, no dependencies.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FACADE = join(REPO, 'packages', 'idfkit');

/**
 * The export map: `contracts/distribution.md` verbatim, plus `./language` from
 * `005-idf-language-service/contracts/language-service.md`.
 *
 * Subpath -> the specifier it must re-export. Both halves are pinned: a sixth
 * entry is a dead subpath waiting to happen, and one of these five pointing
 * somewhere else is a silent rename of the public surface.
 */
const CONTRACTED = new Map([
  ['.', '@idfkit/core'],
  ['./language', '@idfkit/language'],
  ['./node', '@idfkit/core/node'],
  ['./schemas', '@idfkit/schemas'],
  ['./weather', '@idfkit/weather'],
]);

/** Plain `dependencies`, always installed, never optional (FR-042, T094). */
const REQUIRED_DEPENDENCIES = ['@idfkit/core', '@idfkit/schemas'];

/**
 * The opt-in components, and the only legal `peerDependencies` entries.
 *
 * Each is a package the shared name reaches through a guarded shim rather than
 * a static re-export, so each carries the two things this gate checks about a
 * shim: the install it must name, and the file whose written-out names are held
 * against the package's real surface.
 */
const OPTIONAL_PEERS = [
  {
    name: '@idfkit/weather',
    file: 'weather.js',
    install: 'npm install @idfkit/weather',
    why:
      'This is what keeps the 1.6 MB station index off disk under the shared name ' +
      '(FR-043, SC-016).',
  },
  {
    name: '@idfkit/language',
    file: 'language.js',
    install: 'npm install @idfkit/language',
    why:
      'This is what keeps the language service off disk for the readers who never open an ' +
      'editor, which is what leaves the install-size budget satisfied with no amendment ' +
      '(FR-046, SC-015).',
  },
];

/** Not a subpath, not a dependency, not an optional peer (FR-070). */
const BANNED = ['@idfkit/engine', '@idfkit/engine-assets'];

/** Install-time scripting, rejected outright (FR-042, SC-015). */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

/** `export * from '<specifier>'` and `export { ... } from '<specifier>'`. */
const REEXPORT = /^\s*export\s+(?:\*|type\s+\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm;

/** `await import('<specifier>')`, which is how weather.js reaches its peer. */
const DYNAMIC_IMPORT = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** `export const <name> =`, which is how weather.js writes its names out. */
const NAMED_CONST = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=/gm;

class Finding {
  constructor(message, detail) {
    this.message = message;
    this.detail = detail;
  }
}

class CannotRun extends Error {}

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new CannotRun(`cannot read ${relative(REPO, path)}: ${error.message}`);
  }
}

function readManifest(path) {
  try {
    return JSON.parse(read(path));
  } catch (error) {
    if (error instanceof CannotRun) throw error;
    throw new CannotRun(`${relative(REPO, path)} is not valid JSON: ${error.message}`);
  }
}

/** Split `@scope/name/sub/path` into its package name and its subpath key. */
function splitSpecifier(specifier) {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const rest = specifier.slice(name.length);
  return { name, subpath: rest === '' ? '.' : `.${rest}` };
}

/**
 * Where a package's `package.json` lives, walking `node_modules` up from `from`.
 *
 * Returns null when nothing is installed under that name, which is the finding
 * FR-077 is about: a subpath in the map with no package behind it.
 */
function findPackage(name, from) {
  const looked = [];
  let dir = from;
  for (;;) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    looked.push(relative(REPO, candidate));
    if (existsSync(candidate))
      return { manifest: readManifest(candidate), dir: dirname(candidate) };
    const parent = dirname(dir);
    if (parent === dir) return { manifest: null, looked };
    dir = parent;
  }
}

/** Every string target under an `exports` value, whatever its condition nesting. */
function targetsOf(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(targetsOf);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(targetsOf);
  return [];
}

/**
 * Whether a resolved package really exposes a subpath, and its file is on disk.
 *
 * A package that exists but does not export the subpath is the same defect as a
 * package that is not installed: the import fails at the reader's machine.
 */
function subpathResolves(pkg, subpath) {
  const map = pkg.manifest.exports;
  if (map === undefined) {
    // No exports map: legacy resolution. `.` is main or index.js, and nothing else is pinned.
    return subpath === '.';
  }
  const conditionsOnly =
    typeof map === 'string' || Object.keys(map).every((key) => !key.startsWith('.'));
  const value = conditionsOnly ? (subpath === '.' ? map : undefined) : map[subpath];
  if (value === undefined) return false;
  const targets = targetsOf(value).filter((target) => target.startsWith('./'));
  return targets.length > 0 && targets.some((target) => existsSync(join(pkg.dir, target)));
}

/** The specifiers a re-export file names, in source order. */
function reexportedSpecifiers(text) {
  return [...text.matchAll(REEXPORT)].map((match) => match[1]);
}

function checkExportMap(manifest, findings) {
  const map = manifest.exports ?? {};
  const declared = Object.keys(map);
  const contracted = [...CONTRACTED.keys()];

  const extra = declared.filter((key) => !CONTRACTED.has(key));
  const missing = contracted.filter((key) => !declared.includes(key));

  if (extra.length > 0) {
    findings.push(
      new Finding(
        `the export map has ${extra.length} entry beyond the contract: ${extra.join(', ')}`,
        'contracts/distribution.md, plus the ./language entry, pins the facade to exactly ' +
          `${contracted.join(', ')}. A sixth subpath is how a name reserved in the register ` +
          'leaks into the published surface as a subpath that resolves to nothing (FR-077).'
      )
    );
  }
  if (missing.length > 0) {
    findings.push(
      new Finding(
        `the export map is missing ${missing.join(', ')}`,
        'All five subpaths are mandatory. A flat facade with one eager entry point drags the ' +
          'schema data and the station index into every browser bundle (FR-038).'
      )
    );
  }
  return { declared, extra, missing };
}

/** Each declared subpath, resolved through its target files to a real package. */
function checkSubpathTargets(manifest, findings) {
  const map = manifest.exports ?? {};
  const specifiersBySubpath = new Map();

  for (const [subpath, value] of Object.entries(map)) {
    const targets = targetsOf(value);
    if (targets.length === 0) {
      findings.push(new Finding(`${subpath} names no target file`, 'An empty exports entry.'));
      continue;
    }

    const files = manifest.files ?? [];
    for (const target of targets) {
      const path = join(FACADE, target);
      if (!existsSync(path)) {
        findings.push(
          new Finding(
            `${subpath} points at ${target}, which is not on disk`,
            'A subpath with nothing behind it fails at the reader, never here.'
          )
        );
        continue;
      }
      const listed = target.replace(/^\.\//, '');
      if (files.length > 0 && !files.includes(listed)) {
        findings.push(
          new Finding(
            `${subpath} points at ${target}, which "files" does not ship`,
            `It resolves in this repository and is absent from the tarball. "files" lists: ${files.join(', ')}.`
          )
        );
      }

      const source = read(path);
      const specifiers = new Set(reexportedSpecifiers(source));
      for (const match of source.matchAll(DYNAMIC_IMPORT)) specifiers.add(match[1]);
      if (specifiers.size === 0) {
        findings.push(
          new Finding(
            `${target} re-exports nothing`,
            'The facade contains no implementation; every shipped file is a re-export.'
          )
        );
        continue;
      }
      if (specifiers.size > 1) {
        findings.push(
          new Finding(
            `${target} reaches ${specifiers.size} packages: ${[...specifiers].join(', ')}`,
            'One subpath, one re-exported package. Anything else is implementation.'
          )
        );
      }
      for (const specifier of specifiers) {
        const existing = specifiersBySubpath.get(subpath) ?? new Set();
        existing.add(specifier);
        specifiersBySubpath.set(subpath, existing);
      }
    }
  }

  // The contracted target, and that it is really installable.
  for (const [subpath, expected] of CONTRACTED) {
    const found = specifiersBySubpath.get(subpath);
    if (found === undefined) continue; // already reported as missing or unresolvable
    if (!found.has(expected)) {
      findings.push(
        new Finding(
          `${subpath} re-exports ${[...found].join(', ')} rather than ${expected}`,
          'contracts/distribution.md fixes what each subpath means. Changing it renames the ' +
            'public surface without renaming anything visible.'
        )
      );
    }
  }

  const resolved = [];
  for (const [subpath, specifiers] of specifiersBySubpath) {
    for (const specifier of specifiers) {
      const { name, subpath: inner } = splitSpecifier(specifier);
      const pkg = findPackage(name, FACADE);
      if (pkg.manifest === null) {
        findings.push(
          new Finding(
            `${subpath} re-exports ${specifier}, and no package named ${name} is installed`,
            `A subpath that resolves to nothing is a dead subpath (FR-077). Looked in: ${pkg.looked.slice(0, 3).join(', ')}, ...`
          )
        );
        continue;
      }
      if (!subpathResolves(pkg, inner)) {
        findings.push(
          new Finding(
            `${subpath} re-exports ${specifier}, and ${name} does not export ${inner}`,
            'The package is installed but that entry point is not in its exports map, so the ' +
              'import fails at the reader with ERR_PACKAGE_PATH_NOT_EXPORTED.'
          )
        );
        continue;
      }
      resolved.push({ subpath, specifier, version: pkg.manifest.version });
    }
  }
  return resolved;
}

function checkDependencyShape(manifest, findings) {
  const dependencies = manifest.dependencies ?? {};
  const optional = manifest.optionalDependencies ?? {};
  const peers = manifest.peerDependencies ?? {};
  const meta = manifest.peerDependenciesMeta ?? {};

  for (const name of REQUIRED_DEPENDENCIES) {
    if (dependencies[name] === undefined) {
      findings.push(
        new Finding(
          `${name} is not a plain "dependencies" entry`,
          'Core and schemas are what makes the shared name a working library without the ' +
            'reader knowing the scoped names. Not peerDependencies, and not ' +
            'optionalDependencies (FR-036, T094).'
        )
      );
    }
  }

  if (Object.keys(optional).length > 0) {
    findings.push(
      new Finding(
        `optionalDependencies is not empty: ${Object.keys(optional).join(', ')}`,
        'optionalDependencies is not the opt-in mechanism despite the name: npm installs them ' +
          'by default and merely tolerates failure. The opt-in mechanism is an optional peer.'
      )
    );
  }

  const peerNames = Object.keys(peers);
  for (const peer of OPTIONAL_PEERS) {
    if (!peerNames.includes(peer.name)) {
      findings.push(new Finding(`${peer.name} is not a "peerDependencies" entry`, peer.why));
    } else if (meta[peer.name]?.optional !== true) {
      findings.push(
        new Finding(
          `${peer.name} is a peer dependency but is not marked optional`,
          `Without \`"peerDependenciesMeta": { "${peer.name}": { "optional": true } }\` npm 7+ ` +
            'auto-installs the peer, and it is back on disk for everyone (FR-043, FR-046).'
        )
      );
    }
    if (dependencies[peer.name] !== undefined || optional[peer.name] !== undefined) {
      findings.push(
        new Finding(
          `${peer.name} is also declared as a dependency`,
          'Then it installs, and the optional peer declaration means nothing.'
        )
      );
    }
  }
  const expectedPeers = OPTIONAL_PEERS.map((peer) => peer.name);
  for (const extra of peerNames.filter((name) => !expectedPeers.includes(name))) {
    findings.push(
      new Finding(
        `${extra} is an unexpected peer dependency`,
        `Weather and the language service are the opt-in components of the shared name. ` +
          'Anything else here is either a dependency the reader should not have to know about, ' +
          'or a component that needs its own decision.'
      )
    );
  }

  const scripts = Object.keys(manifest.scripts ?? {}).filter((s) => INSTALL_SCRIPTS.includes(s));
  if (scripts.length > 0) {
    findings.push(
      new Finding(
        `declares an install script: ${scripts.join(', ')}`,
        'Install-time scripting is rejected outright (FR-042): it is silently skipped under ' +
          '--ignore-scripts and in many CI environments, so anything it produces is absent ' +
          'exactly where the failure is hardest to see.'
      )
    );
  }
}

/**
 * The engine, in any of the three places it could arrive (FR-070).
 *
 * Manifest, export map, and the transitive closure of what the facade depends
 * on, so an engine dependency added one level down is caught as well.
 */
function checkNoEngine(manifest, findings) {
  const declared = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
  };
  for (const banned of BANNED) {
    if (declared[banned] !== undefined) {
      findings.push(
        new Finding(
          `${banned} is in the facade's dependencies`,
          '@idfkit/engine-assets is 51 MB, and the two version on different clocks by design ' +
            '(FR-070). Browser simulation is installed by name.'
        )
      );
    }
  }
  for (const subpath of Object.keys(manifest.exports ?? {})) {
    if (subpath.includes('engine')) {
      findings.push(
        new Finding(
          `${subpath} is an engine subpath`,
          'The engine is not a subpath of the shared name (FR-070).'
        )
      );
    }
  }

  // Transitive: walk what the facade requires, from the installed tree.
  const seen = new Set();
  const queue = Object.keys(manifest.dependencies ?? {});
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    if (BANNED.includes(name)) {
      findings.push(
        new Finding(
          `${name} is in the facade's transitive dependency tree`,
          'Reached through ' +
            `${[...seen].join(' -> ')}. Nothing the shared name installs may pull in the engine (FR-070).`
        )
      );
      continue;
    }
    const pkg = findPackage(name, FACADE);
    if (pkg.manifest === null) continue;
    queue.push(...Object.keys(pkg.manifest.dependencies ?? {}));
  }
  return seen;
}

/**
 * One opt-in shim: it names its install, and its written-out names are the
 * peer's real ones.
 *
 * The same three failures apply to every shim, which is why this is a loop over
 * OPTIONAL_PEERS rather than one function per component. A second copy of this
 * check written for the language subpath would be the place the two drift apart.
 *
 * Only runtime values are compared. Both `.d.ts` twins are the plain
 * `export * from`, so the type-only names of a peer are re-exported whole and
 * have nothing to write out here.
 */
async function checkShim(peer, findings) {
  const path = join(FACADE, peer.file);
  if (!existsSync(path)) {
    findings.push(
      new Finding(`${peer.file} is missing`, `The subpath re-exporting ${peer.name} has no target.`)
    );
    return;
  }
  const text = read(path);

  if (!text.includes(peer.install)) {
    findings.push(
      new Finding(
        `${peer.file} does not name "${peer.install}"`,
        'FR-074 and FR-046: importing an absent opt-in component must fail with a message ' +
          'naming the component to install, rather than a bare unresolved-module error.'
      )
    );
  }
  REEXPORT.lastIndex = 0;
  if (REEXPORT.test(text)) {
    findings.push(
      new Finding(
        `${peer.file} uses a static re-export`,
        `A static \`export * from "${peer.name}"\` is linked before any code in this file ` +
          'runs, so the guard never executes and the reader gets ERR_MODULE_NOT_FOUND ' +
          'instead of the install command (FR-074, FR-046).'
      )
    );
  }
  REEXPORT.lastIndex = 0;

  const written = new Set([...text.matchAll(NAMED_CONST)].map((match) => match[1]));
  if (written.size === 0) {
    findings.push(new Finding(`${peer.file} re-exports no names`, 'The subpath would be empty.'));
    return;
  }

  const pkg = findPackage(peer.name, FACADE);
  if (pkg.manifest === null) {
    throw new CannotRun(
      `${peer.name} is not installed, so the shim's names cannot be checked against it. ` +
        'It is an optional peer for consumers and a workspace package here; run `npm install`.'
    );
  }
  let real;
  try {
    real = new Set(Object.keys(await import(pathToFileURL(join(pkg.dir, 'dist/index.js')).href)));
  } catch (error) {
    throw new CannotRun(
      `cannot load ${peer.name} to read its exports: ${error.message}. Run \`npx tsc --build\`.`
    );
  }

  const dropped = [...real].filter((name) => !written.has(name)).sort();
  const invented = [...written].filter((name) => !real.has(name)).sort();
  const types = peer.file.replace(/\.js$/, '.d.ts');
  if (dropped.length > 0) {
    findings.push(
      new Finding(
        `${peer.file} is missing ${dropped.length} of ${peer.name}'s exports: ${dropped.join(', ')}`,
        `${types} re-exports the peer whole, so these type-check under the subpath and are ` +
          `undefined at run time. Add them to ${peer.file}.`
      )
    );
  }
  if (invented.length > 0) {
    findings.push(
      new Finding(
        `${peer.file} exports ${invented.join(', ')}, which ${peer.name} does not`,
        'Each is undefined at run time.'
      )
    );
  }
  return { peer, written: written.size, real: real.size };
}

async function main() {
  if (!existsSync(join(FACADE, 'package.json'))) {
    throw new CannotRun(`no ${relative(REPO, FACADE)}/package.json`);
  }
  const manifest = readManifest(join(FACADE, 'package.json'));
  const findings = [];

  const map = checkExportMap(manifest, findings);
  const resolved = checkSubpathTargets(manifest, findings);
  checkDependencyShape(manifest, findings);
  const tree = checkNoEngine(manifest, findings);
  const shims = [];
  for (const peer of OPTIONAL_PEERS) {
    const shim = await checkShim(peer, findings);
    if (shim !== undefined) shims.push(shim);
  }

  console.log('idfkit-js facade gate');
  console.log(`  package      ${manifest.name}@${manifest.version}`);
  console.log(
    `  subpaths     ${map.declared.length} declared, ${CONTRACTED.size} contracted` +
      `${map.extra.length + map.missing.length === 0 ? ' (exact)' : ''}`
  );
  for (const [subpath, specifier] of CONTRACTED) {
    const hit = resolved.find((entry) => entry.subpath === subpath);
    console.log(
      `    ${subpath.padEnd(10)} -> ${specifier.padEnd(20)} ` +
        (hit ? `resolved (${hit.version})` : 'UNRESOLVED')
    );
  }
  console.log(`  dependencies ${Object.keys(manifest.dependencies ?? {}).join(', ') || 'none'}`);
  const peerNames = Object.keys(manifest.peerDependencies ?? {});
  console.log(peerNames.length === 0 ? '  optional peers none' : '  optional peers');
  for (const name of peerNames) {
    console.log(
      `    ${name.padEnd(20)} optional: ${manifest.peerDependenciesMeta?.[name]?.optional === true}`
    );
  }
  console.log(`  dep tree     ${tree.size} packages, none of ${BANNED.join(', ')}`);
  for (const shim of shims) {
    console.log(
      `  ${shim.peer.file.padEnd(12)} ${shim.written} names re-exported, ${shim.real} in the peer`
    );
  }
  console.log('');

  if (findings.length === 0) {
    console.log('PASS: the facade is exactly the contracted surface.');
    return 0;
  }
  console.log(`${findings.length} finding${findings.length === 1 ? '' : 's'}`);
  for (const finding of findings) {
    console.log(`\n  ${finding.message}`);
    console.log(`      ${finding.detail}`);
  }
  console.log('\nFAIL: the facade is not the surface contracts/distribution.md describes.');
  return 1;
}

try {
  process.exit(await main());
} catch (error) {
  if (error instanceof CannotRun) {
    console.error(`facade gate could not run: ${error.message}`);
    process.exit(2);
  }
  throw error;
}
