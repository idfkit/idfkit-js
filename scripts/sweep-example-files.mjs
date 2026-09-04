#!/usr/bin/env node
/**
 * Parse every EnergyPlus example file for one release and report what the parser found.
 *
 * WHY THIS EXISTS
 *
 * The unit suite reads hand-written fixtures and, when an EnergyPlus install happens to be present,
 * the example files of ONE release. That is not enough. Two classes of defect are only visible
 * across releases:
 *
 *   - A file whose content belongs to one version while its `Version` object declares another. The
 *     schema and the content then disagree, every value after the first added field lands one field
 *     early, and nothing says so. EnergyPlus ships several: `UnitarySystem_VSCoolingCoil_2.idf` in
 *     the 25.2 release declares `Version, 24.2` and uses a field added in 25.2.
 *   - A parser change that is safe on the newest schema and wrong on an older one, because field
 *     lists, extensible groups and sentinel spellings all moved between releases.
 *
 * Neither is reachable from a single version, which is why this sweeps them all. The Python
 * library runs the same sweep over the same files, so a divergence between the two shows up as a
 * different count on the same release.
 *
 * Usage: node scripts/sweep-example-files.mjs <dir> [--max-findings N] [--max-errors N]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { getIdfVersion, parseIdf } from '../packages/core/dist/index.js';
import { localBundle } from '../packages/schemas/dist/node.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'max-findings': { type: 'string', default: '0' },
    'max-errors': { type: 'string', default: '0' },
  },
});

const directory = positionals[0];
if (directory === undefined) {
  console.error('::error::usage: sweep-example-files.mjs <dir> [--max-findings N] [--max-errors N]');
  process.exit(2);
}
if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`::error::${directory} is not a directory`);
  process.exit(2);
}

const files = readdirSync(directory)
  .filter((name) => name.endsWith('.idf'))
  .sort();

if (files.length === 0) {
  // An empty sweep passes every threshold while proving nothing, which is the one outcome this
  // must never report as success.
  console.error(`::error::no .idf files under ${directory}; the sweep proved nothing`);
  process.exit(2);
}

const bundle = localBundle();
/** Schemas are shared across files, and loading one per file would dominate the run. */
const schemas = new Map();

const errors = [];
const findings = [];
const byCode = new Map();

for (const name of files) {
  try {
    const text = readFileSync(join(directory, name)).toString('latin1');
    const version = getIdfVersion(text);
    if (version === undefined) {
      errors.push(`${name}: no Version object found`);
      continue;
    }
    if (!schemas.has(version)) schemas.set(version, await bundle.load(version));

    // strict off, because the point is to collect what a file reports rather than to stop at the
    // first thing wrong with it.
    const result = parseIdf(text, schemas.get(version), { strict: false });
    for (const diagnostic of result.diagnostics) {
      byCode.set(diagnostic.code ?? 'none', (byCode.get(diagnostic.code ?? 'none') ?? 0) + 1);
      findings.push(`${name}:${diagnostic.line}: [${diagnostic.code}] ${diagnostic.message}`);
    }
  } catch (error) {
    // A file that will not read at all is the louder problem.
    errors.push(`${name}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
}

console.log(`files read      ${files.length}`);
console.log(`unreadable      ${errors.length}`);
console.log(`diagnostics     ${findings.length}`);
for (const [code, count] of [...byCode.entries()].sort()) {
  console.log(`  ${code.padEnd(20)} ${count}`);
}

if (errors.length > 0) {
  console.log('\nunreadable files:');
  for (const line of errors.slice(0, 40)) console.log(`  ${line}`);
}
if (findings.length > 0) {
  console.log('\ndiagnostics:');
  for (const line of findings.slice(0, 60)) console.log(`  ${line}`);
  if (findings.length > 60) console.log(`  ... ${findings.length} in total, 60 shown`);
}

const maxFindings = Number(values['max-findings']);
const maxErrors = Number(values['max-errors']);
let failed = false;
if (errors.length > maxErrors) {
  console.log(`\n::error::${errors.length} files failed to read, budget is ${maxErrors}`);
  failed = true;
}
if (findings.length > maxFindings) {
  console.log(`\n::error::${findings.length} diagnostics, budget is ${maxFindings}`);
  failed = true;
}

if (failed) process.exit(1);
console.log('\nPASSED: every example file read, within budget.');
