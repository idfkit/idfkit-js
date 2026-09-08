#!/usr/bin/env node
/**
 * Generate `packages/weather/src/epw-sentinels.ts` from the corpus's
 * reserved-value table.
 *
 * WHY GENERATED AND NOT WRITTEN
 *
 * The table says, per EPW field, which values are reserved and which of those
 * mean "not measured". It is one table serving both libraries, read from the
 * EnergyPlus Weather File Data Dictionary and committed in
 * `checks/weather-monthly/sentinels.toml` beside the check that catches a wrong
 * entry. Transcribing it here would make two tables out of one, and the second
 * would drift in the direction nobody is watching: a wrong entry does not throw,
 * it moves a monthly mean.
 *
 * WHY THE GENERATED ARTIFACT IS A TYPESCRIPT MODULE AND NEVER THE TOML
 *
 * `@idfkit/weather` is portable: a browser, a worker and an edge runtime are all
 * targets, and the package takes no dependencies. Shipping the TOML would need a
 * parser at run time inside a package whose claim is that it has none, and
 * reading it at run time would need a filesystem the browser does not have. So
 * the table is emitted as literal data, tree-shakeable, with no reader attached.
 *
 * WHY IT READS A TAG
 *
 * The same reason the naming gate does: reading the corpus's default branch
 * would let that repository change this library's behaviour with no review on
 * this side. The tag is `idfkit.conformance` in `packages/core/package.json`,
 * because the reserved-value table lives under `checks/` and `checks/` is what a
 * conformance level covers.
 *
 * `--ref <ref>` exists for developing against a level that has not been cut yet,
 * announces itself in the output every time it is used, and does not lift the
 * requirement that a pin be declared.
 *
 * The drift is caught rather than trusted: `npm run check:sentinels`
 * regenerates and diffs, so an edit to the emitted module, or a corpus that
 * moved under the pin, fails the build instead of shipping a table nobody read.
 *
 * Usage: node scripts/emit-sentinels.mjs [--check] [--corpus <path>] [--ref <ref>]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseToml } from './check-naming-register.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PIN_PACKAGE = join(ROOT, 'packages', 'core', 'package.json');
const OUTPUT = join(ROOT, 'packages', 'weather', 'src', 'epw-sentinels.ts');
const TABLE_PATH = 'checks/weather-monthly/sentinels.toml';
const LEVEL_PATTERN = /^conformance-\d{4}\.\d+$/;

function fail(message) {
  console.error(message);
  process.exit(2);
}

/** The conformance level the library pins, or a refusal to guess one. */
function declaredLevel() {
  const manifest = JSON.parse(readFileSync(PIN_PACKAGE, 'utf8'));
  const level = manifest?.idfkit?.conformance;
  if (typeof level !== 'string' || level === '') {
    fail(
      `No conformance level is declared in ${relative(ROOT, PIN_PACKAGE)}.\n` +
        '  Add "idfkit": { "conformance": "conformance-YYYY.N" }.'
    );
  }
  if (!LEVEL_PATTERN.test(level)) {
    fail(
      `The declared conformance level ${JSON.stringify(level)} is not an immutable ` +
        'conformance-YYYY.N tag.\n' +
        '  A generated table cannot come from a branch: it moves after the code ships.'
    );
  }
  return level;
}

/** An idfkit-conformance checkout to read the table out of. */
function resolveCorpus(explicit) {
  const candidates = explicit
    ? [explicit]
    : [
        process.env.IDFKIT_CONFORMANCE_DIR,
        join(ROOT, 'conformance'),
        resolve(ROOT, '..', 'idfkit-conformance'),
      ].filter(Boolean);
  for (const candidate of candidates) {
    const dir = resolve(candidate);
    if (existsSync(join(dir, '.git'))) return dir;
  }
  fail(
    'No idfkit-conformance checkout found. Looked at:\n' +
      candidates.map((candidate) => `    ${resolve(candidate)}`).join('\n') +
      '\n\nClone it, or pass --corpus <path>.'
  );
}

/** Read the table at one ref. */
function readTable(corpus, ref) {
  const shown = spawnSync('git', ['show', `${ref}:${TABLE_PATH}`], {
    cwd: corpus,
    encoding: 'utf8',
  });
  if (shown.status === 0) return { text: shown.stdout, origin: `${ref} (git show, ${corpus})` };
  fail(
    `Could not read ${TABLE_PATH} at ${ref} in ${corpus}.\n` +
      `  ${(shown.stderr || '').trim()}\n` +
      '  Fetch the corpus, or pass --ref to generate against a level that is not cut yet.'
  );
}

// ---------------------------------------------------------------------------
// Emitting
// ---------------------------------------------------------------------------

/**
 * The reserved values, keyed by zero-based field position.
 *
 * The TOML carries a name, units and a prose meaning for every value. None of
 * that is emitted: the reader needs to know which numbers to blank and which to
 * keep, and a units string that no code reads is weight in every bundle that
 * touches the module. The meanings stay in the corpus, which is where somebody
 * asking what 88888 is should be reading anyway.
 */
function tableFrom(document) {
  const entries = [];
  for (const field of document.field ?? []) {
    const missing = (field.values ?? [])
      .filter((value) => value.kind === 'missing')
      .map((value) => value.value);
    if (missing.length === 0) continue;
    entries.push({ position: field.position, field: field.field, missing });
  }
  entries.sort((a, b) => a.position - b.position);
  return entries;
}

function render(entries, level, source) {
  const rows = entries
    .map(
      (entry) =>
        `  // ${entry.field}\n  [${entry.position}, [${entry.missing.map((value) => String(value)).join(', ')}]],`
    )
    .join('\n');

  return `// GENERATED FILE. Do not edit.
//
// Emitted by scripts/emit-sentinels.mjs from ${TABLE_PATH} in idfkit-conformance
// at ${level}. Run \`npm run codegen:sentinels\` to regenerate;
// \`npm run check:sentinels\` fails when this file and the corpus disagree.
//
// Source document: ${source.document}
// Versions checked: ${(source.versions_checked ?? []).join(', ')}
// ${source.url}
//
// WHAT IS HERE AND WHAT IS NOT. Only the values that mean "not measured". A field
// may also reserve values that are observations — ceiling height's 77777 for an
// unlimited ceiling and 88888 for a cirroform one — and those are deliberately
// absent, because the reader's rule is to blank what this table lists and to
// leave every other number alone. A reader that instead blanked "large numbers"
// would blank 55% of the ceiling column in the sampled corpus.

/**
 * Per numeric column position, the values that mean the measurement was not
 * made. Positions absent from this list reserve nothing.
 *
 * @internal
 */
export const MISSING_VALUES: ReadonlyArray<readonly [number, readonly number[]]> = [
${rows}
];

/** The conformance level this table was generated from. @internal */
export const SENTINEL_LEVEL = '${level}';
`;
}

// ---------------------------------------------------------------------------

function main(argv) {
  const options = { check: false, corpus: undefined, ref: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--corpus') options.corpus = argv[++i];
    else if (arg === '--ref') options.ref = argv[++i];
    else fail(`Unknown argument ${JSON.stringify(arg)}.`);
  }

  const level = declaredLevel();
  const corpus = resolveCorpus(options.corpus);
  const ref = options.ref ?? level;
  if (options.ref !== undefined) {
    console.log(
      `NOTE: reading the table at ${options.ref} rather than at the pinned ${level}.\n` +
        '      This is for developing against a level that has not been cut. A build must not rely on it.'
    );
  }

  const read = readTable(corpus, ref);
  const document = parseToml(read.text, TABLE_PATH);
  const rendered = render(tableFrom(document), options.ref ?? level, document.source ?? {});

  if (options.check) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
    if (current === rendered) {
      console.log(`PASS: ${relative(ROOT, OUTPUT)} matches ${TABLE_PATH} at ${ref}.`);
      return 0;
    }
    console.error(
      `${relative(ROOT, OUTPUT)} does not match ${TABLE_PATH} at ${ref}.\n` +
        '  Generated does not quietly become transcribed: run `npm run codegen:sentinels`.\n' +
        `  Read from ${read.origin}.`
    );
    return 1;
  }

  writeFileSync(OUTPUT, rendered);
  console.log(`Wrote ${relative(ROOT, OUTPUT)} from ${read.origin}.`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
