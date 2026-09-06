#!/usr/bin/env node
/**
 * The publication check for the shared install name (task T101a, FR-044,
 * FR-088, SC-032).
 *
 * WHY THIS EXISTS AT ALL
 *
 * FR-088: publication under the shared name is irreversible. npm's unpublish
 * window is 72 hours and only while nothing depends on the package, and a
 * withdrawal after that is a request, not a right. So the plan cannot include
 * one. A claim later found untrue is corrected by a further release and a
 * corrected front page, never by taking the version away.
 *
 * The same requirement then says how the preconditions must be established:
 * "MUST be verified by a check at publication time rather than by inspection".
 * Inspection is the failure mode being legislated against. Four preconditions,
 * six months of work, a release cut on a Friday, and somebody says "yes, that
 * all landed". This file is the alternative.
 *
 * THE FOUR PRECONDITIONS, VERBATIM
 *
 * FR-044: "Publication under the shared name MUST NOT occur before proven
 * agreement, the vocabulary and its renames, the first-tier capability port,
 * and the distribution reshaping are all complete."
 *
 * Each is turned into something a machine can decide:
 *
 *   1. PROVEN AGREEMENT     the cross-language conformance corpus, at the level
 *                           pinned in packages/core/package.json, run against
 *                           this workspace, exits 0.
 *   2. VOCABULARY, RENAMES  scripts/check-naming-register.mjs exits 0 against
 *                           governance/naming.toml at the pinned governance
 *                           tag. That gate already enforces the rename budget
 *                           and requires a spent rename to have LANDED: a name
 *                           registered with rename_count >= 1 whose new
 *                           spelling is not public is a finding.
 *   3. FIRST-TIER PORT      governance/parity.toml at the pinned tag has no
 *                           tier-1 capability `absent` in either language, and
 *                           scripts/check-parity-ledger.mjs exits 0, so the
 *                           ledger and the real export surface agree.
 *   4. DISTRIBUTION         the eight distribution gates exit 0: type packages,
 *                           facade, install size, bundle purity,
 *                           --ignore-scripts, no index, absent component,
 *                           opt-out typing. Between them they are SC-012 to
 *                           SC-016 and SC-031.
 *
 * WHERE THIS IS WEAKER THAN IT LOOKS, SAID PLAINLY
 *
 * Two of the four cannot be checked from this repository as strongly as the
 * words suggest, and the report says so on every run rather than only here:
 *
 *   AGREEMENT IS ONE-SIDED. "Proven agreement" is a property of TWO libraries.
 *   This check runs the corpus against the JavaScript one. Whether the Python
 *   library passes the same level is asserted by the corpus run in ITS
 *   repository, which nothing here can observe. What is checkable here is that
 *   both sides are pinned to the same level, and that this side passes it.
 *   Closing the gap needs a published per-level result the two repositories
 *   both write to; that does not exist and inventing one is outside this task.
 *
 *   "COMPLETE" FOR TIER 1 MEANS "LANDED", NOT "IDENTICAL". The ledger's own
 *   vocabulary has three states, and `partial` is a landed capability with a
 *   mandatory, non-empty `differences` note (FR-046 to FR-050). Two tier-1
 *   entries are `partial` in TypeScript today and two are `partial` in Python,
 *   each with pages of recorded prose. Reading FR-044's "complete" as "every
 *   tier-1 entry says complete" would make the requirement unsatisfiable
 *   without governance changes nobody has agreed to, and would treat a stated,
 *   reviewed difference as an unfinished port. So the check requires: nothing
 *   in tier 1 `absent`, and every `partial` carrying its differences. That is
 *   the strongest reading the ledger supports, and it is still an
 *   interpretation rather than a quotation.
 *
 * The other two are strong. The distribution gates measure real installs and
 * real bundles, and the naming gate reads the register at an immutable tag.
 *
 * TWO MODES
 *
 *   (default)   the publication gate. Exit 1 refuses the publish.
 *   --report    the CI mode. Prints the same table, exits 0 unless the check
 *               itself could not run. Preconditions that are legitimately not
 *               met yet must not block every merge; a check that has rotted
 *               must not go unnoticed either.
 *
 * A NOTE ON THE NAME
 *
 * `idfkit` cannot currently be registered on npm: the registry's similarity
 * filter rejects it and an appeal is pending. This check neither publishes nor
 * asks the registry anything, so it runs and is correct today, and the day the
 * name is available nothing about it has to change.
 *
 * Exit codes: 0 publish, 1 do not publish, 2 could not decide.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

class CannotRun extends Error {}

/**
 * The conformance level this release publishes against. Both libraries must be at it.
 *
 * A HUMAN ATTESTATION, and that is the whole point of it being a constant rather than a lookup.
 * FR-044's first precondition is proven agreement, which is a property of TWO libraries, and this
 * check can only see one: it runs the corpus against the JavaScript side, while the Python side is
 * asserted by the run in that repository and is not observable from here. So the level is written
 * down by someone who checked both, and moving it is the act of re-attesting.
 *
 * T101 named conformance-2026.6, the level that proved the Tier 1 port. This is 2026.10, the level
 * that carries the preserved-text assertion with the second language's divergence entries removed,
 * and the evidence for it, taken rather than recalled:
 *
 *   idfkit-js    packages/core/package.json  idfkit.conformance   = conformance-2026.10
 *   idfkit       pyproject.toml              [tool.idfkit.conformance] level = conformance-2026.10
 *   idfkit-js    npm run check:release                             green at that level
 *   idfkit       uv run python scripts/check_release_conformance.py green at that level
 *
 * Both were run against the corpus checkout on the day this moved, rather than read off a CI
 * badge, because the two levels that preceded this one were cut hours apart and a badge would have
 * been reporting the older of them.
 *
 * Each level since 2026.6 contains all of it and adds cases, so the precondition is met more
 * strongly rather than less.
 *
 * ADVANCE THIS WHENEVER BOTH PINS ADVANCE. It went stale once, between 2026.7 and 2026.8, and the
 * staleness surfaced only when a release was attempted, because the CI job runs with --report and
 * --report exits 0 on a finding. `emit-conformance.mjs --check` now compares this constant against
 * the pin on every run, so the next time the two part company it fails a cheap gate on the change
 * that caused it rather than a release months later.
 */
const REQUIRED_CONFORMANCE = 'conformance-2026.10';

/** The distribution gates, precondition 4. Order is cheapest first. */
const DISTRIBUTION_GATES = [
  ['check-type-packages.mjs', 'type packages carry no runtime (FR-039)'],
  ['check-facade.mjs', 'the facade is the contracted surface (FR-036, FR-037, FR-070)'],
  ['check-install-size.mjs', 'under 1.875 MB on disk (SC-012)'],
  ['check-no-index.mjs', 'zero station-index bytes, weather not auto-installed (FR-043, SC-016)'],
  ['check-ignore-scripts.mjs', 'no install-time scripting (SC-015)'],
  ['check-opt-out-typing.mjs', 'zero type-package bytes, fully functional (SC-014)'],
  ['check-bundle-purity.mjs', 'no unrequested bytes in a browser bundle (SC-013)'],
  ['check-absent-component.mjs', 'the absent peer names its install (FR-074, SC-031)'],
];

class Finding {
  constructor(message, detail) {
    this.message = message;
    this.detail = detail;
  }
}

/** One FR-044 precondition and what was established about it. */
class Precondition {
  constructor(number, clause, strength) {
    this.number = number;
    this.clause = clause;
    /** 'strong' or 'weak', reported on every run. */
    this.strength = strength;
    this.probes = [];
    this.findings = [];
  }

  probe(name, ok, note) {
    this.probes.push({ name, ok, note });
    return ok;
  }

  fail(message, detail) {
    this.findings.push(new Finding(message, detail));
  }

  get met() {
    return this.findings.length === 0;
  }
}

// ---------------------------------------------------------------------------
// Reading the pins and the governance files
// ---------------------------------------------------------------------------

function corePackage() {
  const path = join(REPO, 'packages/core/package.json');
  if (!existsSync(path)) throw new CannotRun(`no packages/core/package.json under ${REPO}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * The conformance checkout, found the same way the naming and parity gates
 * find it, so all three take the same argument.
 */
function findCorpus(argv) {
  const index = argv.indexOf('--corpus');
  const candidates = [
    index === -1 ? undefined : argv[index + 1],
    process.env.IDFKIT_CONFORMANCE_DIR,
    process.env.IDFKIT_CONFORMANCE_REPO,
    join(REPO, 'conformance'),
    join(REPO, '..', 'idfkit-conformance'),
  ].filter((candidate) => candidate !== undefined && candidate !== '');

  const found = candidates.find((candidate) => existsSync(join(resolve(candidate), '.git')));
  if (found === undefined) {
    throw new CannotRun(
      `no idfkit-conformance checkout with a .git directory. Looked at: ${candidates.join(', ')}.\n` +
        'Clone it beside this repository, pass --corpus <path>, or set IDFKIT_CONFORMANCE_DIR. ' +
        'Publication cannot be approved against a corpus that is not there.'
    );
  }
  return resolve(found);
}

function git(corpus, args) {
  return execFileSync('git', ['-C', corpus, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Whether a tag exists in the checkout, and what it points at. */
function tagCommit(corpus, tag) {
  try {
    return git(corpus, ['rev-parse', `${tag}^{commit}`]);
  } catch {
    return null;
  }
}

/**
 * A read-only export of the corpus at a tag.
 *
 * `git archive` rather than a worktree or a checkout: the corpus repository is
 * not this check's to mutate, and a publication gate that leaves a working tree
 * behind it on a detached HEAD is a publication gate people will start skipping.
 */
function exportAtTag(corpus, tag) {
  const into = mkdtempSync(join(tmpdir(), `idfkit-corpus-${tag}-`));
  try {
    const archive = execFileSync('git', ['-C', corpus, 'archive', '--format=tar', tag], {
      maxBuffer: 512 * 1024 * 1024,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('tar', ['-x', '-C', into], { input: archive, stdio: ['pipe', 'ignore', 'pipe'] });
  } catch (error) {
    rmSync(into, { recursive: true, force: true });
    throw new CannotRun(`cannot export ${tag} from ${corpus}: ${error.message}`);
  }
  return into;
}

/**
 * One governance file at the pinned tag, as text.
 *
 * `--governance-dir` reads a working tree instead, the same deliberate and
 * loud escape hatch the parity gate offers, and the same one this check
 * forwards to the gates it runs. It exists so a governance change can be tried
 * before it is tagged, and so this gate can be tested against a doctored
 * ledger; every run that uses it says so in its header. Never in CI.
 */
function governanceFile(corpus, pin, name, override) {
  if (override !== undefined) {
    const dir = existsSync(join(override, 'governance')) ? join(override, 'governance') : override;
    const path = join(dir, name);
    if (!existsSync(path)) throw new CannotRun(`--governance-dir has no ${name}: ${path}`);
    return readFileSync(path, 'utf8');
  }
  try {
    return git(corpus, ['show', `${pin}:governance/${name}`]);
  } catch (error) {
    throw new CannotRun(
      `cannot read governance/${name} at ${pin} in ${corpus}: ` +
        `${String(error.stderr ?? error.message).trim()}\n` +
        'The tag is published before it is pinned, and a consuming build never falls back to a ' +
        'branch (FR-081). Fetch the tags.'
    );
  }
}

/**
 * The capability entries of parity.toml, enough of them for the tier-1 question.
 *
 * A whole TOML parser lives in scripts/check-parity-ledger.mjs and is not
 * exported. Rather than importing 35 KB of gate or vendoring a parser, this
 * reads the four scalar fields and the presence of `differences` off each
 * `[[capability]]` block. The schema is enforced by the parity gate, which runs
 * as one of this precondition's probes, so a malformed block fails there.
 */
function readCapabilities(toml) {
  const blocks = toml.split(/^\[\[capability\]\]\s*$/m).slice(1);
  const scalar = (block, key) => {
    const match = block.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
    return match?.[1];
  };
  return blocks.map((block) => ({
    id: scalar(block, 'id') ?? '(no id)',
    title: scalar(block, 'title') ?? '',
    tier: scalar(block, 'tier') ?? '(no tier)',
    python: scalar(block, 'python') ?? '(none)',
    typescript: scalar(block, 'typescript') ?? '(none)',
    // `differences` is a triple-quoted block; presence and non-emptiness is all
    // that is needed here.
    differences: /^differences\s*=\s*"""\s*\n([\s\S]*?)"""/m.exec(block)?.[1]?.trim() ?? '',
  }));
}

// ---------------------------------------------------------------------------
// Running the other gates
// ---------------------------------------------------------------------------

/** Run one gate and keep its output for the failing case only. */
function runGate(script, args = []) {
  const path = join(REPO, 'scripts', script);
  if (!existsSync(path)) {
    return { code: 2, output: `${script} does not exist`, missing: true };
  }
  const result = spawnSync(process.execPath, [path, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: result.status ?? 2,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/** The last meaningful line of a gate's output, for the summary table. */
function summarise(output) {
  const lines = output
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.findLast((line) => /^(PASS|FAIL|\d+ finding)/.test(line)) ??
    lines[lines.length - 1] ??
    '(no output)'
  );
}

function gateFinding(precondition, label, why, result) {
  if (result.code === 0) return;
  if (result.code === 2) {
    throw new CannotRun(
      `${label} could not run, so publication cannot be approved or refused on it:\n` +
        `${result.output.trim().split('\n').slice(-6).join('\n')}`
    );
  }
  precondition.fail(`${label} fails: ${why}`, summarise(result.output));
}

// ---------------------------------------------------------------------------
// The four preconditions
// ---------------------------------------------------------------------------

function agreement(corpus, pins) {
  const p = new Precondition(1, 'proven agreement', 'weak');

  if (pins.conformance !== REQUIRED_CONFORMANCE) {
    p.fail(
      `the conformance pin is ${pins.conformance}, not ${REQUIRED_CONFORMANCE}`,
      `FR-044 and T101 name ${REQUIRED_CONFORMANCE} as the level both libraries publish at. ` +
        'The pin lives in packages/core/package.json under "idfkit".'
    );
  }
  p.probe('conformance pin', pins.conformance === REQUIRED_CONFORMANCE, pins.conformance);

  const commit = tagCommit(corpus, pins.conformance);
  if (commit === null) {
    throw new CannotRun(
      `${pins.conformance} is not a tag in ${corpus}. A level is an immutable tag and the ` +
        'corpus is run at it, never at a branch (FR-081). Fetch the tags.'
    );
  }
  p.probe('tag exists', true, `${pins.conformance} at ${commit.slice(0, 8)}`);

  const at = exportAtTag(corpus, pins.conformance);
  try {
    const runner = join(at, 'runners', 'run.mjs');
    if (!existsSync(runner)) {
      throw new CannotRun(`no runners/run.mjs in the corpus at ${pins.conformance}`);
    }
    // --level, because `git archive` carries no tags: without it the runner
    // reports "level unpinned" and cannot decide which known divergences are
    // still in force at this level.
    const args = [runner, '--library', REPO, '--corpus', at, '--level', pins.conformance];
    const result = spawnSync(process.execPath, args, {
      cwd: at,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const code = result.status ?? 2;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (code === 2) {
      throw new CannotRun(
        `the conformance runner could not start:\n${output.trim().split('\n').slice(-8).join('\n')}`
      );
    }
    const tally = output.match(/^\s*\d+ case\(s\).*$/m)?.[0]?.trim() ?? summarise(output);
    p.probe('corpus run, JavaScript', code === 0, tally);
    if (code !== 0) {
      p.fail(
        `the conformance corpus fails against this workspace at ${pins.conformance}`,
        `${tally}. Publication under the shared name asserts that the two libraries agree; ` +
          'this side does not yet agree with the corpus.'
      );
    }
  } finally {
    rmSync(at, { recursive: true, force: true });
  }

  p.probe(
    'corpus run, Python',
    null,
    'not observable from this repository; asserted by the corpus run in idfkit'
  );
  return p;
}

function vocabulary(corpus, pins, argv) {
  const p = new Precondition(2, 'the vocabulary and its renames', 'strong');

  const commit = tagCommit(corpus, pins.governance);
  if (commit === null) {
    throw new CannotRun(`${pins.governance} is not a tag in ${corpus}. Fetch the tags.`);
  }
  p.probe('governance pin', true, `${pins.governance} at ${commit.slice(0, 8)}`);

  if (!existsSync(join(REPO, '.typedoc.json'))) {
    throw new CannotRun(
      'no .typedoc.json. The naming gate reads it, exits 2 without it, and this check will not ' +
        'approve a publication on a precondition it could not evaluate. Run `npm run docs:api`.'
    );
  }

  const result = runGate('check-naming-register.mjs', [
    '--corpus',
    corpus,
    ...passthrough(argv, 'naming'),
  ]);
  p.probe('naming register', result.code === 0, summarise(result.output));
  gateFinding(
    p,
    'the naming gate',
    'a public name is unregistered, or a spent rename has not landed',
    result
  );
  return p;
}

function firstTier(corpus, pins, argv, override) {
  const p = new Precondition(3, 'the first-tier capability port', 'strong');

  const capabilities = readCapabilities(
    governanceFile(corpus, pins.governance, 'parity.toml', override)
  );
  if (capabilities.length === 0) {
    throw new CannotRun(`no [[capability]] entries in parity.toml at ${pins.governance}`);
  }
  const tier1 = capabilities.filter((entry) => entry.tier === 'tier-1');
  if (tier1.length === 0) {
    throw new CannotRun(`no tier-1 capabilities in parity.toml at ${pins.governance}`);
  }

  for (const language of ['python', 'typescript']) {
    const absent = tier1.filter((entry) => entry[language] === 'absent');
    p.probe(
      `tier-1 ${language}`,
      absent.length === 0,
      `${tier1.filter((e) => e[language] === 'complete').length} complete, ` +
        `${tier1.filter((e) => e[language] === 'partial').length} partial, ${absent.length} absent`
    );
    if (absent.length > 0) {
      p.fail(
        `${absent.length} tier-1 capability(ies) are absent in ${language}: ${absent.map((e) => e.id).join(', ')}`,
        'Tier 1 is the shared core, present in both languages at landing. FR-044 will not let ' +
          'the shared name be published while one of them is missing on either side.'
      );
    }
  }

  const undescribed = tier1.filter(
    (entry) =>
      (entry.python === 'partial' || entry.typescript === 'partial') && entry.differences === ''
  );
  p.probe(
    'tier-1 partials described',
    undescribed.length === 0,
    `${undescribed.length} without differences`
  );
  if (undescribed.length > 0) {
    p.fail(
      `${undescribed.length} partial tier-1 capability(ies) carry no differences note: ${undescribed.map((e) => e.id).join(', ')}`,
      'A partial capability is a landed one with a stated gap. An unstated gap is not a landed ' +
        'capability, it is an undocumented one (FR-046 to FR-050).'
    );
  }

  const result = runGate('check-parity-ledger.mjs', [
    '--corpus',
    corpus,
    ...passthrough(argv, 'parity'),
  ]);
  p.probe('parity ledger', result.code === 0, summarise(result.output));
  gateFinding(p, 'the parity gate', 'the ledger and the exported capability set disagree', result);

  return p;
}

function distribution() {
  const p = new Precondition(4, 'the distribution reshaping', 'strong');
  for (const [script, why] of DISTRIBUTION_GATES) {
    const result = runGate(script);
    p.probe(script.replace(/^check-|\.mjs$/g, ''), result.code === 0, summarise(result.output));
    gateFinding(p, script, why, result);
  }
  return p;
}

/** The `--governance-dir` override, or undefined. */
function governanceOverride(argv) {
  const index = argv.indexOf('--governance-dir');
  const value = index === -1 ? process.env.IDFKIT_GOVERNANCE_DIR : argv[index + 1];
  return value === undefined || value === '' ? undefined : resolve(value);
}

/**
 * The override, spelled the way each gate spells it.
 *
 * The parity gate reads both governance files and takes `--governance-dir
 * <dir>`; the naming gate reads only the register and takes `--register
 * <file>`. Same escape hatch, two spellings, and passing the wrong one makes
 * the gate refuse to run, which this check then reports as exit 2 rather than
 * as a verdict.
 */
function passthrough(argv, gate) {
  const override = governanceOverride(argv);
  if (override === undefined) return [];
  if (gate === 'naming') {
    const dir = existsSync(join(override, 'governance')) ? join(override, 'governance') : override;
    return ['--register', join(dir, 'naming.toml')];
  }
  return ['--governance-dir', override];
}

// ---------------------------------------------------------------------------

function usage() {
  console.log(
    [
      'Usage: node scripts/check-publication.mjs [--report] [--corpus <path>]',
      '',
      'Asserts the four FR-044 preconditions for publishing under the shared install name.',
      '',
      '  --report            print the table and exit 0 unless the check itself could not run.',
      '                      For CI, where an unmet precondition is a fact rather than a fault.',
      '  --corpus <path>     the idfkit-conformance checkout the pinned tags are read from.',
      '  --governance-dir    forwarded to the naming and parity gates. Never use it in CI.',
      '',
      'Environment: IDFKIT_CONFORMANCE_DIR (same as --corpus).',
      '',
      'Exit 0 publish, 1 do not publish, 2 could not decide.',
    ].join('\n')
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return 0;
  }
  const report = argv.includes('--report');

  const core = corePackage();
  const pins = {
    conformance: core?.idfkit?.conformance,
    governance: core?.idfkit?.governance,
  };
  for (const [name, value] of Object.entries(pins)) {
    if (typeof value !== 'string' || value === '') {
      throw new CannotRun(
        `no idfkit.${name} pin in packages/core/package.json. A release that cannot say which ` +
          'level it passes cannot claim the preconditions of FR-044 (FR-024).'
      );
    }
  }
  const corpus = findCorpus(argv);
  const override = governanceOverride(argv);

  const preconditions = [
    agreement(corpus, pins),
    vocabulary(corpus, pins, argv),
    firstTier(corpus, pins, argv, override),
    distribution(),
  ];

  console.log('idfkit-js publication check for the shared install name (FR-044, FR-088, SC-032)');
  console.log(`  repository   ${REPO}`);
  console.log(`  corpus       ${corpus}`);
  console.log(`  pins         ${pins.conformance}, ${pins.governance}`);
  console.log(`  mode         ${report ? '--report (informational)' : 'publication gate'}`);
  if (override !== undefined) {
    console.log(
      `  OVERRIDE     governance read from ${override} (working tree), not ${pins.governance}`
    );
    console.log('               Never do this in CI, and never to approve a publication.');
  }
  console.log('');
  console.log('  FR-044: publication MUST NOT occur before proven agreement, the vocabulary and');
  console.log('  its renames, the first-tier capability port, and the distribution reshaping are');
  console.log('  all complete.');
  console.log('');

  for (const p of preconditions) {
    console.log(
      `  ${p.number}. ${p.clause}${' '.repeat(Math.max(1, 34 - p.clause.length))}` +
        `${p.met ? 'MET' : 'NOT MET'}   [${p.strength}]`
    );
    for (const probe of p.probes) {
      const mark = probe.ok === null ? '?' : probe.ok ? 'ok' : 'NO';
      console.log(`       ${mark.padEnd(4)} ${probe.name.padEnd(24)} ${probe.note}`);
    }
    console.log('');
  }

  console.log('  what "weak" means here');
  console.log('    1. proven agreement is a property of two libraries. This runs the corpus');
  console.log('       against the JavaScript one only; the Python result is asserted by the run');
  console.log("       in that repository and is not observable from here. Both sides' pins being");
  console.log('       equal is checkable and is checked; both sides passing is not.');
  console.log('    3. "complete" is read as "landed": no tier-1 capability absent, and every');
  console.log('       partial carrying its differences note. The ledger treats partial as a');
  console.log('       landed capability with a stated gap, so requiring every entry to say');
  console.log('       "complete" would fail on differences that have been reviewed and agreed.');
  console.log('');

  const findings = preconditions.flatMap((p) => p.findings);
  const unmet = preconditions.filter((p) => !p.met);

  if (findings.length === 0) {
    console.log('PASS: all four FR-044 preconditions hold. Publication under the shared name is');
    console.log('      approved. It is irreversible: a claim found untrue afterwards is corrected');
    console.log('      by a further release, never by withdrawing the version (FR-088).');
    return 0;
  }

  console.log(
    `${findings.length} finding${findings.length === 1 ? '' : 's'} across ${unmet.length} precondition(s)`
  );
  for (const p of unmet) {
    for (const finding of p.findings) {
      console.log(`\n  [${p.number}. ${p.clause}] ${finding.message}`);
      console.log(`      ${finding.detail}`);
    }
  }
  console.log('');
  if (report) {
    console.log('REPORT: the preconditions above are not all met, which is a fact about how far');
    console.log('        the work has got and not a fault in this run. --report exits 0; the');
    console.log('        publication gate itself, run without it, refuses.');
    return 0;
  }
  console.log('REFUSED: publication under the shared name would claim something that is not true.');
  console.log('         Publication is irreversible and cannot be corrected by withdrawal');
  console.log('         (FR-088), so this check refuses rather than warns.');
  return 1;
}

try {
  process.exit(await main());
} catch (error) {
  if (error instanceof CannotRun) {
    console.error(`publication check could not run: ${error.message}`);
    console.error('');
    console.error(
      'Exit 2 is not permission to publish. A precondition that could not be evaluated has ' +
        'not been met.'
    );
    process.exit(2);
  }
  throw error;
}
