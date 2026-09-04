#!/usr/bin/env node
/**
 * The no-index gate (task T099, FR-043, SC-016; and the FR-070 clean-install row).
 *
 * THE CRITERION
 *
 * Two rows of the verification table in `contracts/distribution.md`, which are
 * really one fact seen twice:
 *
 *   No index         "Zero index bytes on disk after a clean install under the
 *                    shared name in JavaScript" (SC-016)
 *   Opt-out weather  "The peer is not auto-installed, and the library is fully
 *                    functional without it" (FR-043)
 *
 * The index is 1.6 MB, which is 92 percent of the weather package's footprint
 * and more than the entire remaining install. SC-012's budget of 1.5 MB cannot
 * absorb it, so the saving is taken by moving weather out of what the shared
 * name installs rather than by moving the index anywhere. Nothing is retrieved
 * at run time and no hosted index exists (R11): the file still ships, inside a
 * package a reader adds deliberately.
 *
 * THE MECHANISM, AND WHY IT IS EASY TO BREAK BY ACCIDENT
 *
 * `@idfkit/weather` is a `peerDependencies` entry marked `optional` in
 * `peerDependenciesMeta`, which npm 7 and later do not auto-install. That is
 * the whole of it. Three one-word edits undo it, and none of them fails a test:
 * moving the entry to `dependencies`, moving it to `optionalDependencies`
 * (which installs by DEFAULT and merely tolerates failure, despite the name),
 * or dropping the `optional: true` flag so npm treats the peer as required.
 *
 * `scripts/check-facade.mjs` reads the manifest and catches all three as
 * declarations. This gate is the other half: it runs the install and looks at
 * the disk. A manifest check and a disk check fail on different days, because
 * npm's peer behaviour is npm's, not the manifest's, and it has changed across
 * major versions before.
 *
 * WHY THE TARBALL IS DELIBERATELY AVAILABLE
 *
 * The fixture supplies an `overrides` entry pointing `@idfkit/weather` at its
 * local tarball, even though weather must not appear. An absence measured with
 * the package unavailable would prove only that the registry could not serve
 * it. Measured with the tarball sitting right there and npm free to take it,
 * the absence is evidence about `peerDependenciesMeta`, which is the thing
 * FR-043 is actually about.
 *
 * AND THE ABSENCE IS ASSERTED, NOT INFERRED
 *
 * "npm did not print it" is not evidence. The gate asks NODE to resolve
 * `@idfkit/weather` and `idfkit/weather` from inside the fixture and requires
 * both to fail, walks the whole tree for any file whose name contains
 * `stations.json`, and separately requires the library to still work. FR-043 is
 * two claims and the second one, "fully functional without it", is the one a
 * check that only counted bytes would miss.
 *
 * THE ENGINE COMES ALONG FOR THE RIDE
 *
 * `contracts/distribution.md` has a third row measured the same way: "Zero
 * bytes of engine or engine-assets in what the shared name installs" (FR-070).
 * `@idfkit/engine-assets` is 51 MB. It is the same tree walk and the same
 * resolution probe, so it is checked here rather than given a gate of its own.
 *
 * Exit codes: 0 no index and no peer, 1 either arrived, 2 could not run.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  ENGINE,
  FACADE,
  Finding,
  WEATHER,
  fixtureRoot,
  installSharedNameOrFail,
  kib,
  mib,
  packWorkspaces,
  resolveFrom,
  run,
  runInFixture,
  totals,
  verdict,
  walkFiles,
} from './lib/clean-install.mjs';

/**
 * The index, however it is named on disk.
 *
 * It ships gzipped today, as `stations.json.gz`. Matching the stem rather than
 * the exact filename means an un-gzipped or re-chunked index is still caught,
 * which matters because the compression is an implementation detail and the
 * 1.6 MB is not.
 */
const INDEX = /stations\.json/;

/** The library still works with no weather installed. FR-043's second half. */
const SMOKE = `
import { parseIdf, writeIdf, getIdfVersion } from 'idfkit';
import { schemas } from 'idfkit/node';

const source = 'Version,26.1;\\n\\nBuilding,\\n  Tower;\\n';
if (getIdfVersion(source) === undefined) {
  console.error('getIdfVersion found no version');
  process.exit(1);
}

const schema = await schemas().load('26.1.0');
const parsed = parseIdf(source, schema);
const building = parsed.document.require('Building', 'Tower');
building.set('north_axis', 30);
const text = writeIdf(parsed.document);
if (!text.includes('Building') || !text.includes('30')) {
  console.error('round trip lost the document: ' + JSON.stringify(text));
  process.exit(1);
}
console.log('OK ' + text.replace(/\\s+/g, ' ').trim());
`;

async function main() {
  const scratch = fixtureRoot('no-index');
  try {
    const { tarballs } = packWorkspaces(scratch.tarballDir);

    // The weather tarball is in the overrides, so npm could take it if the
    // manifest let it. See the header.
    const { dir, modules } = installSharedNameOrFail(scratch, tarballs, { label: 'shared-name' });

    const files = walkFiles(modules);
    const total = totals(files);
    const findings = [];

    // ---- The index --------------------------------------------------------
    const indexFiles = files.filter((file) => INDEX.test(file.relative));
    const indexBytes = indexFiles.reduce((sum, file) => sum + file.bytes, 0);
    if (indexFiles.length > 0) {
      findings.push(
        new Finding(
          `the shared name places ${mib(indexBytes)} of station index on disk in ${indexFiles.length} file(s)`,
          `${indexFiles.map((f) => f.relative).join(', ')}. SC-016 requires zero. The index is ` +
            '92 percent of the weather footprint and more than the entire rest of the install, ' +
            'so this also breaks SC-012 at the same stroke.'
        )
      );
    }

    // ---- The peer ---------------------------------------------------------
    const peerDir = join(modules, ...WEATHER.split('/'));
    const peerProbe = resolveFrom(dir, WEATHER);
    if (existsSync(peerDir) || peerProbe.resolved !== null) {
      const weatherFiles = files.filter((file) => file.relative.startsWith(`@idfkit/weather`));
      findings.push(
        new Finding(
          `${WEATHER} was auto-installed by the shared name`,
          `Node resolves it from the fixture to ${peerProbe.resolved ?? peerDir}, ` +
            `${kib(weatherFiles.reduce((s, f) => s + f.bytes, 0))} on disk. FR-043 makes it an ` +
            'optional peer precisely so npm leaves it alone. Check that ' +
            '"peerDependenciesMeta": { "@idfkit/weather": { "optional": true } } is still in the ' +
            'facade manifest, and that the entry has not moved into dependencies or ' +
            'optionalDependencies (which installs by default despite its name).'
        )
      );
    }

    // The subpath itself, reported rather than asserted on. `idfkit/weather`
    // RESOLVES with the peer absent, because weather.js is a real file that
    // ships in the facade: what fails is evaluating it, with the named-install
    // error FR-074 requires. That behaviour belongs to
    // scripts/check-absent-component.mjs; here it is printed so a reader of
    // this log is not left thinking the subpath is missing.
    const subpathProbe = resolveFrom(dir, `${FACADE}/weather`);

    // ---- The engine (FR-070) ---------------------------------------------
    for (const name of ENGINE) {
      const probe = resolveFrom(dir, name);
      const present = existsSync(join(modules, ...name.split('/')));
      if (probe.resolved !== null || present) {
        findings.push(
          new Finding(
            `${name} is in what the shared name installs`,
            '@idfkit/engine-assets is 51 MB of WebAssembly and datasets, and the two version on ' +
              'different clocks by design. Browser simulation is installed by name (FR-070).'
          )
        );
      }
    }

    // ---- Fully functional without it (FR-043) -----------------------------
    const smoke = runInFixture(dir, 'smoke.mjs', SMOKE);
    if (smoke.code !== 0) {
      findings.push(
        new Finding(
          'the library does not work with the weather peer absent',
          `Exit ${smoke.code}: ${(smoke.stderr || smoke.stdout).trim().split('\n').slice(-3).join(' ')}. ` +
            'FR-043 is two claims, and this is the second one. Zero index bytes achieved by ' +
            'breaking the install is not what the criterion asks for.'
        )
      );
    }

    console.log('idfkit-js no-index gate (FR-043, SC-016; FR-070 clean install)');
    console.log(`  measured     ${dir}`);
    console.log(`  installed    npm install ${FACADE}`);
    console.log(
      `  tree         ${total.count} files, ${kib(total.apparent)}, ` +
        `packages: ${[...new Set(files.map((f) => f.relative.split('/')[0]))].sort().join(', ')}`
    );
    console.log('');
    console.log(`  stations.json bytes on disk    ${indexBytes} (must be 0)`);
    console.log(
      `  ${WEATHER.padEnd(29)} ${peerProbe.resolved === null ? `not resolvable (${peerProbe.code})` : `RESOLVED ${peerProbe.resolved}`}`
    );
    console.log(
      `  ${`${FACADE}/weather`.padEnd(29)} ${subpathProbe.resolved === null ? `not resolvable (${subpathProbe.code})` : `resolves to ${subpathProbe.resolved}`}`
    );
    console.log(
      '               the tarball for the peer WAS available to npm during this install, and ' +
        (peerProbe.resolved === null ? 'it declined it' : 'IT TOOK IT')
    );
    for (const name of ENGINE) {
      const probe = resolveFrom(dir, name);
      console.log(
        `  ${name.padEnd(29)} ${probe.resolved === null ? `not resolvable (${probe.code})` : `RESOLVED ${probe.resolved}`}`
      );
    }
    console.log('');
    console.log(
      `  works without weather          ${smoke.code === 0 ? `yes: ${smoke.stdout.trim().slice(3, 80)}` : 'NO'}`
    );
    console.log('');

    return verdict(
      findings,
      'the shared name places zero station-index bytes on disk, does not auto-install the ' +
        'weather peer, carries no engine, and works without any of them.',
      'the shared install name brings bytes or components it should not (FR-043, SC-016).'
    );
  } finally {
    scratch.dispose();
  }
}

await run(main);
