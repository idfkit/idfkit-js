#!/usr/bin/env node
/**
 * The runtime-bytes gate for the generated type packages (task T089).
 *
 * WHAT "RUNTIME BYTES" MEANS HERE
 *
 * Any byte a JavaScript engine or a consumer's bundler would execute or compile.
 * Concretely, in a `@idfkit/types-*` package:
 *
 *   - a `.js`, `.mjs`, `.cjs`, `.jsx` file, whatever produced it;
 *   - a `.ts`/`.tsx` file that is not a declaration, since a consumer or a build
 *     step will happily compile it into JavaScript;
 *   - a `.wasm` or a source map belonging to either of the above.
 *
 * A `.d.ts`, `.d.mts` or `.d.cts` is not runtime. Neither is the manifest, the
 * README, or the licence.
 *
 * WHY ZERO IS THE RULE
 *
 * A type package exists so a reader can decline it. `@idfkit/core` was 5.5 MB,
 * of which 5.3 MB was two generated type maps that most callers never
 * parameterise a document with, so the maps were split out and made opt-in
 * (FR-039, FR-041). That split only means anything if declining a package
 * declines all of it: a package with runtime in it is a package something can
 * come to depend on at run time, and once one consumer imports a value from it
 * the opt-in is gone and core has a hidden 2.7 MB dependency again. The
 * distribution contract states it flatly — "A type package contains
 * declarations only. Any runtime code is a build failure" — and the data model
 * gives it a field, `runtime_bytes`, whose only permitted value is zero
 * (contracts/distribution.md, data-model.md section 7).
 *
 * There is a second reason, and it is the one that bites in practice. The
 * packages are generated. Before the split each generated module ended with
 *
 *     export const VERSION = '26.1.0';
 *
 * which nothing in the repository imported and which compiled to a 256-byte
 * `.js` file that nobody looked at for months. A generator can reintroduce that
 * in one line. This gate is what notices.
 *
 * The packages now ship `.d.ts` files, which nothing compiles, so that exact
 * line would produce zero bytes today. It would still be a defect, and a worse
 * one: TypeScript accepts an exported `const` in a declaration file and emits
 * nothing for it, so the package would advertise a value that does not exist
 * and `import { VERSION }` would fail at run time with no build error anywhere.
 * A byte count alone cannot see that, which is why this gate reads the
 * declarations as well as weighing them.
 *
 * WHAT IT MEASURES
 *
 * Two numbers per package, and both must be zero:
 *
 *   1. `tree`   — runtime bytes anywhere under the package directory, ignoring
 *                 `node_modules`. Catches build output that `files` does not
 *                 list and so would never appear in a tarball, which is exactly
 *                 the case a `files`-only check would wave through.
 *   2. `packed` — runtime bytes in what `npm pack` would ship. This is the
 *                 published surface, and it is the one a consumer installs.
 *
 * Bytes come from `stat` on the real files, never from npm's reported sizes, so
 * the number is the number.
 *
 * Then it reads every shipped declaration and rejects any top-level export that
 * is not a type: `export const`, `export function`, `export class`,
 * `export enum`, `export default`, `export namespace`, and a value re-export
 * (`export { x }` rather than `export type { x }`). Those weigh nothing and are
 * defects all the same, per the paragraph above.
 *
 * It also refuses a package that is declarations-only in name alone:
 *
 *   - a runtime entry point (`main`, `module`, `browser`, `bin`, or an
 *     `exports` condition other than `types`), which declares an import path
 *     even when nothing is behind it yet;
 *   - an install script, which the distribution contract rejects outright
 *     because it is skipped under `--ignore-scripts` (FR-042);
 *   - a `dependencies` entry, since declarations need nothing at run time. Core
 *     is a `peerDependencies` range and is meant to be;
 *   - zero declaration bytes, because a gate that passes on an empty package is
 *     not a gate.
 *
 * Run it after a build. Before one, an accidental `.ts` module has not been
 * compiled yet and the tree measurement misses the `.js` it would produce.
 *
 * EXIT CODES, the same contract the naming and parity gates use:
 *
 *   0  every type package is declarations only
 *   1  at least one finding, one line each
 *   2  the gate could not run
 *
 * Plain ESM, no dependencies.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = join(REPO, 'packages');

/** Directories whose contents belong to someone else. */
const IGNORED_DIRS = new Set(['node_modules', '.git']);

/** A file is a declaration when it ends this way, and is then never runtime. */
const DECLARATION = /\.d\.(m|c)?ts$/;

/** Everything a runtime would run, or a build would turn into something that runs. */
const RUNTIME = /\.(m|c)?jsx?$|\.tsx?$|\.wasm$|\.(m|c)?jsx?\.map$/;

/**
 * A top-level `export` in a declaration file, anchored at column zero.
 *
 * Column zero matters: the generated files are mostly doc comments, and a
 * fenced `export interface Zone {` inside one starts with ` * `. Anchoring
 * keeps the scan from reading its own documentation as a declaration.
 */
const TOP_LEVEL_EXPORT = /^export\b.*/gm;

/** The only two forms a declarations-only package may export. */
const TYPE_EXPORT = /^export\s+(interface\b|type\b)/;

/** `exports` conditions that name something to run. `types` is the only safe one. */
const RUNTIME_CONDITIONS = [
  'default',
  'import',
  'require',
  'node',
  'browser',
  'development',
  'production',
];

class Finding {
  constructor(packageName, message, detail) {
    this.packageName = packageName;
    this.message = message;
    this.detail = detail;
  }
}

class CannotRun extends Error {}

/** Every `packages/types-*` directory that has a manifest. */
function typePackageDirs() {
  if (!existsSync(PACKAGES)) throw new CannotRun(`no ${relative(REPO, PACKAGES)} directory`);
  const dirs = readdirSync(PACKAGES)
    .filter((name) => name.startsWith('types-'))
    .map((name) => join(PACKAGES, name))
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .sort();
  if (dirs.length === 0) {
    throw new CannotRun(
      'no packages/types-* package found. The gate has nothing to check, which is not the ' +
        'same as passing; regenerate with `npm run codegen`.'
    );
  }
  return dirs;
}

/** Every file under a directory, as paths relative to it. */
function walk(dir, prefix = '') {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(join(dir, entry.name), rel));
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

function classify(paths, dir) {
  const runtime = [];
  let runtimeBytes = 0;
  let declarationBytes = 0;
  for (const path of paths) {
    const full = join(dir, path);
    if (!existsSync(full)) continue; // listed but not on disk; npm's problem, not ours
    const bytes = statSync(full).size;
    if (DECLARATION.test(path)) {
      declarationBytes += bytes;
      continue;
    }
    if (RUNTIME.test(path)) {
      runtime.push({ path, bytes });
      runtimeBytes += bytes;
    }
  }
  runtime.sort((a, b) => b.bytes - a.bytes);
  return { runtime, runtimeBytes, declarationBytes };
}

/** What `npm pack` would put in the tarball, as paths relative to the package. */
function packedFiles(dir) {
  let raw;
  try {
    raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new CannotRun(`npm pack --dry-run failed in ${relative(REPO, dir)}: ${error.message}`);
  }
  // npm changed this payload's SHAPE in v11: `npm pack --json` used to print an array
  // of packed tarballs and now prints an object keyed by package name. Both are pure
  // JSON on stdout, so the old "find the first `[` and parse from there" was not
  // guarding against chatter so much as it was, by luck, finding the array's opening
  // bracket. Under npm 11 there is no top-level array at all, so hunting for one finds
  // only the inner `"files": [` and fails on what follows it. Reading the shape is the
  // fix; searching harder for a bracket is not.
  //
  // The `files` assertion below matters for the same reason. Defaulting a missing file
  // list to `[]` would let a shape this code cannot read report a package with zero
  // packed files as clean, and a publish gate that passes vacuously is worse than one
  // that crashes.
  //
  // This matters here more than anywhere else in the repository, because CI runs the
  // npm bundled with Node while the publish job installs npm@latest for trusted
  // publishing. The two npm versions disagree, and only the release ever sees the
  // newer one.
  //
  // So: parse the whole document, accept either shape, and refuse anything else
  // loudly rather than describing an empty package.
  const cleaned = raw
    .split('\n')
    .filter(
      (line) => !/^\s*npm (?:notice|warn|WARN|error|ERR!|info|http|verbose|sill)\b/.test(line)
    )
    .join('\n')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw new CannotRun(
      `npm pack --dry-run produced no parsable JSON in ${relative(REPO, dir)}: ${error.message}\n` +
        `Output began: ${cleaned.slice(0, 500)}`
    );
  }

  // npm <= 10: an array of tarballs. npm >= 11: an object keyed by package name.
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
  const entry = entries[0];
  if (entry === undefined) throw new CannotRun(`npm pack --dry-run described no tarball in ${dir}`);
  // Never fall back to an empty list. A package whose file list we cannot read is a
  // package we cannot vouch for, and saying so is the whole job of this gate.
  if (!Array.isArray(entry.files))
    throw new CannotRun(
      `npm pack --dry-run described a tarball with no file list in ${relative(REPO, dir)}. ` +
        `This usually means npm changed its --json shape again; the keys present were: ${Object.keys(entry).join(', ')}`
    );
  return entry.files.map((file) => file.path);
}

/**
 * Top-level exports in a declaration file that name a value rather than a type.
 *
 * Returns the offending source lines, deduplicated and capped: one `export
 * const` is the whole story, and a file that has gone properly wrong should not
 * print seventy thousand lines to say so.
 */
function valueExports(paths, dir) {
  const found = new Map();
  for (const path of paths) {
    if (!DECLARATION.test(path)) continue;
    const full = join(dir, path);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf8');
    for (const match of text.matchAll(TOP_LEVEL_EXPORT)) {
      const line = match[0].trim();
      if (TYPE_EXPORT.test(line)) continue;
      const key = `${path}: ${line.length > 90 ? `${line.slice(0, 90)}...` : line}`;
      found.set(key, (found.get(key) ?? 0) + 1);
    }
  }
  return [...found.keys()];
}

/** Entry points in a manifest that name something to run rather than to read. */
function runtimeEntryPoints(manifest) {
  const found = [];
  for (const field of ['main', 'module', 'browser', 'bin']) {
    if (manifest[field] !== undefined) found.push(field);
  }
  const visit = (value, path) => {
    if (typeof value !== 'object' || value === null) return;
    for (const [key, nested] of Object.entries(value)) {
      if (RUNTIME_CONDITIONS.includes(key)) found.push(`exports${path} -> "${key}"`);
      else visit(nested, `${path}.${key}`);
    }
  };
  visit(manifest.exports, '');
  return found;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function checkPackage(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const name = manifest.name ?? relative(REPO, dir);
  const findings = [];

  const packedFiles_ = packedFiles(dir);
  const tree = classify(walk(dir), dir);
  const packed = classify(packedFiles_, dir);

  for (const [label, measured] of [
    ['in the working tree', tree],
    ['in what npm pack would ship', packed],
  ]) {
    if (measured.runtimeBytes === 0) continue;
    findings.push(
      new Finding(
        name,
        `${measured.runtimeBytes} runtime bytes ${label}; a type package must have zero`,
        measured.runtime.map((f) => `${f.path} (${f.bytes} bytes)`).join(', ')
      )
    );
  }

  if (packed.declarationBytes === 0) {
    findings.push(
      new Finding(
        name,
        'ships no declaration bytes at all',
        'A type package with nothing in it would pass every other check here. ' +
          'Check the "files" field and that index.d.ts was generated.'
      )
    );
  }

  const values = valueExports(packedFiles_, dir);
  if (values.length > 0) {
    const shown = values.slice(0, 5);
    findings.push(
      new Finding(
        name,
        `exports ${values.length} value${values.length === 1 ? '' : 's'} from its declarations; ` +
          'a type package may export only types',
        `${shown.join(' | ')}${values.length > shown.length ? ` (+${values.length - shown.length} more)` : ''}. ` +
          'A declaration file emits nothing for these, so each is an export that does not exist ' +
          'at run time and crashes whoever imports it.'
      )
    );
  }

  const entries = runtimeEntryPoints(manifest);
  if (entries.length > 0) {
    findings.push(
      new Finding(
        name,
        'declares a runtime entry point',
        `${entries.join(', ')}. Only the "types" export condition belongs in a type package.`
      )
    );
  }

  const scripts = Object.keys(manifest.scripts ?? {}).filter((s) =>
    ['preinstall', 'install', 'postinstall', 'prepare'].includes(s)
  );
  if (scripts.length > 0) {
    findings.push(
      new Finding(
        name,
        'declares an install script',
        `${scripts.join(', ')}. Install-time scripting is rejected outright (FR-042): it is ` +
          'silently skipped under --ignore-scripts and in many CI environments.'
      )
    );
  }

  const deps = Object.keys(manifest.dependencies ?? {});
  if (deps.length > 0) {
    findings.push(
      new Finding(
        name,
        'declares runtime dependencies',
        `${deps.join(', ')}. Declarations need nothing at run time; @idfkit/core belongs in ` +
          'peerDependencies, as a range rather than a pin (FR-041).'
      )
    );
  }

  return {
    name,
    dir,
    findings,
    treeBytes: tree.runtimeBytes,
    packedBytes: packed.runtimeBytes,
    declarationBytes: packed.declarationBytes,
    peer: manifest.peerDependencies?.['@idfkit/core'] ?? null,
  };
}

function main() {
  const results = typePackageDirs().map(checkPackage);
  const findings = results.flatMap((r) => r.findings);

  console.log('idfkit-js type package gate');
  console.log(`  packages    ${results.length}`);
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(22)} declarations ${kb(r.declarationBytes).padStart(10)}` +
        `   runtime ${r.packedBytes} bytes packed, ${r.treeBytes} bytes in tree` +
        `   peer @idfkit/core ${r.peer ?? 'MISSING'}`
    );
  }
  console.log('');

  if (findings.length === 0) {
    console.log('PASS: every type package is declarations only.');
    return 0;
  }

  console.log(`${findings.length} finding${findings.length === 1 ? '' : 's'}`);
  for (const finding of findings) {
    console.log(`\n  ${finding.packageName} ${finding.message}`);
    console.log(`      ${finding.detail}`);
  }
  console.log('\nFAIL: a type package is not declarations only (FR-039, data-model section 7).');
  return 1;
}

try {
  process.exit(main());
} catch (error) {
  if (error instanceof CannotRun) {
    console.error(`type package gate could not run: ${error.message}`);
    process.exit(2);
  }
  throw error;
}
