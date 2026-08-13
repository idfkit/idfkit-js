import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkForUpdates,
  indexFromData,
  loadStationIndex,
  refreshStationIndex,
} from '@idfkit/weather';

import { kmlDocument, makeStation, OHARE_PLACEMARK } from './helpers.js';

const INDEX_JSON = {
  built_at: '2026-01-01T00:00:00Z',
  last_modified: {
    'Region4_USA_TMYx_EPW_Processing_locations.kml': 'Mon, 01 Jan 2026 00:00:00 GMT',
  },
  stations: [makeStation().toJSON(), makeStation({ wmo: '037720', country: 'GBR' }).toJSON()],
};

/** Serve a fixed body for every request, optionally gzipped. */
function serve(
  body: Uint8Array | string,
  headers: Record<string, string> = {}
): Promise<{ base: string; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(Buffer.from(body));
    });
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      resolve({ base: `http://localhost:${address.port}/`, server });
    });
  });
}

describe('indexFromData', () => {
  it('builds an index and keeps last_modified', () => {
    const index = indexFromData(INDEX_JSON);
    expect(index.size).toBe(2);
    expect(index.lastModified['Region4_USA_TMYx_EPW_Processing_locations.kml']).toContain('2026');
  });

  it('rejects malformed data', () => {
    expect(() => indexFromData({ stations: undefined } as never)).toThrow(/stations/);
  });
});

describe('loadStationIndex', () => {
  let open: Server | undefined;
  afterEach(() => open?.close());

  it('inflates a gzipped index', async () => {
    const gz = gzipSync(Buffer.from(JSON.stringify(INDEX_JSON)));
    const { base, server } = await serve(gz);
    open = server;
    const index = await loadStationIndex(base);
    expect(index.size).toBe(2);
    expect(index.getByWmo('725300').length).toBe(1);
  });

  it('reads a plain-JSON index when the host already inflated it', async () => {
    const { base, server } = await serve(JSON.stringify(INDEX_JSON), {
      'Content-Type': 'application/json',
    });
    open = server;
    const index = await loadStationIndex(base);
    expect(index.size).toBe(2);
  });

  it('throws on a non-OK response', async () => {
    const { base, server } = await serve('nope');
    open = server;
    server.removeAllListeners('request');
    server.on('request', (_req, res) => {
      res.statusCode = 500;
      res.end('err');
    });
    await expect(loadStationIndex(base)).rejects.toThrow(/500/);
  });
});

describe('refreshStationIndex', () => {
  let open: Server | undefined;
  afterEach(() => open?.close());

  it('fetches KML sources and rebuilds the index', async () => {
    const kml = kmlDocument(OHARE_PLACEMARK);
    const { base, server } = await serve(kml, {
      'Last-Modified': 'Wed, 01 Apr 2026 00:00:00 GMT',
    });
    open = server;
    // Serve the same KML for every regional file under this base.
    const index = await refreshStationIndex({ baseUrl: base.replace(/\/$/, '') });
    // Ten regional files, each yielding the one O'Hare placemark.
    expect(index.size).toBe(10);
    expect(index.getByWmo('725300').length).toBe(10);
  });
});

describe('checkForUpdates', () => {
  it('is false when the index carries no last_modified data', async () => {
    const index = indexFromData({ stations: [makeStation().toJSON()] });
    expect(await checkForUpdates(index)).toBe(false);
  });
});
