import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { SchemaBundle, httpSource } from '@idfkit/schemas';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

/**
 * Serve the shipped `.gz` files two ways, matching the two kinds of host.
 *
 * `encoding: false` is a host that sets no `Content-Encoding`; the client hands
 * back the raw gzip bytes and the source inflates them. `encoding: true` is a
 * host that maps `.gz` to `Content-Encoding: gzip` (Vite's dev server, nginx
 * with `gzip_static`), so the client inflates the body and the source sees
 * plain JSON. See issue #2.
 */
async function serveBundle(encoding: boolean): Promise<{ base: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const gz = await readFile(join(DATA_DIR, req.url ?? ''));
    res.setHeader('Content-Type', 'application/json');
    if (encoding) res.setHeader('Content-Encoding', 'gzip');
    res.end(gz);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { base: `http://localhost:${address.port}/`, server };
}

describe('httpSource', () => {
  let open: Server | undefined;
  afterEach(() => open?.close());

  it('inflates when the host sets no Content-Encoding', async () => {
    const { base, server } = await serveBundle(false);
    open = server;
    const versions = await new SchemaBundle(httpSource(base)).versions();
    expect(versions.length).toBe(17);
  });

  it('reads plain JSON when the host inflated the body itself', async () => {
    // The reproduction from issue #2: the client already decompressed, so
    // piping through DecompressionStream would fail with "incorrect header
    // check". Sniffing the magic bytes avoids that.
    const { base, server } = await serveBundle(true);
    open = server;
    const bundle = new SchemaBundle(httpSource(base));
    const versions = await bundle.versions();
    expect(versions.length).toBe(17);
    const schema = await bundle.load('26.1.0');
    expect(schema.resolve('Zone')).toBe('Zone');
  });
});
