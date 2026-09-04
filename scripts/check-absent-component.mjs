#!/usr/bin/env node
/**
 * The absent-component gate (task T099a, FR-074, SC-031; task T031, FR-046).
 *
 * THE CRITERION
 *
 * `contracts/distribution.md`: "Importing `idfkit/weather` without the peer
 * names the install; a project that never imports it type-checks clean", in
 * "two fixture projects". Clause 4 of the same contract adds the third thing
 * that has to be true: "`idfkit/weather` stays in the export map and resolves
 * once the peer is installed."
 *
 * So three claims, not two. The two the task names establish the failure and
 * the non-failure; the third is the control that stops both of them from being
 * satisfied by a subpath that is simply broken. A gate with only the first two
 * passes if `idfkit/weather` never works at all, which is not the design.
 *
 * FR-046 makes the same three claims about `idfkit/language`, in the same
 * words, because `@idfkit/language` is an optional peer for the same reason:
 * "Reaching the service through the shared name MUST work once its component is
 * installed, and MUST fail with a message naming the component to install when
 * it is not. A project that never reaches for it MUST build and type-check
 * cleanly with the component absent."
 *
 * Hence the component table below, rather than a second copy of this file. Two
 * components, three claims each, five fixtures:
 *
 *   weather-absent    installs `idfkit` alone, imports `idfkit/weather`, and
 *                     requires the failure to NAME `npm install @idfkit/weather`
 *   language-absent   the same, for `idfkit/language`
 *   core-only         installs `idfkit` alone, imports `idfkit` and
 *                     `idfkit/node` and NEITHER opt-in subpath, and requires
 *                     `tsc --noEmit` to report nothing and the program to run.
 *                     It reaches no scoped name at all, which is the other
 *                     half of what the facade is for (FR-036)
 *   weather-present   installs `idfkit` and the peer, imports `idfkit/weather`,
 *                     and requires it to work
 *   language-present  the same, for `idfkit/language`
 *
 * Five fixtures and not six, because the middle claim is one claim. It is about
 * a project that imports NEITHER subpath, and `core-only` is already that
 * project: both peers are absent from it, and it proves both absences by asking
 * Node to resolve each and requiring each to fail. A second fixture installing
 * the same manifest and compiling the same file would measure the same thing
 * twice and cost another `npm install` to do it.
 *
 * WHY THE FIRST CLAIM IS NOT AUTOMATIC
 *
 * The obvious implementation of a subpath, `export * from '@idfkit/weather'`,
 * cannot produce a named failure. Static re-exports are resolved and linked
 * before any module in the graph is evaluated, so no code in the shim ever
 * runs and Node reports a bare `ERR_MODULE_NOT_FOUND` naming a file path inside
 * `node_modules/idfkit`. A reader seeing that has been handed the internals of
 * a package they did not install and no instruction. `weather.js` and
 * `language.js` therefore use a caught dynamic import, and this gate is what
 * keeps them that way: FAILING IS NOT ENOUGH, and the gate rejects a bare
 * resolution error as explicitly as it rejects a success.
 *
 * WHY THE SECOND CLAIM IS NOT AUTOMATIC EITHER
 *
 * `weather.d.ts` and `language.d.ts` are each `export * from` a package that is
 * deliberately not installed. Whether that poisons an unrelated project depends
 * on whether TypeScript reads the file, which depends on the module resolution
 * mode and on nothing being configured to pull the whole package's types in.
 * Under `nodenext` it reads only the subpath that is imported, so a project
 * importing `idfkit` alone never sees either. That is SC-031 and the last
 * sentence of FR-046, and it is a property of a TypeScript version and a
 * tsconfig rather than of anything in this repository, which is exactly why it
 * is checked by running `tsc` rather than by reasoning about it. Two
 * unresolvable declaration files are also strictly more exposure than one: a
 * resolution mode that read them eagerly would now poison the project twice.
 *
 * `tsc` comes from this repository's own toolchain, run against the fixture's
 * tsconfig. TypeScript resolves modules from the FILE it is compiling, so the
 * fixture's `node_modules` is what it reads; nothing of this workspace leaks in.
 *
 * Exit codes: 0 all of it holds, 1 at least one claim does not, 2 could not run.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CannotRun,
  FACADE,
  Finding,
  LANGUAGE,
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


/**
 * Importing an opt-in subpath with no peer. Prints the error rather than dying
 * on it, because the message is the thing being checked.
 */
function absentProgram(subpath) {
  return `
try {
  await import('${FACADE}/${subpath}');
  console.log('IMPORTED');
} catch (error) {
  console.log('THREW ' + error?.constructor?.name + ' ' + (error?.code ?? '-'));
  console.log('MESSAGE ' + JSON.stringify(String(error?.message ?? '')));
  console.log('CAUSE ' + JSON.stringify(String(error?.cause?.code ?? '')));
}
`;
}

/**
 * Importing an opt-in subpath with the peer installed.
 *
 * Two halves, and both matter. The generic half compares the subpath's runtime
 * names against the peer's own, which is what catches a hand-written re-export
 * list that has fallen behind. The `probe` half calls something, because a
 * subpath every one of whose names is `undefined` would satisfy the first half
 * perfectly.
 */
function presentProgram(peer, subpath, probe) {
  return `
const viaFacade = await import('${FACADE}/${subpath}');
const direct = await import('${peer}');
const missing = Object.keys(direct).filter((name) => viaFacade[name] === undefined);
if (missing.length > 0) {
  console.error('${FACADE}/${subpath} is missing ' + missing.join(', '));
  process.exit(1);
}
${probe}
`;
}

const WEATHER_PROBE = `
if (typeof viaFacade.haversineKm !== 'function') {
  console.error('haversineKm is not a function through the subpath');
  process.exit(1);
}
const km = viaFacade.haversineKm(45.5, -73.6, 45.5, -73.5);
console.log('OK ' + Object.keys(direct).length + ' names, haversineKm -> ' + km.toFixed(3));
`;

// contextAt with no schema, which the contract says is a supported call: without
// one the context still reports where the offset is. The returned value is
// checked for not being a promise, because the whole design claim of
// @idfkit/language is that its answers are synchronous (FR-024), and an
// asynchronous module graph behind the facade is exactly where that could be
// lost without anyone noticing.
const LANGUAGE_PROBE = `
if (typeof viaFacade.contextAt !== 'function') {
  console.error('contextAt is not a function through the subpath');
  process.exit(1);
}
const context = viaFacade.contextAt('Version,26.1;\\n', 3);
if (context === null || typeof context !== 'object' || typeof context.then === 'function') {
  console.error('contextAt did not return a synchronous context: ' + JSON.stringify(context));
  process.exit(1);
}
console.log('OK ' + Object.keys(direct).length + ' names, contextAt -> at ' + context.at);
`;

/**
 * The two opt-in components, and what each of the three claims means for each.
 *
 * `install` is the exact command the failure must name, and it is the same
 * string `check-facade.mjs` pins: the two gates would otherwise agree on the
 * requirement and disagree on the text.
 */
const COMPONENTS = [
  {
    peer: WEATHER,
    subpath: 'weather',
    install: `npm install ${WEATHER}`,
    probe: WEATHER_PROBE,
  },
  {
    peer: LANGUAGE,
    subpath: 'language',
    install: `npm install ${LANGUAGE}`,
    probe: LANGUAGE_PROBE,
  },
];

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

    // ---- 1. one absent fixture per component: the failure names the install
    const absences = [];
    for (const component of COMPONENTS) {
      const label = `${component.subpath}-absent`;
      const fixture = installSharedNameOrFail(scratch, tarballs, { label });

      // Positive proof of absence. An absence you did not try to resolve is an
      // absence you did not check, and this one produced a false green once.
      if (resolveFrom(fixture.dir, component.peer).resolved !== null) {
        throw new CannotRun(
          `${component.peer} resolves from the ${label} fixture, so it is not absent and ` +
            'nothing this fixture reports is about the case FR-074 and FR-046 describe.'
        );
      }

      const ran = runInFixture(fixture.dir, 'app.mjs', absentProgram(component.subpath));
      const threw = ran.stdout.includes('THREW');
      const message = JSON.parse((ran.stdout.match(/^MESSAGE (.*)$/m) ?? ['', '""'])[1]);
      const cause = JSON.parse((ran.stdout.match(/^CAUSE (.*)$/m) ?? ['', '""'])[1]);
      const code = (ran.stdout.match(/^THREW \S+ (\S+)$/m) ?? [])[1];
      absences.push({ component, ran, threw, message, cause, code });

      const subpath = `${FACADE}/${component.subpath}`;
      if (ran.code !== 0) {
        findings.push(
          new Finding(
            `the ${label} fixture could not even report the failure`,
            `Exit ${ran.code}: ${(ran.stderr || ran.stdout).trim().split('\n').slice(-3).join(' ')}`
          )
        );
        continue;
      }
      if (!threw) {
        findings.push(
          new Finding(
            `importing ${subpath} succeeded with ${component.peer} not installed`,
            'Either the peer is being auto-installed after all, which is FR-043, or the facade ' +
              'has grown an implementation of its own, which it must not have (FR-037).'
          )
        );
        continue;
      }
      if (!message.includes(component.install)) {
        findings.push(
          new Finding(
            `importing ${subpath} fails without naming "${component.install}"`,
            `The message was: ${JSON.stringify(message.slice(0, 200))}. FR-074 and FR-046 ` +
              'require the failure to name the component to install. A reader who gets a bare ' +
              'module error has been handed the internals of a package they never installed.'
          )
        );
      }
      if (code === 'ERR_MODULE_NOT_FOUND') {
        findings.push(
          new Finding(
            `importing ${subpath} raises a bare ERR_MODULE_NOT_FOUND`,
            `That is what a static \`export * from "${component.peer}"\` produces: static ` +
              're-exports are linked before any code in the shim runs, so the guard never ' +
              'executes. The shim has to use a caught dynamic import (FR-074, FR-046).'
          )
        );
      }
      if (!message.includes(component.peer)) {
        findings.push(
          new Finding(
            `the failure does not name ${component.peer}`,
            `The message was: ${JSON.stringify(message.slice(0, 200))}.`
          )
        );
      }
    }

    // ---- 2. core-only: builds and type-checks clean, with BOTH peers absent -
    //
    // One fixture, two components. The claim is about a project that imports
    // neither opt-in subpath, and this is that project: it installs the shared
    // name alone, so `weather.d.ts` and `language.d.ts` both sit in its
    // node_modules pointing at packages that are not there.
    const coreOnly = installSharedNameOrFail(scratch, tarballs, { label: 'core-only' });
    for (const component of COMPONENTS) {
      if (resolveFrom(coreOnly.dir, component.peer).resolved !== null) {
        throw new CannotRun(
          `${component.peer} resolves from the core-only fixture, so this fixture is not the ` +
            'project the criterion is about and its clean type-check would prove nothing.'
        );
      }
    }
    writeFileSync(join(coreOnly.dir, 'app.ts'), CORE_ONLY_TS);
    writeJson(join(coreOnly.dir, 'tsconfig.json'), CORE_ONLY_TSCONFIG);
    const types = typecheck(coreOnly.dir);
    if (types.code !== 0) {
      const diagnostics = types.output.trim().split('\n').filter(Boolean);
      findings.push(
        new Finding(
          `a project that imports only ${FACADE} does not type-check with the peers absent`,
          `tsc reported ${diagnostics.length} diagnostic(s): ` +
            `${diagnostics.slice(0, 5).join(' | ')}. SC-031 and FR-046: the facade's own ` +
            'weather.d.ts and language.d.ts are each `export * from` an absent package, and ' +
            'TypeScript must only read one when something imports its subpath. A project that ' +
            'never does must not pay for either peer being absent.'
        )
      );
    }

    // "Builds" is not "type-checks". Run it.
    const coreOnlyRun = runInFixture(coreOnly.dir, 'app.mjs', CORE_ONLY_JS);
    if (coreOnlyRun.code !== 0) {
      findings.push(
        new Finding(
          `a project that imports only ${FACADE} does not run with the peers absent`,
          `Exit ${coreOnlyRun.code}: ${(coreOnlyRun.stderr || coreOnlyRun.stdout).trim().split('\n').slice(-3).join(' ')}`
        )
      );
    }

    // ---- 3. one present fixture per component: the control ------------------
    const presences = [];
    for (const component of COMPONENTS) {
      const label = `${component.subpath}-present`;
      const fixture = installSharedNameOrFail(scratch, tarballs, {
        label,
        also: [component.peer],
      });
      const ran = runInFixture(
        fixture.dir,
        'app.mjs',
        presentProgram(component.peer, component.subpath, component.probe)
      );
      presences.push({ component, ran });
      if (ran.code !== 0) {
        findings.push(
          new Finding(
            `${FACADE}/${component.subpath} does not work once ${component.peer} is installed`,
            `Exit ${ran.code}: ${(ran.stderr || ran.stdout).trim().split('\n').slice(-3).join(' ')}. ` +
              'Clause 4 of contracts/distribution.md, and FR-046: the subpath stays in the ' +
              'export map and resolves once the peer is installed. Without this control the ' +
              'fixtures above would both pass on a subpath that is simply broken.'
          )
        );
      }
    }

    console.log('idfkit-js absent-component gate (FR-074, FR-046, SC-031)');
    console.log(`  fixtures     ${scratch.root}/fixtures`);
    console.log('');
    let step = 0;
    for (const { component, threw, message, cause, code } of absences) {
      step += 1;
      const subpath = `${FACADE}/${component.subpath}`;
      console.log(
        `  ${step}. ${component.subpath}-absent`.padEnd(22) +
          `npm install ${FACADE}, then import ${subpath}`
      );
      console.log(
        `       threw          ${threw ? `yes (code ${code ?? '-'}, cause ${cause || '-'})` : 'NO, it succeeded'}`
      );
      console.log(
        `       names install  ${message.includes(component.install) ? `yes: "${component.install}"` : 'NO'}`
      );
      console.log(`       first line     ${message.split('\n')[0].slice(0, 96)}`);
      console.log('');
    }
    step += 1;
    console.log(
      `  ${step}. core-only`.padEnd(22) +
        `npm install ${FACADE}; imports ${FACADE} and ${FACADE}/node only`
    );
    console.log(
      `       tsc --noEmit   ${types.code === 0 ? 'clean' : `${types.output.trim().split('\n').length} diagnostic(s)`} (module nodenext, strict, skipLibCheck off)`
    );
    console.log(
      `       runs           ${coreOnlyRun.code === 0 ? `yes: ${coreOnlyRun.stdout.trim().slice(3, 76)}` : 'NO'}`
    );
    console.log('');
    for (const { component, ran } of presences) {
      step += 1;
      console.log(
        `  ${step}. ${component.subpath}-present`.padEnd(22) +
          `npm install ${FACADE} ${component.peer} (the control)`
      );
      console.log(
        `       subpath works  ${ran.code === 0 ? `yes: ${ran.stdout.trim().slice(3, 76)}` : 'NO'}`
      );
      console.log('');
    }

    return verdict(
      findings,
      `importing an absent opt-in subpath of ${FACADE} names the install, a project that ` +
        'imports neither type-checks and runs clean, and each subpath works once its peer is ' +
        'added.',
      'an absent opt-in component does not behave as FR-074, FR-046 and SC-031 require.'
    );
  } finally {
    scratch.dispose();
  }
}

await run(main);
