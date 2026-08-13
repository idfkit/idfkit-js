/**
 * Fetch and unpack weather files from climate.onebuilding.org, in the browser.
 *
 * The Python library downloads to a disk cache and hands back file paths. A
 * browser has no filesystem, so this returns the file *contents* as text
 * instead — `epw` text drops straight into `@idfkit/engine`'s `ep.run({ idf,
 * epw })`. For Node callers who do want files on disk, `@idfkit/weather/node`
 * has `saveWeatherFiles`.
 *
 * **CORS.** climate.onebuilding.org sends no `Access-Control-Allow-Origin`, so
 * a direct browser fetch is blocked by the same-origin policy. Pass a
 * `rewriteUrl` that points at your own proxy (or a `fetch` that adds one) to
 * retrieve files from a page. Node and workers have no such restriction.
 */

import type { StationIndex } from './station-index.js';
import type { WeatherStation } from './station.js';
import { resolveFetch, USER_AGENT, type FetchLike } from './http.js';
import { unzip } from './unzip.js';

/** Options common to the retrieval functions. */
export interface FetchWeatherOptions {
  /** A `fetch` to use instead of the global one — e.g. one that adds a proxy. */
  fetch?: FetchLike;
  /**
   * Rewrite the upstream ZIP URL before fetching, typically to prepend a CORS
   * proxy. Receives the station's `url` and returns the URL to request.
   */
  rewriteUrl?: (url: string) => string;
  /** Abort signal forwarded to `fetch`. */
  signal?: AbortSignal;
}

/** The decoded weather files for a station. */
export interface WeatherFiles {
  station: WeatherStation;
  /** The EPW file text, ready to hand to a simulation engine. */
  epw: string;
  /** The DDY (design-day) file text, or `null` if the archive had none. */
  ddy: string | null;
  /** The STAT (climate statistics) file text, or `null` if absent. */
  stat: string | null;
  /**
   * Every archive member, by filename, as raw bytes — including the ones with
   * no decoded convenience field (`.clm`, `.wea`, `.rain`, `.pvsyst`).
   */
  members: Map<string, Uint8Array>;
}

/**
 * Download a station's ZIP archive and return its members as raw bytes.
 *
 * This is the low-level entry point. Most callers want {@link fetchWeatherFiles}
 * or {@link fetchEpw}.
 */
export async function fetchWeatherArchive(
  url: string,
  options: FetchWeatherOptions = {}
): Promise<Map<string, Uint8Array>> {
  const doFetch = resolveFetch(options.fetch);
  const target = options.rewriteUrl ? options.rewriteUrl(url) : url;
  const response = await doFetch(target, {
    headers: { 'User-Agent': USER_AGENT },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${target}: ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return unzip(bytes);
}

// EPW and other weather files are Latin-1: LOCATION headers carry accented
// station names as single high bytes, which decode to U+FFFD under UTF-8.
const decoder = new TextDecoder('latin1');

function decodeMember(members: Map<string, Uint8Array>, extension: string): string | null {
  for (const [name, bytes] of members) {
    if (name.toLowerCase().endsWith(extension)) return decoder.decode(bytes);
  }
  return null;
}

/**
 * Download a station's weather files and decode the common ones to text.
 *
 * @throws if the archive contains no `.epw` member.
 */
export async function fetchWeatherFiles(
  station: WeatherStation,
  options: FetchWeatherOptions = {}
): Promise<WeatherFiles> {
  const members = await fetchWeatherArchive(station.url, options);
  const epw = decodeMember(members, '.epw');
  if (epw === null) {
    throw new Error(`No .epw file found in the archive for ${station.displayName}`);
  }
  return {
    station,
    epw,
    ddy: decodeMember(members, '.ddy'),
    stat: decodeMember(members, '.stat'),
    members,
  };
}

/**
 * Download a station's EPW file and return its text — the shortest path to the
 * value `@idfkit/engine` needs.
 */
export async function fetchEpw(
  station: WeatherStation,
  options: FetchWeatherOptions = {}
): Promise<string> {
  return (await fetchWeatherFiles(station, options)).epw;
}

/**
 * Resolve an EPW filename to a station through the given index, then download
 * its EPW text.
 *
 * @throws if the filename matches no station in the index.
 */
export async function fetchEpwByFilename(
  filename: string,
  index: StationIndex,
  options: FetchWeatherOptions = {}
): Promise<string> {
  const stations = index.getByFilename(filename);
  if (stations.length === 0 || stations[0] === undefined) {
    throw new Error(`No weather station found for filename: ${JSON.stringify(filename)}`);
  }
  return fetchEpw(stations[0], options);
}
