#!/usr/bin/env node
/**
 * The `--ignore-scripts` gate (task T098, SC-015, FR-042).
 *
 * THE CRITERION
 *
 * `contracts/distribution.md`: "Install succeeds with `--ignore-scripts`".
 * Behind that one line is a rejected design. Generating the per-version type
 * declarations in a `postinstall` script was the obvious way to avoid shipping
 * 5.3 MB of them, and it was rejected because install-time scripting is
 * silently skipped in exactly the places where the failure is hardest to see:
 *
 *   npm install --ignore-scripts        a common hardening default;
 *   npm config set ignore-scripts true  set once, forgotten, machine-wide;
 *   Yarn PnP, pnpm with side-effects    cache-restricted by policy;
 *     caching disabled, Dependabot,
 *     Renovate, many corporate mirrors
 *
 * In all of them the install SUCCEEDS and the package is quietly incomplete.
 * The user then gets a module-not-found for a file that was supposed to be
 * generated, from a package that reported a clean install, and no message
 * anywhere connects the two.
 *
 * SO THE GATE CHECKS TWO THINGS, NOT ONE
 *
 *   1. THE MANIFESTS. No package that the shared name installs may declare a
 *      lifecycle script at all: `preinstall`, `install`, `postinstall`,
 *      `prepare`, `prepublish`. This is the static half, and it is the half
 *      that catches the mistake on the day it is made.
 *
 *   2. THE BEHAVIOUR. Install the same set twice, once normally and once with
 *      `--ignore-scripts`, and require that the two trees are IDENTICAL file
 *      for file and byte for byte, and that the library works in both. A
 *      package could always acquire a script through a dependency, or generate
 *      something from a `prepare` in a transitive package, and the only way to
 *      know the flag changes nothing is to run both and compare.
 *
 * A file-set comparison is the sharp instrument here. "The install exited 0" is
 * nearly worthless on its own, because a skipped postinstall is a SUCCESSFUL
 * install: that is the entire problem. What tells you something is a file that
 * exists in one tree and not the other.
 *
 * Exit codes: 0 nothing depends on scripting, 1 something does, 2 could not run.
 */

import { existsSync } from 'node:fs';

import {
  Finding,
  fixtureRoot,
  installSharedName,
  installSharedNameOrFail,
  kib,
  packWorkspaces,
  run,
  runInFixture,
  totals,
  verdict,
  walkFiles,
} from './lib/clean-install.mjs';

/**
 * Every npm lifecycle hook that runs as part of an install and is skipped by
 * `--ignore-scripts`. `prepare` is on the list because it runs on `npm install`
 * for a git dependency and on `npm pack` for a published one, so a package that
 * leans on it is as fragile as one leaning on `postinstall`.
 */
const LIFECYCLE = [
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'prepare',
];

/** Proof the library works, run against both trees. */
const SMOKE = `
import { SchemaBundle, parseIdf, writeIdf } from 'idfkit';
import { schemas } from 'idfkit/node';

const schema = await schemas().load('26.1.0');
const parsed = parseIdf('Version,26.1;\\n\\nBuilding,\\n  Tower;\\n', schema);
const text = writeIdf(parsed.document);
if (!text.includes('Building')) {
  console.error('round trip lost the document');
  process.exit(1);
}
console.log('OK ' + (typeof SchemaBundle === 'function'));
`;

/** A file list keyed by path, so two trees can be diffed exactly. */
function index(files) {
  const map = new Map();
  for (const file of files) map.set(file.relative, file.bytes);
  return map;
}

async function main() {
  const scratch = fixtureRoot('ignore-scripts');
  try {
    const { tarballs, packages } = packWorkspaces(scratch.tarballDir);
    const findings = [];

    // ---- 1. The manifests -------------------------------------------------
    const declared = [];
    for (const [name, entry] of packages) {
      const scripts = entry.manifest.scripts ?? {};
      const hooks = LIFECYCLE.filter((hook) => scripts[hook] !== undefined);
      if (hooks.length === 0) continue;
      declared.push({ name, hooks });
      findings.push(
        new Finding(
          `${name} declares an install lifecycle script: ${hooks.join(', ')}`,
          'FR-042 rejects install-time scripting outright. Under --ignore-scripts, and under the ' +
            'ignore-scripts config many CI images and corporate mirrors set, the hook is skipped ' +
            'and the install still reports success, so whatever it was going to produce is ' +
            'missing exactly where nobody is looking. Whatever this script does at install time ' +
            'has to be done before publication and shipped in the tarball instead.'
        )
      );
    }

    // ---- 2. The behaviour -------------------------------------------------
    const plain = installSharedNameOrFail(scratch, tarballs, { label: 'with-scripts' });
    const guarded = installSharedName(scratch, tarballs, {
      label: 'ignore-scripts',
      flags: ['--ignore-scripts'],
    });

    if (guarded.install.code !== 0) {
      findings.push(
        new Finding(
          `npm install --ignore-scripts failed with exit ${guarded.install.code}`,
          `npm said: ${guarded.install.stderr.trim().split('\n').slice(-4).join(' ')}. SC-015 ` +
            'requires the install itself to succeed with the flag, before anything is asked ' +
            'about what it produced.'
        )
      );
    }

    const plainFiles = index(walkFiles(plain.modules));
    const guardedFiles = existsSync(guarded.modules)
      ? index(walkFiles(guarded.modules))
      : new Map();

    // npm records the flag it installed under in .package-lock.json, so that one
    // file legitimately differs and comparing it would report a difference that
    // is the flag itself rather than an effect of the flag.
    const ignore = (path) => path === '.package-lock.json';

    const missing = [...plainFiles.keys()].filter((p) => !ignore(p) && !guardedFiles.has(p));
    const added = [...guardedFiles.keys()].filter((p) => !ignore(p) && !plainFiles.has(p));
    const differing = [...plainFiles.keys()].filter(
      (p) => !ignore(p) && guardedFiles.has(p) && guardedFiles.get(p) !== plainFiles.get(p)
    );

    if (missing.length > 0) {
      findings.push(
        new Finding(
          `${missing.length} file(s) exist after a normal install and not after --ignore-scripts`,
          `${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', ...' : ''}. Something in ` +
            'the install produces these at install time. Under --ignore-scripts the install ' +
            'still succeeds and they are simply absent, which is the silent-breakage mode ' +
            'FR-042 exists to prevent.'
        )
      );
    }
    if (added.length > 0) {
      findings.push(
        new Finding(
          `${added.length} file(s) exist only after --ignore-scripts`,
          `${added.slice(0, 6).join(', ')}. Unexpected in either direction: the flag should ` +
            'change nothing at all.'
        )
      );
    }
    if (differing.length > 0) {
      findings.push(
        new Finding(
          `${differing.length} file(s) differ in size between the two installs`,
          `${differing.slice(0, 6).join(', ')}. A file rewritten by a lifecycle script.`
        )
      );
    }

    const plainSmoke = runInFixture(plain.dir, 'smoke.mjs', SMOKE);
    const guardedSmoke =
      guarded.install.code === 0
        ? runInFixture(guarded.dir, 'smoke.mjs', SMOKE)
        : { code: 1, stdout: '', stderr: 'install failed' };

    for (const [label, result] of [
      ['a normal install', plainSmoke],
      ['an --ignore-scripts install', guardedSmoke],
    ]) {
      if (result.code !== 0) {
        findings.push(
          new Finding(
            `the library does not work after ${label}`,
            `Exit ${result.code}: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`
          )
        );
      }
    }

    const plainTotals = totals([...plainFiles].map(([relative, bytes]) => ({ relative, bytes })));
    const guardedTotals = totals(
      [...guardedFiles].map(([relative, bytes]) => ({ relative, bytes }))
    );

    console.log('idfkit-js --ignore-scripts gate (SC-015, FR-042)');
    console.log(`  packages     ${packages.size} packed, ${declared.length} declaring a lifecycle hook`);
    for (const [name, entry] of packages) {
      const scripts = Object.keys(entry.manifest.scripts ?? {}).filter((s) =>
        LIFECYCLE.includes(s)
      );
      console.log(`    ${name.padEnd(22)} ${scripts.length === 0 ? 'none' : scripts.join(', ')}`);
    }
    console.log('');
    console.log(`  npm install                    exit ${plain.install.code}, ${plainTotals.count} files, ${kib(plainTotals.apparent)}`);
    console.log(
      `  npm install --ignore-scripts   exit ${guarded.install.code}, ${guardedTotals.count} files, ${kib(guardedTotals.apparent)}`
    );
    console.log(
      `  tree difference                ${missing.length} missing, ${added.length} added, ${differing.length} resized` +
        ' (.package-lock.json excluded: it records the flag)'
    );
    console.log(`  round trip, normal             ${plainSmoke.code === 0 ? 'works' : 'FAILS'}`);
    console.log(`  round trip, ignore-scripts     ${guardedSmoke.code === 0 ? 'works' : 'FAILS'}`);
    console.log('');

    return verdict(
      findings,
      'nothing the shared name installs depends on install-time scripting: no lifecycle hooks, ' +
        'identical trees, working library either way.',
      'the install depends on scripting that --ignore-scripts silently skips (SC-015).'
    );
  } finally {
    scratch.dispose();
  }
}

await run(main);
