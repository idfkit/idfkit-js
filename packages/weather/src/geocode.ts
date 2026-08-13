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

/** Raised when an address or IP cannot be resolved to coordinates. */
export class GeocodingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GeocodingError';
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
 * @throws {@link GeocodingError} when the address cannot be resolved or the
 * service is unreachable.
 */
export async function geocode(
  address: string,
  options: GeocodeOptions = {}
): Promise<[number, number]> {
  await nominatimLimiter.wait();
  const doFetch = resolveFetch(options.fetch);
  const params = new URLSearchParams({ q: address, format: 'json', limit: '1' });
  const url = `${NOMINATIM_URL}?${params.toString()}`;

  let data: Array<{ lat?: string; lon?: string }>;
  try {
    const response = await doFetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: options.signal,
    });
    data = (await response.json()) as Array<{ lat?: string; lon?: string }>;
  } catch (cause) {
    throw new GeocodingError(`Failed to geocode address: ${address}`, { cause });
  }

  const first = data[0];
  if (first?.lat === undefined || first.lon === undefined) {
    throw new GeocodingError(`No results found for address: ${address}`);
  }
  return [Number(first.lat), Number(first.lon)];
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
 * @throws {@link GeocodingError} when the IP cannot be located.
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

  let data: {
    error?: boolean;
    reason?: string;
    latitude?: number;
    longitude?: number;
  };
  try {
    const response = await doFetch(IPAPI_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: options.signal,
    });
    data = (await response.json()) as typeof data;
  } catch (cause) {
    throw new GeocodingError(`Failed to detect location from IP: ${String(cause)}`, { cause });
  }

  if (data.error) {
    throw new GeocodingError(
      `ipapi.co could not locate this IP: ${data.reason ?? 'unknown error'}`
    );
  }
  if (data.latitude === undefined || data.longitude === undefined) {
    throw new GeocodingError('ipapi.co response missing latitude/longitude');
  }

  const coords: [number, number] = [Number(data.latitude), Number(data.longitude)];
  if (maxAgeMs > 0) ipCache = { coords, fetchedAt: Date.now() };
  return coords;
}
