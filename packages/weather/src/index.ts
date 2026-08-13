/**
 * `@idfkit/weather` — browser-side EPW weather-file retrieval for EnergyPlus.
 *
 * Search the climate.onebuilding.org TMYx station index, then download and
 * unpack EPW/DDY/STAT files — with no filesystem and no dependencies, so it
 * runs in a browser, a worker, an edge runtime, or Node alike. The EPW text it
 * returns feeds straight into
 * [`@idfkit/engine`](https://www.npmjs.com/package/@idfkit/engine).
 *
 * Everything exported here is portable. It reaches the network through the
 * global `fetch` (overridable per call), which matters because
 * climate.onebuilding.org sends no CORS header: from a page, route requests
 * through your own proxy via the `rewriteUrl` / `baseUrl` / `fetch` options.
 * Node-only conveniences — the bundled index and writing files to disk — live
 * in `@idfkit/weather/node`.
 */

export { WeatherStation } from './station.js';
export type {
  MatchField,
  SearchResult,
  SpatialResult,
  StationRecord,
  WeatherStationFields,
} from './station.js';

export { StationIndex } from './station-index.js';
export type { FilterOptions, NearestOptions, SearchOptions } from './station-index.js';

export { haversineKm } from './spatial.js';
export { parseKml, parseUrlMetadata } from './kml.js';

export {
  checkForUpdates,
  indexFromData,
  INDEX_FILES,
  loadStationIndex,
  refreshStationIndex,
  SOURCES_BASE_URL,
} from './load.js';
export type { IndexData, LoadIndexOptions, RefreshIndexOptions } from './load.js';

export {
  fetchEpw,
  fetchEpwByFilename,
  fetchWeatherArchive,
  fetchWeatherFiles,
} from './download.js';
export type { FetchWeatherOptions, WeatherFiles } from './download.js';

export { unzip } from './unzip.js';

export { detectLocation, geocode, GeocodingError, RateLimiter } from './geocode.js';
export type { DetectLocationOptions, GeocodeOptions } from './geocode.js';

export type { FetchLike } from './http.js';
