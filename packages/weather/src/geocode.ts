/**
 * Turn an address, or this machine's IP, into coordinates.
 *
 * Both functions return a `[latitude, longitude]` tuple that spreads straight
 * into {@link StationIndex.nearest} — the "splat" pattern the Python library
 * documents:
 *
 * ```ts
 * const index = await loadBundledIndex();
 * const results = index.nearest(...(await geocode('350 Fifth Avenue, New York')));
 * ```
 *
 * Geocoding uses the free Nominatim (OpenStreetMap) service, which asks callers
 * to stay under one request per second; a shared rate limiter enforces that.
 */

import { resolveFetch, USER_AGENT, type FetchLike } from './http.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const IPAPI_URL = 'https://ipapi.co/json/';

/**
 * Why a geocoding call failed. Not exported by name; spell it
 * `GeocodingError['kind']`.
 *
 * - `'not-found'`: the service answered and has no location for the query. Retrying will not help;
 *   a different query might.
 * - `'unreachable'`: the request never got an answer (offline, DNS, refused, timed out, aborted).
 *   A retry may help.
 * - `'http'`: the service answered with an HTTP error; {@link GeocodingError.status} holds the
 *   code. A `429` or `5xx` may clear on retry.
 * - `'invalid-response'`: the service answered `2xx` with a body that is not the expected JSON,
 *   which is what a captive portal or an intercepting proxy produces.
 */
type GeocodingErrorKind = 'not-found' | 'unreachable' | 'http' | 'invalid-response';

/** Options for constructing a {@link GeocodingError}. */
interface GeocodingErrorOptions {
  /** Defaults to `'unreachable'`. */
  kind?: GeocodingErrorKind;
  /** The HTTP status, when `kind` is `'http'`. */
  status?: number;
  cause?: unknown;
}

/**
 * Raised when an address or IP cannot be resolved to coordinates. Branch on
 * {@link GeocodingError.kind} rather than on the message, whose wording may change.
 */
export class GeocodingError extends Error {
  /** Why the call failed. */
  readonly kind: GeocodingErrorKind;
  /** The HTTP status, when {@link GeocodingError.kind} is `'http'`; otherwise `undefined`. */
  readonly status: number | undefined;

  constructor(message: string, options: GeocodingErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GeocodingError';
    this.kind = options.kind ?? 'unreachable';
    this.status = options.status;
  }
}

/**
 * Serializes calls so that consecutive requests are at least `minIntervalMs`
 * apart. JavaScript is single-threaded, so a chained promise is all it takes —
 * no locks, unlike the Python version.
 */
export class RateLimiter {
  #minIntervalMs: number;
  #last = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(minIntervalMs = 1000) {
    this.#minIntervalMs = minIntervalMs;
  }

  /** Resolve once the caller may proceed without breaking the interval. */
  wait(): Promise<void> {
    this.#tail = this.#tail.then(async () => {
      const elapsed = Date.now() - this.#last;
      if (elapsed < this.#minIntervalMs) {
        await sleep(this.#minIntervalMs - elapsed);
      }
      this.#last = Date.now();
    });
    return this.#tail;
  }

  /** Reset the limiter, so the next `wait` returns immediately. */
  reset(): void {
    this.#last = 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read a response body as JSON. A body that fails to arrive (a dropped connection, an abort)
 * is `'unreachable'`, as it would be had the headers never arrived; a body that arrives and
 * does not parse is `'invalid-response'`.
 */
async function readJson(response: Response, message: (cause: unknown) => string): Promise<unknown> {
  let body: string;
  try {
    body = await response.text();
  } catch (cause) {
    throw new GeocodingError(message(cause), { kind: 'unreachable', cause });
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (cause) {
    throw new GeocodingError(message(cause), { kind: 'invalid-response', cause });
  }
}

/**
 * A coordinate from a JSON field: a number, or a non-blank numeric string. Anything else,
 * including `null`, `''` and `true` (which `Number` reads as `0` or `1`), is `NaN`.
 */
function coordinate(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

const nominatimLimiter = new RateLimiter(1000);
const ipapiLimiter = new RateLimiter(1000);

/** Options accepted by {@link geocode} and {@link detectLocation}. */
export interface GeocodeOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * Geocode a free-form address to `[latitude, longitude]` via Nominatim.
 *
 * No API key. Requests are rate-limited to one per second to comply with the
 * Nominatim usage policy.
 *
 * @throws {@link GeocodingError} when the address cannot be resolved. Its
 * `kind` says why: `'not-found'` when Nominatim has no match, `'unreachable'`
 * when the request failed, `'http'` (with `status`) on an HTTP error, and
 * `'invalid-response'` when the body is not what Nominatim returns.
 */
export async function geocode(
  address: string,
  options: GeocodeOptions = {}
): Promise<[number, number]> {
  await nominatimLimiter.wait();
  const doFetch = resolveFetch(options.fetch);
  const params = new URLSearchParams({ q: address, format: 'json', limit: '1' });
  const url = `${NOMINATIM_URL}?${params.toString()}`;

  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: options.signal,
    });
  } catch (cause) {
    throw new GeocodingError(`Failed to geocode address: ${address}`, {
      kind: 'unreachable',
      cause,
    });
  }
  if (!response.ok) {
    throw new GeocodingError(
      `Failed to geocode address ${address}: ${response.status} ${response.statusText}`,
      { kind: 'http', status: response.status }
    );
  }

  const data = await readJson(response, () => `Failed to geocode address: ${address}`);
  if (!Array.isArray(data)) {
    throw new GeocodingError(`Unexpected response geocoding address: ${address}`, {
      kind: 'invalid-response',
    });
  }
  if (data.length === 0) {
    throw new GeocodingError(`No results found for address: ${address}`, { kind: 'not-found' });
  }

  const first = data[0] as { lat?: unknown; lon?: unknown } | null;
  const lat = coordinate(first?.lat);
  const lon = coordinate(first?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new GeocodingError(`Unexpected response geocoding address: ${address}`, {
      kind: 'invalid-response',
    });
  }
  return [lat, lon];
}

interface CachedLocation {
  coords: [number, number];
  fetchedAt: number;
}
let ipCache: CachedLocation | undefined;

/** Options for {@link detectLocation}. */
export interface DetectLocationOptions extends GeocodeOptions {
  /**
   * How long an in-memory cached result stays valid, in milliseconds. Default
   * one hour. `0` disables caching (always re-fetch).
   */
  maxAgeMs?: number;
}

/**
 * Detect approximate `[latitude, longitude]` from this machine's public IP,
 * via ipapi.co over HTTPS. Accuracy is city-level — enough to find the nearest
 * TMYx stations, not for precise positioning.
 *
 * The result is cached in memory for `maxAgeMs` (default one hour) so repeated
 * calls do not hammer the service. Calling this sends your public IP to
 * ipapi.co; prefer {@link geocode} or explicit coordinates if you would rather
 * it did not.
 *
 * @throws {@link GeocodingError} when the IP cannot be located. Its `kind`
 * reads as for {@link geocode}; `'not-found'` means ipapi.co answered with an
 * error payload, such as for a reserved address. An error payload that reports a
 * rate limit or an exhausted quota is `'http'` with `status` `429` instead.
 */
export async function detectLocation(
  options: DetectLocationOptions = {}
): Promise<[number, number]> {
  const maxAgeMs = options.maxAgeMs ?? 60 * 60 * 1000;
  if (maxAgeMs > 0 && ipCache && Date.now() - ipCache.fetchedAt <= maxAgeMs) {
    return ipCache.coords;
  }

  await ipapiLimiter.wait();
  const doFetch = resolveFetch(options.fetch);

  let response: Response;
  try {
    response = await doFetch(IPAPI_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: options.signal,
    });
  } catch (cause) {
    throw new GeocodingError(`Failed to detect location from IP: ${String(cause)}`, {
      kind: 'unreachable',
      cause,
    });
  }
  if (!response.ok) {
    throw new GeocodingError(
      `Failed to detect location from IP: ${response.status} ${response.statusText}`,
      { kind: 'http', status: response.status }
    );
  }

  const data = (await readJson(
    response,
    (cause) => `Failed to detect location from IP: ${String(cause)}`
  )) as {
    error?: unknown;
    reason?: unknown;
    message?: unknown;
    latitude?: unknown;
    longitude?: unknown;
  } | null;

  if (data?.error) {
    const reason = String(data.reason || data.message || 'unknown error');
    // ipapi.co reports a rate limit or an exhausted quota in the same payload shape as a
    // reserved address. Only the latter means a retry will not help.
    if (/rate ?limit|quota/i.test(`${reason} ${String(data.message ?? '')}`)) {
      throw new GeocodingError(`ipapi.co rate-limited this request: ${reason}`, {
        kind: 'http',
        status: 429,
      });
    }
    throw new GeocodingError(`ipapi.co could not locate this IP: ${reason}`, { kind: 'not-found' });
  }
  if (data?.latitude == null || data.longitude == null) {
    throw new GeocodingError('ipapi.co response missing latitude/longitude', {
      kind: 'invalid-response',
    });
  }
  const latitude = coordinate(data.latitude);
  const longitude = coordinate(data.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new GeocodingError('ipapi.co response has non-numeric latitude/longitude', {
      kind: 'invalid-response',
    });
  }

  const coords: [number, number] = [latitude, longitude];
  if (maxAgeMs > 0) ipCache = { coords, fetchedAt: Date.now() };
  return coords;
}
