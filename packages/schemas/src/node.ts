import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { SchemaBundle, type BundleSource } from './index.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

/**
 * Filesystem source reading the bundle shipped inside this package.
 *
 * Inflates in-process: the bundle is ~1 MB gzipped against ~6 MB raw, and
 * gunzip costs less than the extra disk read.
 */
export function nodeSource(dataDir: string = DATA_DIR): BundleSource {
  return {
    async read(fileName) {
      const gz = await readFile(join(dataDir, `${fileName}.gz`));
      return JSON.parse(gunzipSync(gz).toString('utf8')) as unknown;
    },
  };
}

/** A bundle backed by this package's own data directory. */
export function localBundle(dataDir?: string): SchemaBundle {
  return new SchemaBundle(nodeSource(dataDir));
}

/**
 * Read one bundle file synchronously.
 *
 * Node-only escape hatch for CLIs and build scripts where an async schema load
 * would force the whole call stack to become async for no benefit. Library code
 * on the portable path should use `SchemaBundle.load`.
 */
export function readBundleFileSync(fileName: string, dataDir: string = DATA_DIR): unknown {
  const gz = readFileSync(join(dataDir, `${fileName}.gz`));
  return JSON.parse(gunzipSync(gz).toString('utf8')) as unknown;
}
