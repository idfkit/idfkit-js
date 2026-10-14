#!/usr/bin/env node
/**
 * Measure the example-file sweep for one EnergyPlus release and record it as a row of the sweep
 * matrix in `.github/workflows/main.yml`.
 *
 * WHAT IT DOES
 *
 *   1. Fetches the example files of the release from the upstream repository at the tag
 *      `v<version>`, with the selection in `.github/ep-testfiles.sparse`, exactly as the
 *      `conformance` job of main.yml does. `--examples <dir>` reads a directory already fetched.
 *   2. Runs `scripts/sweep-example-files.mjs` over them with no ceiling and reads the two counts
 *      from its report: unreadable files and diagnostics.
 *   3. Writes `- { version: "<version>", findings: N, errors: M }` into the matrix, in version
 *      order. A row that already exists for the version is replaced, so the script is idempotent.
 *
 * WHAT IT DOES NOT DECIDE
 *
 * The row is a measurement, not a judgement. The counts become a ceiling, and a ceiling that
 * records a defect hides it. The full report of the sweep is printed so that a person can hold
 * the two numbers against it before accepting the row.
 *
 * PRECONDITIONS
 *
 * The sweep reads `dist/`, so `npm ci && npm run typecheck` must have run, and the schema bundle
 * must already carry the release (`npm run build:schemas`).
 *
 * Usage: node scripts/add-sweep-row.mjs <version> [--examples <dir>]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const WORKFLOW = join(REPO, '.github/workflows/main.yml');
const SPARSE = join(REPO, '.github/ep-testfiles.sparse');
const SWEEP = join(HERE, 'sweep-example-files.mjs');

// The canonical name, as in main.yml: NREL/EnergyPlus redirects here since the rename.
const UPSTREAM = 'https://github.com/NatLabRockies/EnergyPlus';

const ROW = /^( *)- \{ version: "(\d+\.\d+\.\d+)", findings: (\d+), errors: (\d+) \}\n/gm;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { examples: { type: 'string' } },
});

const version = positionals[0];
if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: add-sweep-row.mjs <version as X.Y.Z> [--examples <dir>]');
  process.exit(2);
}

/** Sort key so 8.9.0 < 9.0.1 < 22.1.0, which plain string sort gets wrong. */
function versionKey(v) {
  const [a, b, c] = v.split('.').map(Number);
  return a * 1_000_000 + b * 1_000 + c;
}

/** Fetch the selected example files of the release into `directory`, without history or blobs. */
function fetchExamples(directory) {
  const patterns = readFileSync(SPARSE, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(#|$)/.test(line));
  const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: 'inherit' });
  execFileSync(
    'git',
    ['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--depth', '1'].concat([
      '--branch',
      `v${version}`,
      UPSTREAM,
      directory,
    ]),
    { stdio: 'inherit' }
  );
  git('sparse-checkout', 'set', '--no-cone', ...patterns);
  git('checkout', '--quiet');
  return join(directory, 'testfiles');
}

/** Run the sweep with no ceiling and return its report and the two counts it states. */
function measure(examples) {
  const unbounded = String(Number.MAX_SAFE_INTEGER);
  const run = spawnSync(
    process.execPath,
    [SWEEP, examples, '--max-findings', unbounded, '--max-errors', unbounded],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const report = `${run.stdout}${run.stderr}`;
  if (run.status !== 0) {
    throw new Error(`the sweep exited ${run.status}:\n${report}`);
  }
  const count = (label) => {
    const match = report.match(new RegExp(`^${label} +(\\d+)$`, 'm'));
    if (match === null) throw new Error(`the sweep's report has no "${label}" line:\n${report}`);
    return Number(match[1]);
  };
  return { report, findings: count('diagnostics'), errors: count('unreadable') };
}

/** The workflow text with the row for `version` added or replaced, the matrix in version order. */
function withRow(text, findings, errors) {
  const rows = [...text.matchAll(ROW)];
  if (rows.length === 0) throw new Error(`${WORKFLOW}: the sweep matrix has no rows`);
  const first = rows[0];
  const last = rows.at(-1);
  if (last.index + last[0].length - first.index !== rows.reduce((n, row) => n + row[0].length, 0)) {
    throw new Error(`${WORKFLOW}: the sweep matrix rows are not one contiguous block`);
  }
  const indent = first[1];
  const counts = new Map(
    rows.map((row) => [row[2], { findings: Number(row[3]), errors: Number(row[4]) }])
  );
  counts.set(version, { findings, errors });
  const block = [...counts.entries()]
    .sort(([a], [b]) => versionKey(a) - versionKey(b))
    .map(
      ([v, c]) => `${indent}- { version: "${v}", findings: ${c.findings}, errors: ${c.errors} }\n`
    )
    .join('');
  return text.slice(0, first.index) + block + text.slice(last.index + last[0].length);
}

let scratch;
try {
  let examples = values.examples;
  if (examples === undefined) {
    scratch = mkdtempSync(join(tmpdir(), 'ep-examples-'));
    examples = fetchExamples(join(scratch, 'ep'));
  }
  const { report, findings, errors } = measure(resolve(examples));
  console.log(report);

  const current = readFileSync(WORKFLOW, 'utf8');
  const next = withRow(current, findings, errors);
  if (next !== current) writeFileSync(WORKFLOW, next);
  console.log(
    `${version}: findings ${findings}, errors ${errors}. ` +
      `Matrix row ${next === current ? 'already states these counts' : 'written'}.`
  );
} finally {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
}
