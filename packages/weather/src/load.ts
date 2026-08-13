/**
 * Load and rebuild the station index — the async, network edge around the pure
 * {@link StationIndex}.
 *
 * `loadStationIndex` fetches the prebuilt `stations.json.gz` (the fast path,
 * ~1.7 MB); `refreshStationIndex` re-downloads the ten regional KML files and
 * rebuilds from scratch (slower, but current). Both run in the browser, subject
 * to the same CORS caveat as downloads — see `download.ts`. Node callers who
 * want the *bundled* index without any network call use
 * `loadBundledIndex` from `@idfkit/weather/node`.
 */

import { parseKml } from './kml.js';
import { resolveFetch, USER_AGENT, type FetchLike } from './http.js';
import { StationIndex } from './station-index.js';
import { WeatherStation, type StationRecord } from './station.js';

/** The upstream directory holding the regional KML index files. */
export const SOURCES_BASE_URL = 'https://climate.onebuilding.org/sources';

/** The ten regional TMYx KML index files, together covering the globe. */
export const INDEX_FILES: readonly string[] = [
  'Region1_Africa_TMYx_EPW_Processing_locations.kml',
  'Region2_Asia_TMYx_EPW_Processing_locations.kml',
  'Region2_Region6_Russia_TMYx_EPW_Processing_locations.kml',
  'Region3_South_America_TMYx_EPW_Processing_locations.kml',
  'Region4_USA_TMYx_EPW_Processing_locations.kml',
  'Region4_Canada_TMYx_EPW_Processing_locations.kml',
  'Region4_NA_CA_Caribbean_TMYx_EPW_Processing_locations.kml',
  'Region5_Southwest_Pacific_TMYx_EPW_Processing_locations.kml',
  'Region6_Europe_TMYx_EPW_Processing_locations.kml',
  'Region7_Antarctica_TMYx_EPW_Processing_locations.kml',
];

/** The serialized index shape shared with the Python library's `stations.json`. */
export interface IndexData {
  built_at?: string;
  last_modified?: Record<string, string>;
  stations: StationRecord[];
}

/**
 * Build a {@link StationIndex} from already-parsed index JSON.
 *
 * Synchronous and pure. Use it when you have fetched or imported the index data
 * yourself and just need it turned into a searchable index.
 */
export function indexFromData(data: IndexData): StationIndex {
  if (!Array.isArray(data.stations)) {
    throw new Error('Invalid station index: expected a "stations" array');
  }
  const stations = data.stations.map((r) => WeatherStation.fromJSON(r));
  return new StationIndex(stations, data.last_modified ?? {});
}

/**
 * Inflate a possibly-gzipped payload to text.
 *
 * Sniffs the gzip magic bytes (`1f 8b`) first: a host that maps `.gz` to
 * `Content-Encoding: gzip` makes the HTTP client inflate the body already, so
 * feeding it to `DecompressionStream` would fail with "incorrect header check".
 * This mirrors `httpSource` in `@idfkit/schemas`.
 */
async function inflateToText(bytes: Uint8Array): Promise<string> {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** Options for {@link loadStationIndex}. */
export interface LoadIndexOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * Fetch a prebuilt station index (`stations.json.gz`, or plain JSON) from a URL
 * and build a searchable {@link StationIndex}.
 *
 * Serve `node_modules/@idfkit/weather/data/stations.json.gz` from your own
 * origin and point this at it. Gzipped and plain responses are both handled.
 */
export async function loadStationIndex(
  url: string | URL,
  options: LoadIndexOptions = {}
): Promise<StationIndex> {
  const doFetch = resolveFetch(options.fetch);
  const response = await doFetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to load station index: ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = await inflateToText(bytes);
  return indexFromData(JSON.parse(text) as IndexData);
}

/** Options for {@link refreshStationIndex}. */
export interface RefreshIndexOptions {
  fetch?: FetchLike;
  /** Override the KML sources base URL, e.g. a CORS proxy prefix. */
  baseUrl?: string;
  signal?: AbortSignal;
}

/**
 * Re-download the regional KML indexes and rebuild the station index.
 *
 * This is the current-data path: it goes to climate.onebuilding.org, so it is
 * slower than {@link loadStationIndex} and, in the browser, needs a CORS-capable
 * `baseUrl` or `fetch`. The rebuilt index carries the upstream `Last-Modified`
 * values so a later {@link checkForUpdates} can tell when it has gone stale.
 */
export async function refreshStationIndex(
  options: RefreshIndexOptions = {}
): Promise<StationIndex> {
  const doFetch = resolveFetch(options.fetch);
  const base = options.baseUrl ?? SOURCES_BASE_URL;

  const stations: WeatherStation[] = [];
  const lastModified: Record<string, string> = {};
  for (const filename of INDEX_FILES) {
    const response = await doFetch(`${base}/${filename}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Failed to download weather index ${filename}: ${response.status} ${response.statusText}`
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder('utf-8').decode(bytes);
    const lm = response.headers.get('last-modified');
    if (lm) lastModified[filename] = lm;
    stations.push(...parseKml(text, filename));
  }
  return new StationIndex(stations, lastModified);
}

/**
 * Check whether the upstream KML files have changed since `index` was built.
 *
 * Sends lightweight HEAD requests and compares `Last-Modified` against the
 * values stored on the index. Returns `false` when the index carries no stored
 * values, or when the check cannot be completed (offline, CORS, timeout).
 */
export async function checkForUpdates(
  index: StationIndex,
  options: RefreshIndexOptions = {}
): Promise<boolean> {
  const stored = index.lastModified;
  if (Object.keys(stored).length === 0) return false;

  const doFetch = resolveFetch(options.fetch);
  const base = options.baseUrl ?? SOURCES_BASE_URL;
  for (const filename of INDEX_FILES) {
    const known = stored[filename];
    if (known === undefined) continue;
    try {
      const response = await doFetch(`${base}/${filename}`, {
        method: 'HEAD',
        headers: { 'User-Agent': USER_AGENT },
        signal: options.signal,
      });
      const upstream = response.headers.get('last-modified');
      if (upstream !== null && upstream !== known) return true;
    } catch {
      // Best-effort: a failed probe is not evidence of an update.
    }
  }
  return false;
}
