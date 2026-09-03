#!/usr/bin/env node
/**
 * The absent-component gate (task T099a, FR-074, SC-031).
 *
 * THE CRITERION
 *
 * `contracts/distribution.md`: "Importing `idfkit/weather` without the peer
 * names the install; a project that never imports it type-checks clean", in
 * "two fixture projects". Clause 4 of the same contract adds the third thing
 * that has to be true: "`idfkit/weather` stays in the export map and resolves
 * once the peer is installed."
 *
 * So three fixtures, not two. The two the task names establish the failure and
 * the non-failure; the third is the control that stops both of them from being
 * satisfied by a subpath that is simply broken. A gate with only the first two
 * passes if `idfkit/weather` never works at all, which is not the design.
 *
 *   weather-absent   installs `idfkit` alone, imports `idfkit/weather`, and
 *                    requires the failure to NAME `npm install @idfkit/weather`
 *   core-only        installs `idfkit` alone, imports `idfkit` and
 *                    `idfkit/node` and never `idfkit/weather`, and requires
 *                    `tsc --noEmit` to report nothing and the program to run.
 *                    It reaches no scoped name at all, which is the other
 *                    half of what the facade is for (FR-036)
 *   weather-present  installs `idfkit` and the peer, imports `idfkit/weather`,
 *                    and requires it to work
 *
 * WHY THE FIRST ONE IS NOT AUTOMATIC
 *
 * The obvious implementation of the subpath, `export * from '@idfkit/weather'`,
 * cannot produce a named failure. Static re-exports are resolved and linked
 * before any module in the graph is evaluated, so no code in the shim ever
 * runs and Node reports a bare `ERR_MODULE_NOT_FOUND` naming a file path inside
 * `node_modules/idfkit`. A reader seeing that has been handed the internals of
 * a package they did not install and no instruction. `weather.js` therefore
 * uses a caught dynamic import, and this gate is what keeps it that way:
 * FAILING IS NOT ENOUGH, and the gate rejects a bare resolution error as
 * explicitly as it rejects a success.
 *
 * WHY THE SECOND ONE IS NOT AUTOMATIC EITHER
 *
 * `weather.d.ts` is `export * from '@idfkit/weather'`, a declaration file
 * referring to a package that is deliberately not installed. Whether that
 * poisons an unrelated project depends on whether TypeScript reads the file,
 * which depends on the module resolution mode and on nothing being configured
 * to pull the whole package's types in. Under `nodenext` it reads only the
 * subpath that is imported, so a project importing `idfkit` alone never sees
 * it. That is SC-031, and it is a property of a TypeScript version and a
 * tsconfig rather than of anything in this repository, which is exactly why it
 * is checked by running `tsc` rather than by reasoning about it.
 *
 * `tsc` comes from this repository's own toolchain, run against the fixture's
 * tsconfig. TypeScript resolves modules from the FILE it is compiling, so the
 * fixture's `node_modules` is what it reads; nothing of this workspace leaks in.
 *
 * Exit codes: 0 all three hold, 1 at least one does not, 2 could not run.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CannotRun,
  FACADE,
  Finding,
  REPO,
  WEATHER,
  fixtureRoot,
  installSharedNameOrFail,
  packWorkspaces,
  resolveFrom,
  run,
  runInFixture,
  verdict,
  writeJson,
} from './lib/clean-install.mjs';

/** The install the failure must name. Same constant the facade gate pins. */
const INSTALL_COMMAND = `npm install ${WEATHER}`;

/** Importing the subpath with no peer. Prints the error rather than dying on it. */
const ABSENT = `
try {
  await import('${FACADE}/weather');
  console.log('IMPORTED');
} catch (error) {
  console.log('THREW ' + error?.constructor?.name + ' ' + (error?.code ?? '-'));
  console.log('MESSAGE ' + JSON.stringify(String(error?.message ?? '')));
  console.log('CAUSE ' + JSON.stringify(String(error?.cause?.code ?? '')));
}
`;

/** Importing the subpath with the peer installed. */
const PRESENT = `
const weather = await import('${FACADE}/weather');
const direct = await import('${WEATHER}');
const missing = Object.keys(direct).filter((name) => weather[name] === undefined);
if (missing.length > 0) {
  console.error('idfkit/weather is missing ' + missing.join(', '));
  process.exit(1);
}
if (typeof weather.haversineKm !== 'function') {
  console.error('haversineKm is not a function through the subpath');
  process.exit(1);
}
const km = weather.haversineKm(45.5, -73.6, 45.5, -73.5);
console.log('OK ' + Object.keys(direct).length + ' names, haversineKm -> ' + km.toFixed(3));
`;

/**
 * A project that uses the library and never mentions weather.
 *
 * Deliberately more than an import: the declarations have to be USABLE, not
 * merely loadable, or "type-checks clean" would be satisfied by a facade whose
 * types all resolved to `any`. So the types are named explicitly and `strict`
 * is on.
 *
 * No `console` and no `process`: the fixture declares `types: []`, because a
 * project that had to install @types/node to type-check against `idfkit` would
 * be a different claim from the one SC-031 makes. Anything the check needs to
 * observe is observed from the .mjs twin below instead.
 */
const CORE_ONLY_TS = `
import { SchemaBundle, parseIdf, writeIdf, type IdfDocument } from 'idfkit';
import { schemas } from 'idfkit/node';

export async function roundTrip(source: string): Promise<string> {
  const bundle: SchemaBundle = schemas();
  const schema = await bundle.load('26.1.0');
  const parsed = parseIdf(source, schema);
  const document: IdfDocument = parsed.document;
  const building = document.require('Building', 'Tower');
  building.set('north_axis', 30);
  return writeIdf(document);
}

export const SOURCE: string = 'Version,26.1;\\n\\nBuilding,\\n  Tower;\\n';
`;

/** The same program, as JavaScript, so "builds" can be distinguished from "runs". */
const CORE_ONLY_JS = `
import { parseIdf, writeIdf } from 'idfkit';
import { schemas } from 'idfkit/node';

const schema = await schemas().load('26.1.0');
const parsed = parseIdf('Version,26.1;\\n\\nBuilding,\\n  Tower;\\n', schema);
const building = parsed.document.require('Building', 'Tower');
building.set('north_axis', 30);
const text = writeIdf(parsed.document);
if (!text.includes('Building') || !text.includes('30')) {
  console.error('round trip lost the document: ' + JSON.stringify(text));
  process.exit(1);
}
console.log('OK ' + text.replace(/\\s+/g, ' ').trim());
`;

const CORE_ONLY_TSCONFIG = {
  compilerOptions: {
    // nodenext, because that is the resolution mode that reads an `exports` map
    // and therefore the mode under which SC-031's claim is even meaningful.
    module: 'nodenext',
    moduleResolution: 'nodenext',
    target: 'es2022',
    lib: ['es2023'],
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
  },
  include: ['app.ts'],
};

/** `tsc --noEmit` over a fixture, using this repository's TypeScript. */
function typecheck(dir) {
  const tsc = join(REPO, 'node_modules', '.bin', 'tsc');
  if (!existsSync(tsc)) {
    throw new CannotRun(
      `no TypeScript at ${tsc}. Run \`npm ci\`: the gate type-checks the fixture with this ` +
        "repository's own compiler, because installing one into the fixture would need a registry."
    );
  }
  try {
    const stdout = execFileSync(tsc, ['--noEmit', '--project', join(dir, 'tsconfig.json')], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

async function main() {
  const scratch = fixtureRoot('absent-component');
  try {
    const { tarballs } = packWorkspaces(scratch.tarballDir);
    const findings = [];

    // ---- 1. weather-absent: the failure names the install ------------------
    const absent = installSharedNameOrFail(scratch, tarballs, { label: 'weather-absent' });
    if (resolveFrom(absent.dir, WEATHER).resolved !== null) {
      throw new CannotRun(
        `${WEATHER} resolves from the weather-absent fixture, so it is not absent and nothing ` +
          'this fixture reports is about the case FR-074 describes.'
      );
    }
    const absentRun = runInFixture(absent.dir, 'app.mjs', ABSENT);
    const threw = absentRun.stdout.includes('THREW');
    const message = JSON.parse((absentRun.stdout.match(/^MESSAGE (.*)$/m) ?? ['', '""'])[1]);
    const cause = JSON.parse((absentRun.stdout.match(/^CAUSE (.*)$/m) ?? ['', '""'])[1]);
    const code = (absentRun.stdout.match(/^THREW \S+ (\S+)$/m) ?? [])[1];

    if (absentRun.code !== 0) {
      findings.push(
        new Finding(
          'the weather-absent fixture could not even report the failure',
          `Exit ${absentRun.code}: ${(absentRun.stderr || absentRun.stdout).trim().split('\n').slice(-3).join(' ')}`
        )
      );
    } else if (!threw) {
      findings.push(
        new Finding(
          `importing ${FACADE}/weather succeeded with ${WEATHER} not installed`,
          'Either the peer is being auto-installed after all, which is FR-043, or the facade has ' +
            'grown an implementation of its own, which it must not have (FR-037).'
        )
      );
    } else {
      if (!message.includes(INSTALL_COMMAND)) {
        findings.push(
          new Finding(
            `importing ${FACADE}/weather fails without naming "${INSTALL_COMMAND}"`,
            `The message was: ${JSON.stringify(message.slice(0, 200))}. FR-074 requires the ` +
              'failure to name the component to install. A reader who gets a bare module error ' +
              'has been handed the internals of a package they never installed.'
          )
        );
      }
      if (code === 'ERR_MODULE_NOT_FOUND') {
        findings.push(
          new Finding(
            `importing ${FACADE}/weather raises a bare ERR_MODULE_NOT_FOUND`,
            'That is what a static `export * from "@idfkit/weather"` produces: static re-exports ' +
              'are linked before any code in weather.js runs, so the guard never executes. The ' +
              'shim has to use a caught dynamic import (FR-074).'
          )
        );
      }
      if (!message.includes(WEATHER)) {
        findings.push(
          new Finding(
            `the failure does not name ${WEATHER}`,
            `The message was: ${JSON.stringify(message.slice(0, 200))}.`
          )
        );
      }
    }

    // ---- 2. core-only: builds and type-checks clean -------------------------
    const coreOnly = installSharedNameOrFail(scratch, tarballs, { label: 'core-only' });
    writeFileSync(join(coreOnly.dir, 'app.ts'), CORE_ONLY_TS);
    writeJson(join(coreOnly.dir, 'tsconfig.json'), CORE_ONLY_TSCONFIG);
    const types = typecheck(coreOnly.dir);
    if (types.code !== 0) {
      const diagnostics = types.output.trim().split('\n').filter(Boolean);
      findings.push(
        new Finding(
          `a project that imports only ${FACADE} does not type-check with the peer absent`,
          `tsc reported ${diagnostics.length} diagnostic(s): ` +
            `${diagnostics.slice(0, 5).join(' | ')}. SC-031: the facade's own weather.d.ts is ` +
            "`export * from '@idfkit/weather'`, and TypeScript must only read it when something " +
            'imports the subpath. A project that never does must not pay for the peer being ' +
            'absent.'
        )
      );
    }

    // "Builds" is not "type-checks". Run it.
    const coreOnlyRun = runInFixture(coreOnly.dir, 'app.mjs', CORE_ONLY_JS);
    if (coreOnlyRun.code !== 0) {
      findings.push(
        new Finding(
          `a project that imports only ${FACADE} does not run with the peer absent`,
          `Exit ${coreOnlyRun.code}: ${(coreOnlyRun.stderr || coreOnlyRun.stdout).trim().split('\n').slice(-3).join(' ')}`
        )
      );
    }

    // ---- 3. weather-present: the control -----------------------------------
    const present = installSharedNameOrFail(scratch, tarballs, {
      label: 'weather-present',
      also: [WEATHER],
    });
    const presentRun = runInFixture(present.dir, 'app.mjs', PRESENT);
    if (presentRun.code !== 0) {
      findings.push(
        new Finding(
          `${FACADE}/weather does not work once ${WEATHER} is installed`,
          `Exit ${presentRun.code}: ${(presentRun.stderr || presentRun.stdout).trim().split('\n').slice(-3).join(' ')}. ` +
            'Clause 4 of contracts/distribution.md: the subpath stays in the export map and ' +
            'resolves once the peer is installed. Without this control the two fixtures above ' +
            'would both pass on a subpath that is simply broken.'
        )
      );
    }

    console.log('idfkit-js absent-component gate (FR-074, SC-031)');
    console.log(`  fixtures     ${scratch.root}/fixtures`);
    console.log('');
    console.log('  1. weather-absent   npm install idfkit, then import idfkit/weather');
    console.log(`       threw          ${threw ? `yes (code ${code ?? '-'}, cause ${cause || '-'})` : 'NO, it succeeded'}`);
    console.log(`       names install   ${message.includes(INSTALL_COMMAND) ? `yes: "${INSTALL_COMMAND}"` : 'NO'}`);
    console.log(`       first line     ${message.split('\n')[0].slice(0, 96)}`);
    console.log('');
    console.log('  2. core-only        npm install idfkit; imports idfkit and idfkit/node only');
    console.log(
      `       tsc --noEmit   ${types.code === 0 ? 'clean' : `${types.output.trim().split('\n').length} diagnostic(s)`} (module nodenext, strict, skipLibCheck off)`
    );
    console.log(
      `       runs           ${coreOnlyRun.code === 0 ? `yes: ${coreOnlyRun.stdout.trim().slice(3, 76)}` : 'NO'}`
    );
    console.log('');
    console.log('  3. weather-present  npm install idfkit @idfkit/weather (the control)');
    console.log(
      `       subpath works  ${presentRun.code === 0 ? `yes: ${presentRun.stdout.trim().slice(3, 76)}` : 'NO'}`
    );
    console.log('');

    return verdict(
      findings,
      `importing ${FACADE}/weather without the peer names the install, a project that never ` +
        'imports it type-checks and runs clean, and the subpath works once the peer is added.',
      'the absent opt-in component does not behave as FR-074 and SC-031 require.'
    );
  } finally {
    scratch.dispose();
  }
}

await run(main);
