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
  /**
   * ASHRAE climate zone code, e.g. `"5A"`. Case-insensitive.
   *
   * Matched against the code parsed out of {@link WeatherStation.ashraeClimateZone},
   * never against that label's text. The label is not a code: 2,162 records in the
   * shipped index read `7A - ASHRAE Climate Zone could not be determined` or
   * `8A - ...`, and neither 7A nor 8A is an ASHRAE zone, since zones 7 and 8 carry
   * no suffix. Matching the first token would invent two zones holding 3.1% of the
   * index, so those records match no zone. Ask for them with
   * {@link FilterOptions.climateZoneDetermined}. An empty string is no constraint,
   * matching `country` and `state`.
   */
  climateZone?: string;
  /**
   * Whether the station's ASHRAE zone was determined upstream.
   *
   * `false` selects the records whose label reports that it could not be, which no
   * `climateZone` value returns. A separate key rather than a reserved `climateZone`
   * value, because that key's domain is already strings and a magic one could not be
   * told from a real code.
   */
  climateZoneDetermined?: boolean;
}

/**
 * The nineteen zones ASHRAE 169 defines. A parsed code outside this set is neither a
 * zone nor undetermined: upstream failing to determine a zone and this library failing
 * to recognise one upstream did determine are different facts about a station, and
 * filing the second under the first reports something upstream never said.
 *
 * The set is not defensive. `station-index.test.ts` asserts the shipped index carries
 * exactly these nineteen, so a twentieth arriving upstream fails a build rather than
 * quietly changing what a filter returns.
 */
const ASHRAE_ZONES: ReadonlySet<string> = new Set([
  '0A',
  '0B',
  '1A',
  '1B',
  '2A',
  '2B',
  '3A',
  '3B',
  '3C',
  '4A',
  '4B',
  '4C',
  '5A',
  '5B',
  '5C',
  '6A',
  '6B',
  '7',
  '8',
]);

/**
 * Hoisted rather than written inline, so one pattern is compiled for the process
 * instead of one per label over a 69,638-record index. No `g` flag, so `test` keeps
 * no `lastIndex` between calls.
 *
 * Anchored on the subject, not on the bare phrase. Upstream writes exactly `ASHRAE
 * Climate Zone could not be determined`, and matching only `could not be determined`
 * would also swallow a label reporting that something ELSE about the station was
 * undetermined, filing a station whose zone upstream did state under the one bucket
 * that means upstream did not state it. The `ASHRAE ` prefix is deliberately not
 * required, so a label that drops it still reads as undetermined rather than yielding
 * a zone.
 */
const UNDETERMINED_RE = /climate zone could not be determined/i;

/** Whether the label reports that upstream could not determine the zone. */
function zoneIsUndetermined(label: string): boolean {
  return UNDETERMINED_RE.test(label);
}

/**
 * The ASHRAE zone code in a label, or `null` when there is none to have.
 *
 * `null` covers two different situations on purpose, and callers that need to tell
 * them apart use {@link zoneIsUndetermined}: upstream could not determine the zone, or
 * it determined one this library does not recognise.
 *
 * **The suffix is `[ABC]`, not `[AB]`.** Dropping C loses 3C, 4C and 5C, which is 1,653
 * marine-zone stations, leaves sixteen zones where there are nineteen, and throws
 * nothing.
 */
function zoneCodeOf(label: string): string | null {
  if (zoneIsUndetermined(label)) return null;
  const code = (label.split('-')[0] ?? '').trim().toUpperCase();
  return ASHRAE_ZONES.has(code) ? code : null;
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
    // When the longitude box would spill past ±180° the simple `min < x < max`
    // test wrongly rejects stations on the far side of the antimeridian (a
    // query at 179°E is ~78 km from one at 179°W). Skip the longitude pre-filter
    // in that case and let the exact Haversine + radius check below decide.
    let filterLongitude = false;
    if (maxDistanceKm !== undefined) {
      const deltaDeg = maxDistanceKm / 111.0 + 1.0; // ~111 km per degree of latitude, small margin
      latMin = latitude - deltaDeg;
      latMax = latitude + deltaDeg;
      const cosLat = Math.cos((latitude * Math.PI) / 180);
      const lonDelta = deltaDeg / Math.max(cosLat, 0.01);
      lonMin = longitude - lonDelta;
      lonMax = longitude + lonDelta;
      filterLongitude = lonMin >= -180 && lonMax <= 180;
    }

    const results: SpatialResult[] = [];
    for (const station of this.#stations) {
      if (country && station.country.toUpperCase() !== country.toUpperCase()) continue;
      if (maxDistanceKm !== undefined) {
        if (station.latitude < latMin || station.latitude > latMax) continue;
        if (filterLongitude && (station.longitude < lonMin || station.longitude > lonMax)) continue;
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
    const { country, state, wmoRegion, climateZone, climateZoneDetermined } = options;
    // `climateZone: ''` means no constraint, as `country` and `state` already do
    // below. A UI binding an empty select to this would otherwise get zero stations
    // from one key and every station from the next two.
    const wantedZone = climateZone ? climateZone.toUpperCase() : undefined;
    return this.#stations.filter((s) => {
      if (country && s.country.toUpperCase() !== country.toUpperCase()) return false;
      if (state && s.state.toUpperCase() !== state.toUpperCase()) return false;
      if (wmoRegion !== undefined && !s.url.toLowerCase().includes(`wmo_region_${wmoRegion}`)) {
        return false;
      }
      if (wantedZone !== undefined || climateZoneDetermined !== undefined) {
        // Parsed once per station: both keys ask about the same label, and the
        // shipped index is 69,638 records.
        const zoneCode = zoneCodeOf(s.ashraeClimateZone);
        if (wantedZone !== undefined && zoneCode !== wantedZone) return false;
        if (climateZoneDetermined !== undefined) {
          // Deliberately not `zoneCode === null`: that is also true of an unrecognised
          // code, which is not the same thing as upstream reporting it could not
          // determine one.
          const matched = climateZoneDetermined
            ? zoneCode !== null
            : zoneIsUndetermined(s.ashraeClimateZone);
          if (!matched) return false;
        }
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
