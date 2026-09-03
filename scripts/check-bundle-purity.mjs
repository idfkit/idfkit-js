#!/usr/bin/env node
/**
 * The bundle-purity gate (task T097, SC-013).
 *
 * THE CRITERION
 *
 * `contracts/distribution.md`: "A minimal browser build that reads and writes
 * pulls in zero bytes of schema data, station index, or generated types". T097
 * says how to establish it: an esbuild metafile for a minimal read-and-write
 * page must contain zero inputs matching schema data, `stations.json`, or
 * `types-v`.
 *
 * WHY A METAFILE AND NOT A SIZE
 *
 * A size threshold is the obvious check and the wrong one. It fails late (the
 * data has to be big enough to notice), it fails for the wrong reasons (a
 * legitimate feature that adds 200 KB of code trips it), and when it fails it
 * cannot say what went in. esbuild's metafile lists every module that entered
 * the graph, by path, with its byte count, so the criterion becomes exact: no
 * input path may match the three families of unrequested bytes. Zero is a
 * threshold nobody has to argue about.
 *
 * WHAT COUNTS AS UNREQUESTED, AND WHAT DOES NOT
 *
 * `@idfkit/core`'s index re-exports `Schema`, `SchemaBundle` and `httpSource`
 * from `@idfkit/schemas`, so a few kilobytes of that package's RUNTIME are in
 * any bundle that imports the shared name. That is fine and is not what SC-013
 * is about. What must never appear is the DATA those classes load: about 1 MB
 * of gzipped manifests under `@idfkit/schemas/data/`, of which `types.json.gz`
 * alone is 784 KB. The whole point of the subpath split (FR-038) is that the
 * data is reached on demand, over the network or off disk, and is never
 * statically imported.
 *
 * The three families, and how each one would arrive:
 *
 *   schema data     a static import of anything under a package's `data/`
 *                   directory, which is one line in @idfkit/schemas or in the
 *                   facade away at any time;
 *   stations.json   @idfkit/weather reaching the graph, which under the shared
 *                   name it cannot, because it is not installed (FR-043);
 *   types-v         a generated type package that stopped being declarations
 *                   only and acquired an emitted module, then got imported.
 *
 * THE PAGE, AND WHY IT LOOKS LIKE A REAL ONE
 *
 * "Minimal read-and-write" is taken literally: load a schema, parse an IDF
 * string, mutate it, write it back. The schema comes through `httpSource`,
 * because that is the only way a browser gets one, and using it here is what
 * makes the check meaningful: the page really does need the schema data, and
 * the criterion is that it FETCHES it rather than BUNDLES it. A page that never
 * touched a schema would pass this gate while proving nothing about FR-038.
 *
 * The bundle is built for the browser, as ESM, minified, which is the shape a
 * consumer's own build produces.
 *
 * WHY IT ALSO RUNS THE BUNDLE
 *
 * A bundle can be pure and useless. Zero unrequested bytes is trivially
 * achievable by bundling nothing at all, so the gate executes the emitted
 * module against a stubbed `fetch` that serves the schema files off disk, and
 * requires the round trip to come back with the document in it.
 *
 * Exit codes: 0 pure, 1 at least one unrequested input, 2 could not build.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CannotRun,
  Finding,
  fixtureRoot,
  installSharedNameOrFail,
  kib,
  packWorkspaces,
  run,
  runInFixture,
  verdict,
} from './lib/clean-install.mjs';

/**
 * The three families of unrequested bytes, as predicates over a metafile input
 * path. Named, because a finding that says which family it is tells the reader
 * what regressed.
 */
const UNREQUESTED = [
  {
    name: 'schema data',
    matches: (path) => /(^|\/)data\//.test(path) && !/stations\.json/.test(path),
    why:
      'about 1 MB of gzipped epJSON manifests, of which types.json.gz alone is 784 KB. It is ' +
      'loaded on demand through the ./schemas subpath (FR-038); one static import of it puts ' +
      'the whole set into every page that parses a file.',
  },
  {
    name: 'station index',
    matches: (path) => /stations\.json/.test(path),
    why:
      'the 1.6 MB weather station index. It lives in @idfkit/weather, which the shared name does ' +
      'not install at all (FR-043, SC-016), so its presence here means the no-index gate has ' +
      'something to say as well.',
  },
  {
    name: 'generated types',
    matches: (path) => /types-v\d/.test(path),
    why:
      '@idfkit/types-v26-1 and @idfkit/types-v9-4 are 5.3 MB of declarations and carry no ' +
      'runtime at all (FR-039). A path matching types-v in a metafile means one of them acquired ' +
      'an emitted module, which is the exact regression scripts/check-type-packages.mjs guards.',
  },
];

/** The version the page loads. Any bundled version would do; this is the newest. */
const VERSION = '26.1.0';

/**
 * A page that reads and writes, and does nothing else.
 *
 * Note what is NOT here: no `@idfkit/schemas/node`, no `node:fs`, no import of
 * anything under `data/`. The schema arrives over `fetch`, which is the whole
 * claim SC-013 makes about the browser path.
 */
const PAGE = `
import { SchemaBundle, httpSource, parseIdf, writeIdf } from 'idfkit';

const bundle = new SchemaBundle(httpSource('https://schemas.invalid/data/'));
const schema = await bundle.load(${JSON.stringify(VERSION)});

// Read.
const parsed = parseIdf('Version,26.1;\\n\\nBuilding,\\n  Tower;\\n', schema);
const building = parsed.document.require('Building', 'Tower');

// Write. Both halves are used and the result escapes to a global, so neither the
// parser nor the writer can be shaken out by a build cleverer than this check.
building.set('north_axis', 30);
globalThis.__idfkitRoundTrip = writeIdf(parsed.document);
`;

/**
 * Run the bundle in Node with `fetch` stubbed to the installed data directory.
 *
 * The stub is the point: the bundle asks for the schema over the network, and
 * the bytes it gets come from a directory the bundle demonstrably does not
 * contain. Serving them from `node_modules/@idfkit/schemas/data` also proves
 * the data really is installed and really is not in the graph.
 */
const SMOKE = `
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const dataDir = join(process.cwd(), 'node_modules', '@idfkit', 'schemas', 'data');
const asked = [];

globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  asked.push(name);
  const body = await readFile(join(dataDir, name));
  return new Response(body, { status: 200 });
};

await import('./bundle.js');

const out = globalThis.__idfkitRoundTrip;
if (typeof out !== 'string' || !out.includes('Building')) {
  console.error('the bundle ran but produced no document: ' + JSON.stringify(out));
  process.exit(1);
}
console.log('FETCHED ' + asked.join(' '));
console.log('ROUNDTRIP ' + out.replace(/\\s+/g, ' ').trim());
`;

/**
 * The line that actually says what went wrong.
 *
 * A crash inside a minified bundle prints the whole first line of the file
 * before the message, which is 40 KB of noise. Take the `Error:` line if there
 * is one, and the tail otherwise.
 */
function lastError(result) {
  const text = (result.stderr || result.stdout).trim();
  const named = text.match(/^\s*(?:[A-Za-z]*Error|Uncaught).*$/m);
  return (named?.[0] ?? text.slice(-300)).trim();
}

async function esbuild() {
  try {
    return await import('esbuild');
  } catch (error) {
    throw new CannotRun(
      `esbuild is not available: ${error.message}\n` +
        'It is a devDependency of this repository precisely so this gate can run. Run `npm ci`.'
    );
  }
}

async function main() {
  const { build } = await esbuild();
  const scratch = fixtureRoot('bundle-purity');
  try {
    const { tarballs } = packWorkspaces(scratch.tarballDir);
    const { dir } = installSharedNameOrFail(scratch, tarballs, { label: 'browser-page' });

    const entry = join(dir, 'page.js');
    writeFileSync(entry, PAGE);

    let result;
    try {
      result = await build({
        absWorkingDir: dir,
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        minify: true,
        metafile: true,
        outfile: join(dir, 'bundle.js'),
        logLevel: 'silent',
      });
    } catch (error) {
      const detail = (error.errors ?? [])
        .map((e) => `${e.location?.file ?? '?'}: ${e.text}`)
        .join('\n');
      throw new CannotRun(
        `esbuild could not build the minimal page:\n${detail || error.message}\n\n` +
          'That is a failure of the install or of the facade, not a purity finding, and this ' +
          'gate will not report zero unrequested bytes for a graph it never built.'
      );
    }

    const metafilePath = join(dir, 'meta.json');
    writeFileSync(metafilePath, JSON.stringify(result.metafile, null, 2));

    const inputs = Object.entries(result.metafile.inputs).map(([path, value]) => ({
      path,
      bytes: value.bytes,
    }));
    const output = Object.values(result.metafile.outputs).find((o) => o.entryPoint !== undefined);

    const findings = [];
    for (const family of UNREQUESTED) {
      const hits = inputs.filter((input) => family.matches(input.path));
      if (hits.length === 0) continue;
      const bytes = hits.reduce((sum, hit) => sum + hit.bytes, 0);
      findings.push(
        new Finding(
          `the minimal read-and-write bundle pulls in ${hits.length} ${family.name} input(s), ${kib(bytes)}`,
          `${hits
            .slice(0, 8)
            .map((hit) => `${hit.path} (${kib(hit.bytes)})`)
            .join(', ')}. ${family.why}`
        )
      );
    }

    const smoke = runInFixture(dir, 'smoke.mjs', SMOKE);
    if (smoke.code !== 0) {
      findings.push(
        new Finding(
          'the bundle contains no unrequested bytes, and does not work',
          `Running it exited ${smoke.code}: ${lastError(smoke)}. ` +
            'Zero unrequested bytes is trivially achievable by bundling nothing, so the round ' +
            'trip has to actually come back for the measurement above to mean anything.'
        )
      );
    }

    const fetched = (smoke.stdout.match(/^FETCHED (.*)$/m) ?? [])[1];
    const roundTrip = (smoke.stdout.match(/^ROUNDTRIP (.*)$/m) ?? [])[1];

    console.log('idfkit-js bundle-purity gate (SC-013)');
    console.log(`  built        ${dir}/page.js -> bundle.js`);
    console.log(`  page         SchemaBundle over httpSource, parseIdf, mutate, writeIdf`);
    console.log('  options      bundle, format=esm, platform=browser, minify');
    console.log(`  metafile     ${metafilePath}`);
    console.log(
      `  graph        ${inputs.length} inputs, ${kib(inputs.reduce((s, i) => s + i.bytes, 0))} in, ` +
        `${kib(output?.bytes ?? 0)} out`
    );
    console.log('');
    console.log('  unrequested-byte families, each of which must be empty');
    for (const family of UNREQUESTED) {
      const hits = inputs.filter((input) => family.matches(input.path));
      console.log(
        `    ${family.name.padEnd(16)} ` +
          (hits.length === 0
            ? '0 inputs'
            : `${hits.length} INPUT(S): ${hits.map((h) => h.path).join(', ')}`)
      );
    }
    console.log('');
    console.log('  largest inputs in the graph');
    for (const input of [...inputs].sort((a, b) => b.bytes - a.bytes).slice(0, 6)) {
      console.log(`    ${kib(input.bytes).padStart(10)}  ${input.path}`);
    }
    if (fetched !== undefined) {
      console.log('');
      console.log(`  fetched      ${fetched}`);
      console.log(`               (schema data arrives over the network, not in the bundle)`);
    }
    if (roundTrip !== undefined) {
      console.log(`  round trip   ${roundTrip.slice(0, 90)}`);
    }
    console.log('');

    return verdict(
      findings,
      `a minimal read-and-write bundle is ${kib(output?.bytes ?? 0)} and contains no schema data, no station index and no generated types.`,
      'the minimal browser bundle carries bytes nobody asked for (SC-013).'
    );
  } finally {
    scratch.dispose();
  }
}

await run(main);
