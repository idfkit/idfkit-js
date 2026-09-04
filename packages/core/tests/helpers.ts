import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Schema } from '@idfkit/schemas';
import { localBundle, nodeSource } from '@idfkit/schemas/node';

const bundle = localBundle();
const cache = new Map<string, Promise<Schema>>();

/** Load a schema once per version for the whole test run. */
export function schema(version = '26.1.0'): Promise<Schema> {
  let promise = cache.get(version);
  if (promise === undefined) {
    promise = bundle.load(version);
    cache.set(version, promise);
  }
  return promise;
}

/**
 * Directory of EnergyPlus example files, if an install is present.
 *
 * Round-trip tests run against the real example set when it is available and
 * skip cleanly when it is not, so CI without EnergyPlus still passes while a
 * developer machine gets the much stronger check.
 */
export function exampleFilesDir(): string | undefined {
  const candidates = [
    process.env['ENERGYPLUS_DIR'] ? `${process.env['ENERGYPLUS_DIR']}/ExampleFiles` : undefined,
    '/Applications/EnergyPlus-26-1-0/ExampleFiles',
    '/usr/local/EnergyPlus-26-1-0/ExampleFiles',
  ].filter((c): c is string => c !== undefined);

  return candidates.find((dir) => existsSync(dir));
}

/**
 * The schema's explanatory prose, loaded once for the whole test run.
 *
 * Read through the ordinary bundle source, because that is exactly how a caller
 * reaches it: there is no new export for the pool, and deliberately so. A Node
 * caller uses `readBundleFileSync('docs.json')`, a browser caller
 * `httpSource(base).read('docs.json')`, and the file sits in `data/` where the
 * bundle-purity gate already fences it off the parse path.
 */
let prosePromise: Promise<readonly string[]> | undefined;
export function prose(): Promise<readonly string[]> {
  prosePromise ??= nodeSource()
    .read('docs.json')
    .then((value) => value as readonly string[]);
  return prosePromise;
}

const syntaxFixtureDir = fileURLToPath(new URL('./fixtures/syntax/', import.meta.url));

/** One file from the syntax fixture corpus, and where it came from. */
export interface SyntaxFixture {
  /** Its name without the extension, such as `line-endings-crlf`. */
  readonly name: string;
  /** Its path on disk, so a failure can say which file broke rather than which index. */
  readonly path: string;
  /** Its bytes, decoded as UTF-8 and otherwise unaltered. */
  readonly text: string;
}

/**
 * One syntax fixture's text, exactly as it is on disk.
 *
 * The whole value of this corpus is that the bytes are the bytes. Three of the
 * fixtures differ from each other only in their line endings, and a reader that
 * translated those would leave the tests passing against text that no longer
 * contains the case they were written for. `readFileSync` performs no such
 * translation and neither does decoding UTF-8, which is why the read is spelled
 * out here once rather than left to each test to get right.
 *
 * @param name the fixture's name, without the `.idf` extension
 */
export function syntaxFixture(name: string): string {
  const found = syntaxFixtures().find((fixture) => fixture.name === name);
  if (found === undefined) {
    const available = syntaxFixtures().map((fixture) => fixture.name);
    throw new Error(`no syntax fixture named "${name}". There are: ${available.join(', ')}`);
  }
  return found.text;
}

/**
 * Every syntax fixture, in name order.
 *
 * Several tests assert a property over the whole corpus rather than over a file
 * they chose, which is the point of having one: a fixture added for one case is
 * then held to every invariant already proven, without anybody remembering to
 * add it to a list. So this enumerates the directory rather than naming its
 * contents.
 */
let syntaxFixtureCache: readonly SyntaxFixture[] | undefined;
export function syntaxFixtures(): readonly SyntaxFixture[] {
  syntaxFixtureCache ??= readdirSync(syntaxFixtureDir)
    .filter((entry) => entry.endsWith('.idf'))
    .sort()
    .map((entry) => {
      const path = `${syntaxFixtureDir}${entry}`;
      return {
        name: entry.slice(0, -'.idf'.length),
        path,
        text: readFileSync(path, 'utf8'),
      };
    });
  return syntaxFixtureCache;
}
