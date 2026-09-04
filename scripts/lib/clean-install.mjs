/**
 * The shared machinery behind the distribution gates (tasks T096 to T100).
 *
 * WHAT A "CLEAN INSTALL" HAS TO MEAN HERE
 *
 * Five of the criteria in `contracts/distribution.md` are statements about what
 * `npm install idfkit` puts on a stranger's disk: under 1.75 MB (SC-012), zero
 * station-index bytes (SC-016), zero type-package bytes (SC-014), no
 * post-install scripting (SC-015), and a browser bundle that pulls in none of
 * the data (SC-013). None of them can be measured against this workspace. A
 * workspace install is a tree of symlinks into `packages/`, so it contains
 * every byte of everything, including the 5.3 MB of generated declarations the
 * split exists to keep out.
 *
 * So each gate builds a real install, and there are only three ways to get one:
 *
 *   from the registry     impossible: nothing is published under these names,
 *                         and `idfkit` cannot currently be registered at all
 *                         (npm's similarity filter; an appeal is pending);
 *   from the workspace    wrong: `file:` links to `packages/*` are symlinks,
 *                         and measuring a symlink measures nothing;
 *   from `npm pack`       right: the tarball is byte-for-byte what the registry
 *                         would serve, because it is what would be uploaded.
 *
 * Hence `packWorkspaces()` below. Every gate packs, installs the tarballs into
 * an isolated project, and measures that.
 *
 * WHY THE ISOLATION IS NOT PARANOIA
 *
 * Node resolves `node_modules` by walking UP from the importing file to the
 * filesystem root. A fixture created inside this repository therefore resolves
 * `@idfkit/weather` through the workspace's own `node_modules` even when the
 * fixture never installed it, and a check asserting the peer is absent passes
 * while the peer is right there. This is not hypothetical: it produced a false
 * green during the design of these gates.
 *
 * `fixtureRoot()` therefore builds under the system temp directory and
 * `assertIsolated()` walks every ancestor to the root, refusing to run if any
 * of them carries a `node_modules` or a `package.json`. And the gates never
 * infer absence from "npm did not install it": they run `resolveFrom()`, which
 * asks Node itself to resolve the specifier from inside the fixture and
 * requires the resolution to FAIL. An absence you did not try to resolve is an
 * absence you did not check.
 *
 * NO CACHING, DELIBERATELY
 *
 * Packing all six workspace packages costs a couple of seconds and every gate
 * pays it. A cache keyed on mtimes would be faster and would occasionally
 * measure a tree that no longer exists; a verification tool that reports on
 * stale evidence is worse than a slow one.
 *
 * EXIT CONTRACT, shared with the naming, parity, type-package and facade gates:
 *
 *   0  the criterion holds
 *   1  at least one finding, one line each
 *   2  the gate could not run
 *
 * `CannotRun` is exit 2. Anything else thrown is a bug in the gate and is left
 * to crash with its stack, which is the honest outcome.
 *
 * Plain ESM, no dependencies beyond the toolchain the repository already has.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { lstatSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Exit 2. The gate could not establish the evidence it needs, either way. */
export class CannotRun extends Error {}

/** One line of a gate's verdict. `message` is the finding; `detail` is why it matters. */
export class Finding {
  constructor(message, detail) {
    this.message = message;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// The workspace, packed
// ---------------------------------------------------------------------------

/** Every workspace package, by manifest name. */
export function workspacePackages() {
  const dir = join(REPO, 'packages');
  if (!existsSync(dir)) throw new CannotRun(`no ${relative(REPO, dir)} directory under ${REPO}`);
  const found = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new CannotRun(`packages/${entry.name}/package.json is not valid JSON: ${error.message}`);
    }
    found.set(manifest.name, { manifest, dir: join(dir, entry.name), manifestPath });
  }
  if (found.size === 0) throw new CannotRun(`no packages found under ${relative(REPO, dir)}`);
  return found;
}

/** The filename `npm pack` gives a package: `@scope/name` at 1.2.3 -> scope-name-1.2.3.tgz. */
function tarballName(name, version) {
  return `${name.replace(/^@/, '').replace(/\//g, '-')}-${version}.tgz`;
}

/**
 * `npm pack` every workspace package into `into`, and return name -> tarball path.
 *
 * The build has to have happened first. Every package ships `dist`, none of
 * them declares a `prepack` script, so `npm pack` copies whatever is on disk:
 * pack before `tsc --build` and you get a tarball with no runtime in it, which
 * every gate downstream would then cheerfully measure.
 */
export function packWorkspaces(into) {
  const packages = workspacePackages();
  for (const [name, entry] of packages) {
    const main = entry.manifest.exports?.['.'];
    const target = typeof main === 'string' ? main : (main?.default ?? main?.types);
    if (typeof target === 'string' && target.startsWith('./dist/') && !existsSync(join(entry.dir, target))) {
      throw new CannotRun(
        `${name} has not been built: ${relative(REPO, join(entry.dir, target))} is missing.\n` +
          'Run `npx tsc --build` first. A tarball packed before the build has no runtime in it, ' +
          'and every measurement taken from it would be wrong in the flattering direction.'
      );
    }
  }

  mkdirSync(into, { recursive: true });
  try {
    execFileSync('npm', ['pack', '--workspaces', '--pack-destination', into], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new CannotRun(
      `npm pack failed: ${String(error.stderr ?? error.message).trim().split('\n').slice(-6).join('\n')}`
    );
  }

  const tarballs = new Map();
  for (const [name, entry] of packages) {
    const path = join(into, tarballName(name, entry.manifest.version));
    if (!existsSync(path)) {
      throw new CannotRun(`npm pack produced no tarball for ${name} at ${relative(into, path)}`);
    }
    tarballs.set(name, path);
  }
  return { tarballs, packages };
}

// ---------------------------------------------------------------------------
// An isolated place to install into
// ---------------------------------------------------------------------------

/**
 * Refuse to run if anything above `dir` could leak into module resolution.
 *
 * Node walks `node_modules` upward to the filesystem root; npm walks
 * `package.json` upward looking for a workspace root. Either one above a
 * fixture turns "the peer is not installed" into a claim about the wrong tree.
 */
export function assertIsolated(dir) {
  let current = resolve(dir);
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return;
    for (const leak of ['node_modules', 'package.json']) {
      const path = join(parent, leak);
      if (existsSync(path)) {
        throw new CannotRun(
          `${dir} is not isolated: ${path} sits above it.\n` +
            'Node resolves node_modules upward and npm resolves a workspace root upward, so a ' +
            'fixture under that directory silently resolves packages it never installed. Every ' +
            'absence this gate reports would be unfounded.'
        );
      }
    }
    current = parent;
  }
}

/**
 * A scratch root under the system temp directory, checked for isolation.
 *
 * Returns `{ root, fixture(label), tarballDir, dispose() }`. Keep the tree by
 * setting IDFKIT_KEEP_FIXTURES=1, which is how you look at what a gate saw.
 */
export function fixtureRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `idfkit-${label}-`));
  assertIsolated(root);
  return {
    root,
    tarballDir: join(root, 'tarballs'),
    fixture(name) {
      const dir = join(root, 'fixtures', name);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    dispose() {
      if (process.env.IDFKIT_KEEP_FIXTURES === '1') {
        console.log(`  fixtures kept at ${root} (IDFKIT_KEEP_FIXTURES=1)`);
        return;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * The manifest of a project that installs the shared name and nothing else.
 *
 * `dependencies` names only what a reader would type. `overrides` redirects the
 * scoped names the facade asks for to the local tarballs, because nothing is
 * published: without it npm reaches for `@idfkit/core@0.0.0` on the registry
 * and the install fails for a reason that has nothing to do with the criterion.
 *
 * The weather override is deliberately present in every fixture even where
 * weather must NOT appear. It gives npm every opportunity to install the peer.
 * An absence measured with the tarball unavailable would only prove the
 * registry could not serve it; measured with the tarball sitting right there,
 * it proves `peerDependenciesMeta.optional` did its job (FR-043).
 */
export function fixtureManifest({ name, dependencies, overrides }) {
  return {
    name,
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies,
    overrides,
  };
}

/** Write a JSON file, formatted, creating parents. */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * `npm install` inside `dir`, offline.
 *
 * `--offline` is load-bearing rather than an optimisation. Every dependency is
 * a local tarball, so a resolution that reaches the network is a resolution
 * that was not supposed to happen, and offline turns that into a loud failure
 * instead of a slow success against a package none of this controls.
 *
 * Returns `{ code, stdout, stderr }`; the caller decides whether a non-zero
 * exit is a finding (T098 asks whether an install SUCCEEDS) or a CannotRun.
 */
export function npmInstall(dir, extraFlags = []) {
  const args = [
    'install',
    '--no-audit',
    '--no-fund',
    '--offline',
    '--loglevel',
    'warn',
    ...extraFlags,
  ];
  try {
    const stdout = execFileSync('npm', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_update_notifier: 'false' },
    });
    return { code: 0, stdout, stderr: '', args };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message),
      args,
    };
  }
}

// ---------------------------------------------------------------------------
// Measuring what landed
// ---------------------------------------------------------------------------

/**
 * Every regular file under `dir`, with its apparent size and its allocated size.
 *
 * WHY BOTH, AND WHY THE CRITERION IS THE APPARENT ONE
 *
 * A clean facade install is 141 files, and it measures 1.33 MB of file content
 * against 1.66 MB of allocated disk blocks. The gap is not waste in the package:
 * it is the filesystem rounding 141 small files up to its allocation unit,
 * 4 KB on the ext4 of a GitHub runner and on the APFS of a developer's laptop.
 *
 * That gap straddled the 1.5 MB budget SC-012 carried until 2026-09-03, so the
 * choice of measure decided the verdict outright; under the amended 1.75 MB both
 * readings pass today, and both will not once the schema prose lands. Either way
 * this gate measures APPARENT bytes, for two reasons that do not depend on where
 * the line currently sits:
 *
 *   1. Allocated size is a property of the filesystem, not of the package. The
 *      same tarball measures differently on ext4, APFS, ZFS with compression,
 *      and a tmpfs, and a criterion whose verdict depends on which runner
 *      picked up the job is not a criterion.
 *   2. Apparent bytes are what everyone else means by install size: npm's own
 *      `unpackedSize`, `npm pack`'s "unpacked size" line, and every
 *      install-size tool built on the registry's metadata.
 *
 * The allocated figure is still printed, because hiding the more pessimistic
 * number would be exactly the kind of quiet flattery this gate exists against.
 *
 * `blocks` is a POSIX stat field in 512-byte units and is undefined on Windows;
 * the allocated total is reported as null there rather than guessed at.
 */
export function walkFiles(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      // lstat, never stat: a symlink is its own tiny file, and following one out
      // of the tree would count bytes that are not in the install.
      const stats = lstatSync(path);
      if (stats.isDirectory()) {
        stack.push(path);
      } else if (stats.isFile()) {
        files.push({
          path,
          relative: relative(dir, path),
          bytes: stats.size,
          blocks: typeof stats.blocks === 'number' && stats.blocks > 0 ? stats.blocks : null,
        });
      } else if (stats.isSymbolicLink()) {
        files.push({
          path,
          relative: relative(dir, path),
          bytes: stats.size,
          blocks: null,
          symlink: true,
        });
      }
    }
  }
  return files;
}

/** Apparent and allocated totals for a file list. */
export function totals(files) {
  const apparent = files.reduce((sum, file) => sum + file.bytes, 0);
  const measured = files.filter((file) => file.blocks !== null);
  const allocated =
    measured.length === files.length && files.length > 0
      ? measured.reduce((sum, file) => sum + file.blocks * 512, 0)
      : null;
  return { apparent, allocated, count: files.length };
}

/** Which installed package a path under node_modules belongs to. */
export function packageOf(relativePath) {
  const parts = relativePath.split(sep);
  if (parts[0] === undefined) return '(root)';
  if (parts[0].startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0];
}

export function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ---------------------------------------------------------------------------
// Asking Node, rather than trusting npm
// ---------------------------------------------------------------------------

const PROBE = `
const specifier = process.argv[2];
try {
  console.log('RESOLVED ' + import.meta.resolve(specifier));
} catch (error) {
  console.log('UNRESOLVED ' + (error?.code ?? error?.name ?? 'unknown'));
}
`;

/**
 * Resolve `specifier` from inside `dir`, using Node's own resolver.
 *
 * The probe is written into the fixture and run there, so it sees exactly the
 * `node_modules` chain a consumer's own file would see, including the export
 * maps. Positive proof of absence, which "npm did not print it" is not.
 */
export function resolveFrom(dir, specifier) {
  const probe = join(dir, '.resolve-probe.mjs');
  if (!existsSync(probe)) writeFileSync(probe, PROBE);
  let out;
  try {
    out = execFileSync(process.execPath, [probe, specifier], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new CannotRun(`resolution probe crashed for ${specifier}: ${error.message}`);
  }
  if (out.startsWith('RESOLVED ')) return { resolved: out.slice('RESOLVED '.length) };
  return { resolved: null, code: out.slice('UNRESOLVED '.length) };
}

/**
 * Run a module in `dir` and hand back what it printed and how it ended.
 *
 * Used for the smoke tests: "fully functional" in SC-014 and FR-043 is a claim
 * about behaviour, and the only way to check behaviour is to run the thing.
 */
export function runInFixture(dir, filename, source, args = []) {
  const path = join(dir, filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  try {
    const stdout = execFileSync(process.execPath, [path, ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message),
    };
  }
}

// ---------------------------------------------------------------------------
// The one install four of the gates measure
// ---------------------------------------------------------------------------

export const FACADE = 'idfkit';
export const CORE = '@idfkit/core';
export const SCHEMAS = '@idfkit/schemas';
export const WEATHER = '@idfkit/weather';
export const TYPE_PACKAGES = ['@idfkit/types-v26-1', '@idfkit/types-v9-4'];
export const ENGINE = ['@idfkit/engine', '@idfkit/engine-assets'];

/**
 * A project that types `npm install idfkit` and nothing else.
 *
 * `also` adds further top-level dependencies by name, which is how the opt-in
 * halves of these gates are built: adding `@idfkit/weather` is exactly the
 * `npm install @idfkit/weather` the documentation tells a reader to type.
 */
export function installSharedName(scratch, tarballs, { label, also = [], flags = [] } = {}) {
  const dir = scratch.fixture(label);
  const file = (name) => `file:${tarballs.get(name)}`;

  const dependencies = { [FACADE]: file(FACADE) };
  for (const name of also) {
    if (!tarballs.has(name)) throw new CannotRun(`no tarball for ${name}`);
    dependencies[name] = file(name);
  }

  // Every scoped name the facade could ask for is redirected to a local
  // tarball, including the ones that must not appear. See fixtureManifest().
  const overrides = {};
  for (const name of [CORE, SCHEMAS, WEATHER, ...TYPE_PACKAGES]) {
    if (tarballs.has(name)) overrides[name] = file(name);
  }

  writeJson(join(dir, 'package.json'), fixtureManifest({ name: `idfkit-${label}`, dependencies, overrides }));
  const install = npmInstall(dir, flags);
  return { dir, install, modules: join(dir, 'node_modules') };
}

/** `installSharedName`, insisting the install worked. */
export function installSharedNameOrFail(scratch, tarballs, options) {
  const result = installSharedName(scratch, tarballs, options);
  if (result.install.code !== 0) {
    throw new CannotRun(
      `npm ${result.install.args.join(' ')} failed in ${result.dir} with exit ${result.install.code}:\n` +
        `${result.install.stderr.trim().split('\n').slice(-10).join('\n')}`
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * Print the findings and return the exit code, in the shape every other gate
 * in `scripts/` uses so the six of them read alike in a CI log.
 */
export function verdict(findings, pass, fail) {
  if (findings.length === 0) {
    console.log(`PASS: ${pass}`);
    return 0;
  }
  console.log(`${findings.length} finding${findings.length === 1 ? '' : 's'}`);
  for (const finding of findings) {
    console.log(`\n  ${finding.message}`);
    if (finding.detail) console.log(`      ${finding.detail}`);
  }
  console.log(`\nFAIL: ${fail}`);
  return 1;
}

/** The wrapper every gate's entry point uses, so exit 2 means one thing. */
export async function run(main) {
  try {
    process.exit(await main());
  } catch (error) {
    if (error instanceof CannotRun) {
      console.error(`could not run: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}
