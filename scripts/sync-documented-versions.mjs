#!/usr/bin/env node
/**
 * Write the list of bundled EnergyPlus versions into the three files that restate it.
 *
 * THE SOURCE
 *
 * `packages/schemas/data/index.json.gz`, the index of the committed schema bundle. It is what
 * `bundle.versions()` returns, and `docs-url.test.ts` already holds the documented-versions list
 * against it. `npm run build:schemas` writes it, so this script runs after that one.
 *
 * THE THREE RESTATEMENTS
 *
 *   1. `DOCUMENTED_VERSIONS` in `packages/core/src/docs-url/index.ts`, the gate on every
 *      documentation address.
 *   2. `VERSIONS` in `packages/core/tests/docs-url.test.ts`, the test's own copy of that gate.
 *   3. The first table of `docs/reference/versions.md`.
 *
 * Each is replaced as a whole from the index, so the script is idempotent and takes no release as
 * an argument. A target whose anchor does not match exactly once is an error and nothing is
 * written: a list that moved must be found by a person, not skipped.
 *
 * THE TABLE LAYOUT
 *
 * Two pairs of columns. The left pair holds `max(10, ceil(n / 2))` rows and the right pair the
 * remainder, which reproduces the committed table for 17 versions and keeps the two halves
 * balanced once the right half reaches the left. Cells are padded to the widest cell of their
 * column, which is the form Prettier writes, so `npm run format:check` accepts the output.
 *
 * Usage: node scripts/sync-documented-versions.mjs [--check]
 *
 * `--check` writes nothing and exits 1 when a file differs from what would be written.
 */

import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const INDEX = join(REPO, 'packages/schemas/data/index.json.gz');

const checkOnly = process.argv.includes('--check');

/** Minimum height of the left half of the versions table. */
const MIN_LEFT_ROWS = 10;

/** The bundled versions, oldest first, as the bundle index states them. */
function bundledVersions() {
  const index = JSON.parse(gunzipSync(readFileSync(INDEX)).toString('utf8'));
  if (!Array.isArray(index.versions) || index.versions.length === 0) {
    throw new Error(`${INDEX} lists no versions`);
  }
  return index.versions;
}

/** Replace the single match of `pattern` in `text`, or fail naming the file. */
function replaceOnce(text, pattern, replacement, file) {
  const matches =
    text.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)) ?? [];
  if (matches.length !== 1) {
    throw new Error(`${file}: expected one match of ${pattern}, found ${matches.length}`);
  }
  return text.replace(pattern, replacement);
}

/** A TypeScript array literal body, one quoted version per line. */
function literalLines(versions) {
  return versions.map((version) => `  '${version}',\n`).join('');
}

function withDocumentedVersions(text, versions, file) {
  return replaceOnce(
    text,
    /(const DOCUMENTED_VERSIONS: readonly string\[\] = \[\n)(?: {2}'\d+\.\d+\.\d+',\n)+(\];\n)/,
    `$1${literalLines(versions)}$2`,
    file
  );
}

function withTestVersions(text, versions, file) {
  return replaceOnce(
    text,
    /(const VERSIONS = \[\n)(?: {2}'\d+\.\d+\.\d+',\n)+(\];\n)/,
    `$1${literalLines(versions)}$2`,
    file
  );
}

/** `26.1.0` -> `26.1`, the release line a reader knows a version by. */
function releaseLine(version) {
  return version.split('.').slice(0, 2).join('.');
}

function versionsTable(versions) {
  const leftRows = Math.max(MIN_LEFT_ROWS, Math.ceil(versions.length / 2));
  const pair = (version) => (version ? [releaseLine(version), `\`${version}\``] : ['', '']);
  const header = ['EnergyPlus', 'Schema key', 'EnergyPlus', 'Schema key'];
  const body = [];
  for (let row = 0; row < Math.min(leftRows, versions.length); row += 1) {
    body.push([...pair(versions[row]), ...pair(versions[leftRows + row])]);
  }
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...body.map((cells) => cells[column].length))
  );
  const line = (cells) => `| ${cells.map((cell, i) => cell.padEnd(widths[i])).join(' | ')} |\n`;
  const rule = `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |\n`;
  return line(header) + rule + body.map(line).join('');
}

function withVersionsTable(text, versions, file) {
  return replaceOnce(
    text,
    /\| EnergyPlus +\| Schema key +\| EnergyPlus +\| Schema key +\|\n(?:\|.*\|\n)+/,
    versionsTable(versions),
    file
  );
}

const TARGETS = [
  { file: 'packages/core/src/docs-url/index.ts', rewrite: withDocumentedVersions },
  { file: 'packages/core/tests/docs-url.test.ts', rewrite: withTestVersions },
  { file: 'docs/reference/versions.md', rewrite: withVersionsTable },
];

const versions = bundledVersions();

// Every target is computed before any is written, so a target that cannot be rewritten leaves
// the other two as they were.
const results = TARGETS.map(({ file, rewrite }) => {
  const path = join(REPO, file);
  const current = readFileSync(path, 'utf8');
  return { file, path, current, next: rewrite(current, versions, file) };
});

const stale = results.filter(({ current, next }) => current !== next);

if (checkOnly) {
  for (const { file } of stale) {
    console.error(`${file} does not list the ${versions.length} bundled versions.`);
  }
  if (stale.length > 0) {
    console.error('Run: npm run sync:versions');
    process.exit(1);
  }
  console.log(`${results.length} files list the ${versions.length} bundled versions.`);
} else {
  for (const { path, next } of stale) writeFileSync(path, next);
  console.log(
    `${versions.length} versions (${versions[0]} .. ${versions.at(-1)}); ` +
      `${stale.length} of ${results.length} files rewritten.`
  );
}
