#!/usr/bin/env node
/**
 * Generate `packages/core/src/conformance.ts` from the pin in `packages/core/package.json`.
 *
 * WHY GENERATED AND NOT WRITTEN
 *
 * FR-024 requires each release to state the conformance level it passes, and requires that
 * statement to be readable from the installed library rather than only from its packaging. The
 * level is authored in exactly one place, `idfkit.conformance` in `packages/core/package.json`,
 * which is also what the CI gates and `check-publication.mjs` read. Restating it in a hand-written
 * TypeScript constant would make two facts out of one, and the second would go stale in the same
 * silent way `docs/explanation/naming-map.md` did when a pin advanced without a re-render.
 *
 * WHY NOT IMPORT THE JSON
 *
 * `packages/core` compiles with `rootDir: src`, so `import pkg from '../package.json'` puts the
 * manifest inside the emitted output tree and changes every path in `dist`. `resolveJsonModule`
 * also drags the whole manifest into any bundle that touches the constant, which the bundle-purity
 * gate exists to prevent. Emitting one string literal costs nothing and bundles as nothing.
 *
 * The drift is caught rather than trusted: `npm run check:conformance-level` regenerates and
 * diffs, and blocks in CI, so a pin advanced in the manifest and not here fails the build instead
 * of shipping a release whose exported claim is one tag stale.
 *
 * Usage: node scripts/emit-conformance.mjs [--check]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'packages', 'core', 'package.json');
const OUTPUT = join(ROOT, 'packages', 'core', 'src', 'conformance.ts');
/** The publication gate, whose attested level must not fall behind the pin. */
const PUBLICATION_GATE = join(ROOT, 'scripts', 'check-publication.mjs');

const LEVEL_PATTERN = /^conformance-\d{4}\.\d+$/;

/** Read `idfkit.conformance`, or refuse to guess a level. */
function declaredLevel() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const level = manifest?.idfkit?.conformance;
  if (typeof level !== 'string' || level === '') {
    console.error(
      `No conformance level is declared in ${relative(ROOT, MANIFEST)}.\n` +
        '  Add "idfkit": { "conformance": "conformance-YYYY.N" }.'
    );
    process.exit(2);
  }
  if (!LEVEL_PATTERN.test(level)) {
    console.error(
      `The declared conformance level ${JSON.stringify(level)} is not an immutable ` +
        'conformance-YYYY.N tag.\n' +
        '  A release cannot claim agreement against a branch: it moves after the release ships.'
    );
    process.exit(2);
  }
  return level;
}

// Single quotes, not JSON.stringify: prettier is the formatter of record here and would
// rewrite double quotes on the next `npm run format`, which would then fail the drift check
// against a generator that had emitted the other spelling. `level` has already passed
// LEVEL_PATTERN, so it carries nothing that needs escaping.
function render(level) {
  return `/**
 * Auto-generated conformance declaration.
 *
 * DO NOT EDIT. Regenerate with:
 *     node scripts/emit-conformance.mjs
 *
 * The value is derived from \`idfkit.conformance\` in \`packages/core/package.json\`, which is the
 * one place the level is authored. \`npm run check:conformance-level\` regenerates this file and
 * diffs it, so the declaration and the export cannot drift apart.
 */

/**
 * The conformance corpus level this release is checked against, as an immutable tag in
 * idfkit/idfkit-conformance. A release asserts this claim in its own checks (FR-024): the corpus
 * at this tag passes against this library, or the release does not ship.
 *
 * This is not a version number and it is not compared to one. Two installed libraries agree on the
 * formats when they declare the same level, whatever their own versions say (FR-025).
 */
export const CONFORMANCE_LEVEL = '${level}';
`;
}

const level = declaredLevel();
const rendered = render(level);
const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  let current;
  try {
    current = readFileSync(OUTPUT, 'utf8');
  } catch {
    current = null;
  }
  if (current !== rendered) {
    console.error(
      `❌ ${relative(ROOT, OUTPUT)} is stale against the pin in ${relative(ROOT, MANIFEST)}.\n` +
        '   Run: node scripts/emit-conformance.mjs'
    );
    process.exit(1);
  }
  // The publication gate's own copy of the level, which is a HUMAN ATTESTATION rather than a
  // lookup: FR-044's proven-agreement precondition is a property of two libraries and that check
  // can only see one, so someone writes down the level after checking both. It is deliberately not
  // derived from the pin, which is exactly why it can fall behind one.
  //
  // It did, between conformance-2026.7 and 2026.8, and nothing said so until a release was
  // attempted: the CI job passes --report, and --report exits 0 on a finding. Comparing the two
  // here fails the cheap gate on the change that moves the pin instead. Moving the pin is now the
  // moment you are asked to re-attest, which is when you have the evidence in front of you.
  const gate = readFileSync(PUBLICATION_GATE, 'utf8');
  const attested = /^const REQUIRED_CONFORMANCE = '([^']+)';$/m.exec(gate)?.[1];
  if (attested === undefined) {
    console.error(
      `❌ no REQUIRED_CONFORMANCE constant in ${relative(ROOT, PUBLICATION_GATE)}.\n` +
        '   The publication gate states the level both libraries publish at; it cannot be dropped.'
    );
    process.exit(1);
  }
  if (attested !== level) {
    console.error(
      `❌ ${relative(ROOT, PUBLICATION_GATE)} attests ${attested}, but the pin in ` +
        `${relative(ROOT, MANIFEST)} is ${level}.\n` +
        '   That constant is what FR-044 rests on: it says the level BOTH libraries publish at,\n' +
        '   and only a human who checked the other library can move it. Confirm the Python pin in\n' +
        "   idfkit's pyproject.toml under [tool.idfkit.conformance] and that its Conformance job\n" +
        '   is green at that level, then update REQUIRED_CONFORMANCE and its evidence comment.'
    );
    process.exit(1);
  }

  console.log(
    `✅ CONFORMANCE_LEVEL matches the declared ${level}, and the publication gate attests it`
  );
} else {
  writeFileSync(OUTPUT, rendered, 'utf8');
  console.log(`Wrote ${relative(ROOT, OUTPUT)} declaring ${level}`);
}
