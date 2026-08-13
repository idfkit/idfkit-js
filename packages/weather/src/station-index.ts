/**
 * A searchable, in-memory index of weather stations.
 *
 * Everything here is synchronous and pure — no network, no I/O. Loading the
 * bundled index from disk or over HTTP is the async edge and lives in
 * `load.ts` (portable) and `node.ts` (Node). Hand this class a list of
 * {@link WeatherStation}s and it builds the lookup tables once.
 */

import { haversineKm } from './spatial.js';
import type { MatchField, SearchResult, SpatialResult, WeatherStation } from './station.js';

const WEATHER_FILE_EXTENSIONS = ['.zip', '.epw', '.ddy', '.stat'] as const;

/**
 * Canonical EPW filenames, e.g. `USA_IL_Chicago.OHare.Intl.AP.725300_TMYx`.
 * A country code, then anything, then `.WMO` (4-6 digits), a `_variant`, an
 * optional year range, and an optional weather extension.
 */
const EPW_FILENAME_RE =
  /^[A-Za-z]{2,3}_.*\.\d{4,6}_\w+(?:\.\d{4}-\d{4})?(?:\.(?:zip|epw|ddy|stat))?$/;

function stripWeatherExtension(filename: string): string {
  const lower = filename.toLowerCase();
  for (const ext of WEATHER_FILE_EXTENSIONS) {
    if (lower.endsWith(ext)) return filename.slice(0, -ext.length);
  }
  return filename;
}

/** The WMO number from a filename stem, preserving leading zeros. */
function extractWmoFromFilename(filename: string): string | undefined {
  const stem = stripWeatherExtension(filename);
  const cut = stem.lastIndexOf('_');
  if (cut === -1) return undefined;
  const prefix = stem.slice(0, cut);
  const dot = prefix.lastIndexOf('.');
  if (dot === -1) return undefined;
  const tail = prefix.slice(dot + 1);
  return /^\d+$/.test(tail) ? tail : undefined;
}

/**
 * Score a station against a lower-cased query and its whitespace tokens.
 *
 * The signals, strongest first: an exact WMO number, a full-query substring of
 * the display or city name, all query tokens as name-token prefixes, a partial
 * token overlap, and finally a bare state or country code. The constants match
 * the Python library so both rank a given query identically.
 */
function scoreStation(
  station: WeatherStation,
  query: string,
  tokens: string[]
): [number, MatchField] {
  const nameLower = station.city.toLowerCase().replace(/[.-]/g, ' ');
  const displayLower = station.displayName.toLowerCase();

  if (/^\d+$/.test(query) && query === station.wmo) return [1.0, 'wmo'];

  if (displayLower.includes(query)) {
    const coverage = query.length / Math.max(displayLower.length, 1);
    return [0.85 + 0.1 * coverage, 'name'];
  }
  if (nameLower.includes(query)) {
    const coverage = query.length / Math.max(nameLower.length, 1);
    return [0.85 + 0.1 * coverage, 'name'];
  }

  const nameTokens = nameLower.split(/\s+/).filter(Boolean);
  const startsWithAny = (qt: string): boolean => nameTokens.some((t) => t.startsWith(qt));

  if (tokens.length > 0 && tokens.every(startsWithAny)) {
    const covered = tokens.reduce((sum, qt) => sum + qt.length, 0);
    const coverage = covered / Math.max(nameLower.length, 1);
    return [0.6 + 0.3 * Math.min(coverage, 1.0), 'name'];
  }

  if (tokens.length > 0) {
    const matching = tokens.filter(startsWithAny).length;
    if (matching > 0) return [0.3 * (matching / tokens.length), 'name'];
  }

  if (query === station.state.toLowerCase()) return [0.5, 'state'];
  if (query === station.country.toLowerCase()) return [0.4, 'country'];

  return [0.0, ''];
}

/** Options for {@link StationIndex.search}. */
export interface SearchOptions {
  /** Maximum results to return. Default 10. */
  limit?: number;
  /** Restrict to this ISO country code. */
  country?: string;
}

/** Options for {@link StationIndex.nearest}. */
export interface NearestOptions {
  /** Maximum results to return. Default 5. */
  limit?: number;
  /** Exclude stations farther than this many kilometres. */
  maxDistanceKm?: number;
  /** Restrict to this ISO country code. */
  country?: string;
}

/** Options for {@link StationIndex.filter}. */
export interface FilterOptions {
  country?: string;
  state?: string;
  /** WMO region number, inferred from `wmo_region_{n}` in the download URL. */
  wmoRegion?: number;
}

export class StationIndex {
  readonly #stations: readonly WeatherStation[];
  readonly #byWmo = new Map<string, WeatherStation[]>();
  readonly #byFilename = new Map<string, WeatherStation[]>();
  /** Upstream `Last-Modified` values, keyed by KML filename. Empty unless set. */
  readonly #lastModified: Readonly<Record<string, string>>;

  constructor(stations: readonly WeatherStation[], lastModified: Record<string, string> = {}) {
    this.#stations = stations;
    this.#lastModified = lastModified;
    for (const s of stations) {
      pushInto(this.#byWmo, s.wmo, s);
      pushInto(this.#byFilename, s.filenameStem.toLowerCase(), s);
    }
  }

  /** Build an index from an explicit list of stations. */
  static fromStations(stations: readonly WeatherStation[]): StationIndex {
    return new StationIndex(stations);
  }

  /** Every station in the index. */
  get stations(): readonly WeatherStation[] {
    return this.#stations;
  }

  /** Number of station entries. */
  get size(): number {
    return this.#stations.length;
  }

  /** The upstream `Last-Modified` headers this index was built against. */
  get lastModified(): Readonly<Record<string, string>> {
    return this.#lastModified;
  }

  /** Sorted, de-duplicated country codes present in the index. */
  get countries(): string[] {
    return [...new Set(this.#stations.map((s) => s.country))].sort();
  }

  /**
   * Look up stations by WMO number. A list, because one WMO number can map to
   * several dataset variants.
   */
  getByWmo(wmo: string): WeatherStation[] {
    return [...(this.#byWmo.get(wmo) ?? [])];
  }

  /**
   * Look up stations by EPW filename, with or without an extension, matched
   * case-insensitively. Falls back to the WMO number embedded in the filename
   * when the exact stem is not indexed.
   */
  getByFilename(filename: string): WeatherStation[] {
    const key = stripWeatherExtension(filename).toLowerCase();
    const exact = this.#byFilename.get(key);
    if (exact && exact.length > 0) return [...exact];

    const wmo = extractWmoFromFilename(filename);
    return wmo ? this.getByWmo(wmo) : [];
  }

  /**
   * Fuzzy-search by name, city, state, WMO number, or EPW filename.
   *
   * Matching is case-insensitive and substring/token-prefix based — no NLP
   * dependency. A canonical EPW filename is detected and resolved through
   * {@link getByFilename} on the fast path.
   */
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const { limit = 10, country } = options;
    const raw = query.trim();
    const q = raw.toLowerCase();
    if (!q) return [];

    const inCountry = (s: WeatherStation): boolean =>
      !country || s.country.toUpperCase() === country.toUpperCase();

    if (EPW_FILENAME_RE.test(raw)) {
      const stations = this.getByFilename(raw);
      if (stations.length > 0) {
        return stations
          .filter(inCountry)
          .slice(0, limit)
          .map((station) => ({ station, score: 1.0, matchField: 'filename' as const }));
      }
    }

    const tokens = q.split(/\s+/).filter(Boolean);
    const scored: SearchResult[] = [];
    for (const station of this.#stations) {
      if (!inCountry(station)) continue;
      const [score, matchField] = scoreStation(station, q, tokens);
      if (score > 0) scored.push({ station, score, matchField });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Stations nearest a coordinate, closest first, by great-circle distance.
   *
   * When `maxDistanceKm` is given, a bounding-box pre-filter skips the
   * Haversine call for stations that are obviously too far.
   */
  nearest(latitude: number, longitude: number, options: NearestOptions = {}): SpatialResult[] {
    const { limit = 5, maxDistanceKm, country } = options;

    let latMin = 0;
    let latMax = 0;
    let lonMin = 0;
    let lonMax = 0;
    if (maxDistanceKm !== undefined) {
      const deltaDeg = maxDistanceKm / 111.0 + 1.0; // ~111 km per degree of latitude, small margin
      latMin = latitude - deltaDeg;
      latMax = latitude + deltaDeg;
      const cosLat = Math.cos((latitude * Math.PI) / 180);
      const lonDelta = deltaDeg / Math.max(cosLat, 0.01);
      lonMin = longitude - lonDelta;
      lonMax = longitude + lonDelta;
    }

    const results: SpatialResult[] = [];
    for (const station of this.#stations) {
      if (country && station.country.toUpperCase() !== country.toUpperCase()) continue;
      if (maxDistanceKm !== undefined) {
        if (station.latitude < latMin || station.latitude > latMax) continue;
        if (station.longitude < lonMin || station.longitude > lonMax) continue;
      }
      const distanceKm = haversineKm(latitude, longitude, station.latitude, station.longitude);
      if (maxDistanceKm !== undefined && distanceKm > maxDistanceKm) continue;
      results.push({ station, distanceKm });
    }
    results.sort((a, b) => a.distanceKm - b.distanceKm);
    return results.slice(0, limit);
  }

  /** Filter stations by metadata. All given criteria must match (logical AND). */
  filter(options: FilterOptions = {}): WeatherStation[] {
    const { country, state, wmoRegion } = options;
    return this.#stations.filter((s) => {
      if (country && s.country.toUpperCase() !== country.toUpperCase()) return false;
      if (state && s.state.toUpperCase() !== state.toUpperCase()) return false;
      if (wmoRegion !== undefined && !s.url.toLowerCase().includes(`wmo_region_${wmoRegion}`)) {
        return false;
      }
      return true;
    });
  }
}

function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
