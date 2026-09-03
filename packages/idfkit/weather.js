/**
 * `idfkit/weather`, which is `@idfkit/weather` behind a named-install guard.
 *
 * WHY THIS FILE IS NOT `export * from '@idfkit/weather'`
 *
 * @idfkit/weather is an optional peer dependency: `npm install idfkit` does not
 * install it, which is what keeps its 1.6 MB station index off disk for the
 * readers who never ask for weather (FR-043, SC-016). The cost is that this
 * subpath can be imported while the package behind it is absent, and FR-074
 * requires that failure to name the component to install rather than surface as
 * a bare unresolved-module error.
 *
 * A static `export * from '@idfkit/weather'` cannot do that. Static re-exports
 * are resolved and linked before any module in the graph is evaluated, so there
 * is no point at which this file's own code runs first: Node fails the link with
 *
 *     ERR_MODULE_NOT_FOUND: Cannot find package '@idfkit/weather' imported from
 *     .../node_modules/idfkit/weather.js
 *
 * and nothing here is ever reached. The `imports` fallback array
 * (`"#weather": ["@idfkit/weather", "./weather-missing.js"]`) looks like the
 * mechanism for exactly this and is not: measured on Node 22.12, a fallback
 * array falls through on an invalid target, not on a package that is not
 * installed, so the same ERR_MODULE_NOT_FOUND comes back.
 *
 * WHAT THIS COSTS, AND WHAT IT DELIBERATELY DOES NOT
 *
 * A dynamic import can be caught, so the guard below is a top-level `await`.
 * That makes this module asynchronous in the module graph. It does not make the
 * API asynchronous: every name below is an ordinary synchronous binding, and
 * importing code is unchanged from a plain re-export.
 *
 *     import { StationIndex } from 'idfkit/weather';
 *     const index = await StationIndex.load();   // exactly as with @idfkit/weather
 *
 * The awaited module graph is the whole price. Concretely: `require()` of this
 * subpath cannot work, which costs nothing because every package here is ESM
 * only and has no CommonJS entry point; and a bundler must support top-level
 * await, which Node >= 20, esbuild, Rollup, Vite and webpack >= 5.83 all do.
 *
 * The second cost is that a dynamic import cannot be spread with `export *`,
 * so the re-exported names are written out. That list can drift from the real
 * surface of @idfkit/weather with nothing noticing, which is why it does not
 * drift silently: `npm run check:facade` reads both and fails on any difference.
 *
 * Types are not affected. `weather.d.ts` next to this file is the plain
 * `export * from '@idfkit/weather'`, so the declared surface is the peer's own,
 * whole, including the names that exist only as types.
 */

/** Every form of "that package is not installed" worth translating. */
const NOT_FOUND = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);

/**
 * The peer, or a failure that says how to get it.
 *
 * Only a resolution failure naming @idfkit/weather itself is translated. An
 * error thrown from inside @idfkit/weather, including one about some other
 * module it could not find, is re-thrown untouched: telling someone to install
 * a package they already have would be worse than the original message.
 */
let weather;
try {
  weather = await import('@idfkit/weather');
} catch (error) {
  const absent = NOT_FOUND.has(error?.code) && String(error?.message).includes('@idfkit/weather');
  if (!absent) throw error;
  throw new Error(
    "idfkit/weather requires the optional component '@idfkit/weather', which is not installed.\n" +
      '\n' +
      '    npm install @idfkit/weather\n' +
      '\n' +
      'It is an optional peer dependency, so installing idfkit deliberately leaves it out: ' +
      'the weather code and its 1.6 MB station index stay off disk for everyone who does not ' +
      'ask for them. Everything else in idfkit works without it.',
    { cause: error }
  );
}

export const GeocodingError = weather.GeocodingError;
export const INDEX_FILES = weather.INDEX_FILES;
export const RateLimiter = weather.RateLimiter;
export const SOURCES_BASE_URL = weather.SOURCES_BASE_URL;
export const StationIndex = weather.StationIndex;
export const WeatherStation = weather.WeatherStation;
export const checkForUpdates = weather.checkForUpdates;
export const detectLocation = weather.detectLocation;
export const fetchEpw = weather.fetchEpw;
export const fetchEpwByFilename = weather.fetchEpwByFilename;
export const fetchWeatherArchive = weather.fetchWeatherArchive;
export const fetchWeatherFiles = weather.fetchWeatherFiles;
export const geocode = weather.geocode;
export const haversineKm = weather.haversineKm;
export const indexFromData = weather.indexFromData;
export const loadStationIndex = weather.loadStationIndex;
export const parseKml = weather.parseKml;
export const parseUrlMetadata = weather.parseUrlMetadata;
export const refreshStationIndex = weather.refreshStationIndex;
export const unzip = weather.unzip;
