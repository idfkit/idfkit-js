import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  fetchEpw,
  fetchWeatherFiles,
  geocode,
  loadStationIndex,
  type FetchLike,
} from '@idfkit/weather';

import { buildZip } from './helpers.js';

/**
 * The published weather documentation, executed.
 *
 * As with the core docs-snippets suite, these are the snippets from the pages,
 * not paraphrases — each `describe` names the page that owns them. Because the
 * docs fetch over the network, the only edits here are to point URLs at a local
 * server serving the real bundled index and a built archive; the API calls are
 * verbatim. When one fails, fix the page rather than the test.
 */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

let server: Server;
let base: string;

beforeAll(async () => {
  const indexGz = readFileSync(join(DATA_DIR, 'stations.json.gz'));
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      if (req.url === '/stations.json.gz') {
        res.setHeader('Content-Type', 'application/json');
        res.end(indexGz);
        return;
      }
      // Any weather ZIP request gets a small, valid archive back.
      const epw = new TextEncoder().encode('LOCATION,Chicago.OHare.Intl.AP,IL,USA');
      const ddy = new TextEncoder().encode('SizingPeriod:DesignDay,;');
      const stat = new TextEncoder().encode('Statistics');
      res.end(Buffer.from(buildZip({ 'w.epw': epw, 'w.ddy': ddy, 'w.stat': stat })));
    });
    server.listen(0, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  base = `http://localhost:${address.port}`;
});

afterAll(() => server.close());

/** The documented CORS-proxy rewrite, aimed at the local server. */
const toLocal = (url: string): string => `${base}/zip?url=${encodeURIComponent(url)}`;

describe('how-to/fetch-weather-files.md', () => {
  it('loads the index, searches, and fetches an EPW', async () => {
    const index = await loadStationIndex(`${base}/stations.json.gz`);

    const [best] = index.search('chicago ohare');
    expect(best).toBeDefined();
    const station = best!.station;

    const [nearest] = index.nearest(41.98, -87.9, { maxDistanceKm: 50 });
    expect(nearest?.station.country).toBe('USA');

    const [match] = index.getByFilename('USA_IL_Chicago.OHare.Intl.AP.725300_TMYx.2009-2023.epw');
    expect(match).toBeDefined();

    const epw = await fetchEpw(station, { rewriteUrl: toLocal });
    expect(epw).toContain('LOCATION');

    const files = await fetchWeatherFiles(station, { rewriteUrl: toLocal });
    expect(files.ddy).toContain('DesignDay');
    expect(files.stat).toBe('Statistics');
  });

  it('geocodes an address and spreads it into nearest', async () => {
    const index = await loadStationIndex(`${base}/stations.json.gz`);
    // geocode hits Nominatim; inject a fetch so the snippet runs offline.
    const fetchMock: FetchLike = async () =>
      new Response(JSON.stringify([{ lat: '40.7484', lon: '-73.9857' }]), { status: 200 });

    const results = index.nearest(
      ...(await geocode('350 Fifth Avenue, New York', { fetch: fetchMock }))
    );
    expect(results[0]?.station.country).toBe('USA');
  });
});

// Named for the page on the unified site rather than one here, because this
// snippet has no page in this repository: it is authored here because
// `docs/snippets/js/` is vendored from this repo at a pinned docs level, and
// published on developers.idfkit.com. The other weather block above names an
// idfkit-js page because that page exists.
describe('developers.idfkit.com weather/station-search.md', () => {
  it('filters by climate zone, alone and combined, and reaches the undetermined records', async () => {
    const index = await loadStationIndex(`${base}/stations.json.gz`);

    const zone4a = index.filter({ climateZone: '4A' });
    const seattleArea = index.filter({ climateZone: '4C', country: 'USA', state: 'WA' });
    const undetermined = index.filter({ climateZoneDetermined: false });

    expect(zone4a).toHaveLength(7952);
    expect(seattleArea).toHaveLength(115);
    expect(undetermined).toHaveLength(2162);

    // The claim the page's comment makes, executed rather than asserted in prose:
    // asking for 7A finds nothing, because 7A is not a zone.
    expect(index.filter({ climateZone: '7A' })).toHaveLength(0);
    for (const s of undetermined) {
      expect(s.ashraeClimateZone).toMatch(/climate zone could not be determined/i);
    }
  });
});

describe('README weather quickstart', () => {
  it('loads the index and fetches the top hit', async () => {
    const index = await loadStationIndex(`${base}/stations.json.gz`);
    const epw = await fetchEpw(index.search('chicago ohare')[0]!.station, {
      rewriteUrl: toLocal,
    });
    expect(epw).toContain('LOCATION');
  });
});
