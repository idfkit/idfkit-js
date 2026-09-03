#!/usr/bin/env node
/**
 * Assert this release passes the corpus at the level it declares (FR-024, SC-025).
 *
 * The mirror of `make release-check` in the Python repository, and deliberately the same shape:
 * read the pin, export the corpus at that tag, run it, refuse rather than guess. A release states
 * one thing about agreement, the conformance level it passes, and FR-024 makes that a claim the
 * release's own checks assert rather than one a maintainer remembers to verify.
 *
 * NOT THE SAME CHECK AS `check:publication`
 *
 * `check-publication.mjs` gates the one-time publication of the `idfkit` facade against all four
 * FR-044 preconditions, and pins the level it requires in a constant of its own. This runs on
 * every release, asserts one thing, and restates nothing: the level comes from
 * `idfkit.conformance` in `packages/core/package.json`, which is also what `CONFORMANCE_LEVEL`
 * is generated from. A pin that advances moves this check with it, by construction.
 *
 * The corpus is exported out of the conformance repository's git object store at the declared tag,
 * never read from its working tree. A maintainer with local corpus edits would otherwise get a
 * green release check for a corpus nobody else can obtain.
 *
 * Exit codes: 0 the corpus passes at the declared level, 1 it does not, 2 the check could not run.
 *
 * Usage: node scripts/check-release-conformance.mjs [--corpus <path>]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_MANIFEST = join(REPO, 'packages', 'core', 'package.json');
const LEVEL_PATTERN = /^conformance-\d{4}\.\d+$/;
const CANNOT_RUN = 2;

function cannotRun(...lines) {
  for (const line of lines) console.error(line);
  process.exit(CANNOT_RUN);
}

/** Read `idfkit.conformance`, the one place the claim is authored. */
function declaredLevel() {
  const manifest = JSON.parse(readFileSync(CORE_MANIFEST, 'utf8'));
  const level = manifest?.idfkit?.conformance;
  if (typeof level !== 'string' || level === '') {
    cannotRun(
      'No conformance level is declared in packages/core/package.json.',
      '  Add "idfkit": { "conformance": "conformance-YYYY.N" }.'
    );
  }
  if (!LEVEL_PATTERN.test(level)) {
    cannotRun(
      `The declared conformance level ${JSON.stringify(level)} is not an immutable conformance-YYYY.N tag.`,
      '  A release cannot claim agreement against a branch: it moves after the release ships.'
    );
  }
  return level;
}

/** The conformance checkout, found the way every other gate here finds it. */
function findCorpus(argv) {
  const index = argv.indexOf('--corpus');
  const candidates = [
    index === -1 ? undefined : argv[index + 1],
    process.env.IDFKIT_CONFORMANCE_DIR,
    process.env.IDFKIT_CONFORMANCE_REPO,
    join(REPO, 'conformance'),
    join(REPO, '..', 'idfkit-conformance'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, '.git'))) return candidate;
  }
  cannotRun(
    `No idfkit-conformance git checkout. Looked at: ${candidates.join(', ')}.`,
    '  Pass --corpus <path> or set IDFKIT_CONFORMANCE_DIR. A release check cannot be skipped for',
    '  want of a clone: skipping it would ship the claim unexamined, which is what FR-024 forbids.'
  );
}

/**
 * A read-only export of the corpus at `tag`.
 *
 * `git archive` rather than a worktree or a checkout, for the reason
 * `check-publication.mjs` gives beside the same helper: the corpus repository is not this
 * check's to mutate, and a release gate that leaves a detached HEAD behind is a release gate
 * people start skipping.
 */
function exportAtTag(corpus, tag) {
  try {
    execFileSync(
      'git',
      ['-C', corpus, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`],
      {
        stdio: 'pipe',
      }
    );
  } catch {
    cannotRun(
      `The declared conformance tag ${tag} does not exist in ${corpus}.`,
      '  Fetch the tags, or cut the level before declaring it: FR-084 requires an artefact be',
      '  published and versioned before anything pins it.'
    );
  }
  const into = mkdtempSync(join(tmpdir(), `idfkit-release-${tag}-`));
  try {
    const archive = execFileSync('git', ['-C', corpus, 'archive', '--format=tar', tag], {
      maxBuffer: 512 * 1024 * 1024,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('tar', ['-x', '-C', into], { input: archive, stdio: ['pipe', 'ignore', 'pipe'] });
  } catch (error) {
    rmSync(into, { recursive: true, force: true });
    cannotRun(`cannot export ${tag} from ${corpus}: ${error.message}`);
  }
  return into;
}

const argv = process.argv.slice(2);
const level = declaredLevel();
const corpus = findCorpus(argv);
const at = exportAtTag(corpus, level);

let code;
try {
  const runner = join(at, 'runners', 'run.mjs');
  if (!existsSync(runner)) {
    cannotRun(`${level} carries no runners/run.mjs; it is not a corpus this check can run.`);
  }
  console.log(`🚀 Running the conformance corpus at ${level} (exported from ${corpus})`);
  code = spawnSync(
    process.execPath,
    [runner, '--library', REPO, '--corpus', at, '--level', level],
    {
      stdio: 'inherit',
    }
  ).status;
} finally {
  rmSync(at, { recursive: true, force: true });
}

if (code !== 0) {
  console.error(
    `\n❌ This release declares ${level} and does not pass it.\n` +
      '   Fix the library, or record the difference in known-divergence.toml and cut a new level.\n' +
      '   Do not lower the declaration to whatever currently passes: the level is the claim.'
  );
  process.exit(1);
}
console.log(`\n✅ The corpus at ${level} passes; the release may state it.`);
