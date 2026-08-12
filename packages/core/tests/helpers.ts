import { existsSync } from 'node:fs';

import type { Schema } from '@idfkit/schemas';
import { localBundle } from '@idfkit/schemas/node';

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
