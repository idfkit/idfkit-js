#!/usr/bin/env node
/**
 * The install-size gate for the shared name (task T096, SC-012).
 *
 * THE CRITERION
 *
 * `contracts/distribution.md`: "Under 1.75 MB on disk under the shared name in
 * JavaScript, no opt-in component installed". So: pack the workspace, install
 * `idfkit` and nothing else into an isolated project, and measure.
 *
 * WHICH 1.75 MB, AND WHICH "ON DISK"
 *
 * Both halves of that sentence need pinning down, because the two readings of
 * "on disk" now disagree about the verdict rather than merely about the number.
 *
 *   1.75 MB     is 1.75 MiB, 1,835,008 bytes. Every other size in the contract
 *               is quoted the way npm quotes them, and npm's are binary.
 *
 *   on disk     is APPARENT bytes: the sum of the file sizes, which is what
 *               npm's own `unpackedSize` reports and what every install-size
 *               tool built on the registry means.
 *
 * The alternative reading, allocated blocks, is the one `du` gives. Measured on
 * 2026-09-04, across 164 files:
 *
 *       1.71 MB apparent          97.9 percent of the budget
 *       2.08 MB by du -sk         119 percent of the budget
 *
 * The 378 KB between them is not weight in the package. It is the filesystem
 * rounding 164 mostly-small files up to its allocation unit, 4 KB on the ext4
 * of a GitHub runner and on the APFS of a laptop. That number would move on a
 * tmpfs, on ZFS with compression, on a filesystem with tail packing, and on any
 * runner image that changes its storage driver. A criterion whose verdict
 * depends on which machine picked up the job is not a criterion, and it is not
 * one the package can be engineered against either: the only way to improve an
 * allocation figure is to ship fewer, larger files, which is a worse package.
 *
 * So the gate FAILS ON THE APPARENT FIGURE ONLY, and PRINTS BOTH. What `du`
 * reports is printed for honesty and is never measured against. The pessimistic
 * number is not hidden, because a gate that quietly picks the flattering
 * measure is the thing this whole contract is written against.
 *
 * That distinction used to cost nothing here and now decides the outcome. At
 * the previous measurement both readings sat inside the budget; the schema
 * prose has since landed, and the allocated figure is now over it while the
 * apparent one passes with 38 KB to spare. Which is why the choice of measure
 * was settled on the principle above, at a moment when it changed no verdict,
 * rather than now, when it decides one.
 *
 * WHY 1.75 MB, AND WHAT IT WAS BEFORE
 *
 * SC-012 read "under 1.5 MB" until 2026-09-03 and was amended to 1.75 MB, in a
 * change that did nothing else. The reason: describing an object type must
 * return the schema's explanatory prose in both languages, and that prose costs
 * 190,471 bytes gzipped for all seventeen supported versions, deduplicated to
 * 4,772 distinct strings plus the references that make them reachable. Against
 * 1.5 MiB that landed the install at 100.5 percent, over by 8,352 bytes.
 *
 * The budget is self-imposed. No registry limit is anywhere near it: SC-012 is
 * an improvement target set against this project's own former footprint of
 * roughly 7.9 MB, and this repository publishes a 2.9 MB type package and 51 MB
 * of engine assets without difficulty. So the question was whether the prose is
 * a core capability or an optional component, and it is the former: prose is
 * part of describing a type, not a component a reader adds.
 *
 * 1.6 MiB was rejected. It clears the measurement and leaves 96 KB of slack,
 * less than the install has today, so it buys one feature and reopens this
 * conversation with less room to have it in. 1.75 MiB is the round binary
 * figure nearest the number that preserves the headroom the budget was
 * originally set with, and it keeps what SC-012 is for: a 4.3x reduction from
 * 7.9 MB, against 5.0x under the old figure.
 *
 * HEADROOM, AND WHAT THE INCREASE WAS FOR
 *
 * The increase has been spent, on the thing it was raised for. 1.71 of 1.75 MB
 * is 97.9 percent, about 38 KB of slack, with the prose in `@idfkit/schemas`
 * and the syntax layer in `@idfkit/core`. The language service is not in this
 * measurement at all: it is an optional peer, so it puts nothing on disk here,
 * and the per-package breakdown is what would say otherwise, since a package
 * the contract does not list is a finding whether or not the total passes.
 *
 * 38 KB is thin, and it is meant to be read that way. The gate therefore does
 * not just print PASS: it prints the percentage, the remaining headroom, and
 * the per-package breakdown, so the number that matters is visible in the log
 * of every run rather than only in the run that finally fails. The next feature
 * that wants to add weight to either installed package should expect to argue
 * for it, and either amend SC-012 deliberately or move the weight to an opt-in
 * component, which is the choice this budget exists to force.
 *
 * WHAT IS COUNTED
 *
 * Everything under the fixture's `node_modules`, including npm's own
 * `.package-lock.json`. That file is roughly 2 KB and is genuinely on the
 * reader's disk after the install, so excluding it would be a small lie in the
 * gate's favour.
 *
 * Exit codes: 0 under budget, 1 over, 2 could not measure.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  CORE,
  ENGINE,
  FACADE,
  Finding,
  SCHEMAS,
  TYPE_PACKAGES,
  WEATHER,
  fixtureRoot,
  installSharedNameOrFail,
  kib,
  mib,
  packWorkspaces,
  packageOf,
  resolveFrom,
  run,
  totals,
  verdict,
  walkFiles,
} from './lib/clean-install.mjs';

/** SC-012, in bytes. 1.75 MiB. */
const BUDGET = Math.round(1.75 * 1024 * 1024);

/** What the shared name is allowed to put on disk. Anything else is a finding. */
const EXPECTED = new Set([FACADE, CORE, SCHEMAS]);

/** What must not be there, because it is opt-in or is the engine (FR-043, FR-070). */
const FORBIDDEN = [WEATHER, ...TYPE_PACKAGES, ...ENGINE];

async function main() {
  const scratch = fixtureRoot('install-size');
  try {
    const { tarballs } = packWorkspaces(scratch.tarballDir);
    const { dir, modules } = installSharedNameOrFail(scratch, tarballs, { label: 'shared-name' });

    if (!existsSync(modules)) throw new Error(`npm install produced no node_modules in ${dir}`);

    const files = walkFiles(modules);
    const total = totals(files);
    const findings = [];

    // Per package, so an over-budget run says which package grew.
    const byPackage = new Map();
    for (const file of files) {
      const name = packageOf(file.relative);
      const entry = byPackage.get(name) ?? { bytes: 0, count: 0 };
      entry.bytes += file.bytes;
      entry.count += 1;
      byPackage.set(name, entry);
    }

    const percent = (total.apparent / BUDGET) * 100;
    const headroom = BUDGET - total.apparent;

    console.log('idfkit-js install-size gate (SC-012)');
    console.log(`  measured     ${dir}`);
    console.log(`  installed    npm install ${FACADE}, no opt-in component`);
    console.log('');
    console.log(`  apparent     ${total.apparent.toLocaleString()} bytes  ${mib(total.apparent)}   <- the criterion`);
    console.log(
      `  allocated    ${total.allocated === null ? '(not available on this platform)' : `${total.allocated.toLocaleString()} bytes  ${mib(total.allocated)}   what du -sk reports; filesystem-dependent, not measured against`}`
    );
    console.log(`  files        ${total.count}`);
    console.log('');
    console.log(`  budget       ${BUDGET.toLocaleString()} bytes  ${mib(BUDGET)} (1.75 MiB)`);
    console.log(
      `  used         ${percent.toFixed(1)} percent of budget, ` +
        (headroom < 0
          ? `${kib(-headroom)} OVER`
          : `${kib(headroom)} headroom${percent >= 80 ? '   <- thin' : ''}`)
    );
    console.log('');
    console.log('  on disk, by package');
    for (const [name, entry] of [...byPackage].sort((a, b) => b[1].bytes - a[1].bytes)) {
      console.log(
        `    ${name.padEnd(20)} ${kib(entry.bytes).padStart(10)}  ${String(entry.count).padStart(4)} files`
      );
    }
    console.log('');

    if (total.apparent > BUDGET) {
      const over = total.apparent - BUDGET;
      findings.push(
        new Finding(
          `the shared name places ${mib(total.apparent)} on disk, ${kib(over)} over the ${mib(BUDGET)} budget`,
          'SC-012. The largest contributors are listed above. Weather and the generated type ' +
            'packages are already out of this install by design; anything that pushed it over ' +
            'is new weight in @idfkit/core or @idfkit/schemas, or a dependency that arrived ' +
            'without a decision.'
        )
      );
    }

    // "No opt-in component installed" is half the criterion, and npm not
    // printing a package is not evidence. Ask Node to resolve each one and
    // require the resolution to fail.
    for (const name of FORBIDDEN) {
      const probe = resolveFrom(dir, name);
      const present = existsSync(join(modules, ...name.split('/')));
      if (probe.resolved !== null || present) {
        findings.push(
          new Finding(
            `${name} is installed by the shared name`,
            `Resolved from the fixture to ${probe.resolved ?? join(modules, name)}. SC-012 ` +
              'measures an install with no opt-in component in it, so this measurement would ' +
              'not be the one the criterion is about even if it came in under budget.'
          )
        );
      }
    }

    const unexpected = [...byPackage.keys()].filter(
      (name) => !EXPECTED.has(name) && !name.startsWith('.')
    );
    if (unexpected.length > 0) {
      findings.push(
        new Finding(
          `the shared name installs ${unexpected.join(', ')}, which the contract does not list`,
          'contracts/distribution.md says the shared name installs the facade, @idfkit/core and ' +
            '@idfkit/schemas. A fourth package is either a new dependency that needs a decision ' +
            'or a peer that stopped being optional.'
        )
      );
    }

    return verdict(
      findings,
      `the shared name places ${mib(total.apparent)} on disk, ${percent.toFixed(1)} percent of the ${mib(BUDGET)} budget.`,
      'the shared install name does not meet SC-012.'
    );
  } finally {
    scratch.dispose();
  }
}

await run(main);
