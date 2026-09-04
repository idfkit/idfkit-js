import { existsSync } from 'node:fs';

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
