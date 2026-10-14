#!/usr/bin/env node
/**
 * Prepare what a person inspects before deciding whether an EnergyPlus release receives a type
 * package: the generated package, and the list of files that would have to name it.
 *
 * WHY THIS DOES NOT WRITE INTO `packages/`
 *
 * `npm run codegen -- <version>` writes `packages/types-<tag>/`, and every directory under
 * `packages/` is a workspace. A workspace that `package-lock.json` does not list fails `npm ci`,
 * which is the first step of every job in main.yml. Writing the package in place would therefore
 * decide the question by breaking the build until somebody wired it. Whether a release receives a
 * type package is a choice no recorded rule makes, and it adds a public name, so the generated
 * package is written to a staging directory outside the workspaces and nothing refers to it.
 *
 * WHAT IT WRITES, under `--out` (default `.energyplus-adoption/`)
 *
 *   types-<tag>/   the package exactly as `npm run codegen` would write it
 *   WIRING.md      the files that name a type package, each with the lines where it names one
 *                  today, and what each would gain
 *
 * The staging directory is not part of the published library and must not be merged. Accepting
 * the package means moving `types-<tag>/` into `packages/` and making the edits WIRING.md lists.
 * Declining it means deleting the staging directory.
 *
 * A file in the list that no longer names any type package fails the run. The list is then
 * wrong, and a wrong list is worse than none.
 *
 * Usage: node scripts/prepare-type-package.mjs <version> [--source <dir>] [--out <dir>]
 *
 * `--source` is the directory of raw epJSON schemas, passed through to scripts/emit-types.mjs.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: 'string' },
    out: { type: 'string', default: join(REPO, '.energyplus-adoption') },
  },
});

const version = positionals[0];
if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    'usage: prepare-type-package.mjs <version as X.Y.Z> [--source <dir>] [--out <dir>]'
  );
  process.exit(2);
}

const [major, minor] = version.split('.');
const TAG = `v${major}-${minor}`;
const PACKAGE = `@idfkit/types-${TAG}`;
const OUT = resolve(values.out);

/**
 * The files that name a type package, and what each gains when a release receives one.
 *
 * Prose that mentions a package by way of example (READMEs, CONTRIBUTING.md, comments) is not
 * listed: it stays correct when a package is added.
 */
const WIRING = [
  {
    file: 'tsconfig.json',
    gains: `A project reference \`{ "path": "./packages/types-${TAG}" }\`, so the solution build type-checks the declarations.`,
  },
  {
    file: 'tsconfig.test.json',
    gains: `A \`paths\` entry mapping \`${PACKAGE}\` to \`./packages/types-${TAG}/index.d.ts\`.`,
  },
  {
    file: 'packages/core/package.json',
    gains: `A \`devDependencies\` entry \`"${PACKAGE}": "*"\`.`,
  },
  {
    file: 'package-lock.json',
    gains:
      'The workspace link. Written by `npm install` after the two manifests change, never by hand.',
  },
  {
    file: '.github/workflows/publish.yml',
    gains: `\`${PACKAGE}\` in both loops: the one that stamps the peer range and the one that publishes.`,
  },
  {
    file: 'scripts/lib/clean-install.mjs',
    gains: `\`${PACKAGE}\` in \`TYPE_PACKAGES\`, which the install-size and opt-out-typing checks read.`,
  },
  {
    file: 'docs/reference/versions.md',
    gains: 'A row in the "Generated types" table, and the count in the sentence above it.',
  },
];

/** The 1-based lines of `file` that name a type package. */
function namingLines(file) {
  const lines = readFileSync(join(REPO, file), 'utf8').split('\n');
  return lines.flatMap((line, index) => (/types-v\d+-\d+/.test(line) ? [index + 1] : []));
}

const located = WIRING.map((entry) => ({ ...entry, lines: namingLines(entry.file) }));
const silent = located.filter((entry) => entry.lines.length === 0);
if (silent.length > 0) {
  for (const entry of silent) {
    console.error(`${entry.file} no longer names a type package; the wiring list is out of date.`);
  }
  process.exit(1);
}

// Regenerated as a whole, so a second run leaves exactly what the first one did.
rmSync(join(OUT, `types-${TAG}`), { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const generator = [join(HERE, 'emit-types.mjs'), version, '--packages', OUT];
if (values.source !== undefined) generator.push('--source', resolve(values.source));
execFileSync(process.execPath, generator, { stdio: 'inherit' });

const staged = relative(REPO, join(OUT, `types-${TAG}`));
const wiring = `# Type package for EnergyPlus ${version}: what to decide

\`${staged}/\` holds \`${PACKAGE}\` as \`npm run codegen -- ${version}\` writes it. It is staged
outside \`packages/\` because an unlisted workspace fails \`npm ci\`. Nothing refers to it.

This directory must not be merged. Decide one of the following, then delete it.

1. **The release receives a type package.** Move \`${staged}/\` to \`packages/types-${TAG}/\`, make
   the ${located.length} edits below, run \`npm install\`, and add \`${PACKAGE}\` to the naming register in
   idfkit-conformance. \`npm run check:type-packages\` and \`npm run check:naming\` then hold it.
2. **The release receives none.** Record that in the version roster in idfkit-conformance.

## Files that name a type package

| File | Names one today at line | Gains |
| --- | --- | --- |
${located.map((entry) => `| \`${entry.file}\` | ${entry.lines.join(', ')} | ${entry.gains} |`).join('\n')}
`;
writeFileSync(join(OUT, 'WIRING.md'), wiring);

console.log(`\nStaged ${PACKAGE} in ${staged}/ with ${relative(REPO, join(OUT, 'WIRING.md'))}.`);
