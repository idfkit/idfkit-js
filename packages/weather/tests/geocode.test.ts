import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { detectLocation, geocode, GeocodingError, RateLimiter } from '@idfkit/weather';
import type { FetchLike } from '@idfkit/weather';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

// The module-level limiters would otherwise hold every call here a second apart.
// RateLimiter's own behaviour is covered on a fresh instance below.
const skipRateLimit = () => {
  beforeEach(() => {
    vi.spyOn(RateLimiter.prototype, 'wait').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
};

// A 200 whose body fails part-way through, as a dropped connection produces.
const truncated = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('[{"lat":'));
        controller.error(new TypeError('terminated'));
      },
    }),
    { status: 200 }
  );

describe('geocode', () => {
  skipRateLimit();

  it('returns coordinates from a Nominatim hit', async () => {
    const fetchMock: FetchLike = vi.fn(async () => json([{ lat: '40.7484', lon: '-73.9857' }]));
    const [lat, lon] = await geocode('Empire State Building', { fetch: fetchMock });
    expect(lat).toBeCloseTo(40.7484, 4);
    expect(lon).toBeCloseTo(-73.9857, 4);
  });

  it('spreads straight into a coordinate pair', async () => {
    const fetchMock: FetchLike = async () => json([{ lat: '51.5', lon: '-0.12' }]);
    const coords = await geocode('London', { fetch: fetchMock });
    expect(coords).toHaveLength(2);
  });

  // Issue #88: an application must tell "no such place" from "try again later"
  // without matching message text.
  const rejection = async (fetchMock: FetchLike): Promise<GeocodingError> => {
    const error: unknown = await geocode('somewhere', { fetch: fetchMock }).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(GeocodingError);
    return error as GeocodingError;
  };

  it("reports an empty result as kind 'not-found'", async () => {
    const error = await rejection(async () => json([]));
    expect(error.kind).toBe('not-found');
    expect(error.status).toBeUndefined();
  });

  it("reports a network failure as kind 'unreachable', keeping the cause", async () => {
    const offline = new TypeError('fetch failed');
    const error = await rejection(async () => {
      throw offline;
    });
    expect(error.kind).toBe('unreachable');
    expect(error.cause).toBe(offline);
  });

  it("reports an HTTP error as kind 'http' with its status", async () => {
    const error = await rejection(
      async () => new Response('slow down', { status: 429, statusText: 'Too Many Requests' })
    );
    expect(error.kind).toBe('http');
    expect(error.status).toBe(429);
  });

  it.each([
    ['a body that is not JSON', '<html>captive portal</html>'],
    ['a JSON body that is not an array', '{"error":"bad"}'],
    ['a hit without coordinates', '[{"display_name":"x"}]'],
    ['a hit with blank coordinates', '[{"lat":"","lon":""}]'],
    ['a hit with null coordinates', '[{"lat":null,"lon":null}]'],
  ])("reports %s as kind 'invalid-response'", async (_label, body) => {
    const error = await rejection(async () => new Response(body, { status: 200 }));
    expect(error.kind).toBe('invalid-response');
  });

  it("reports a body cut off in transit as kind 'unreachable'", async () => {
    const error = await rejection(async () => truncated());
    expect(error.kind).toBe('unreachable');
  });
});

describe('GeocodingError', () => {
  it("defaults to kind 'unreachable' when constructed without one", () => {
    const error = new GeocodingError('offline');
    expect(error.kind).toBe('unreachable');
    expect(error.status).toBeUndefined();
    expect(error.name).toBe('GeocodingError');
  });
});

describe('detectLocation', () => {
  skipRateLimit();

  it('reads latitude/longitude from ipapi.co', async () => {
    const fetchMock: FetchLike = async () => json({ latitude: 41.85, longitude: -87.65 });
    const [lat, lon] = await detectLocation({ fetch: fetchMock, maxAgeMs: 0 });
    expect(lat).toBeCloseTo(41.85, 2);
    expect(lon).toBeCloseTo(-87.65, 2);
  });

  it('raises on an ipapi.co error payload', async () => {
    const fetchMock: FetchLike = async () => json({ error: true, reason: 'Reserved IP Address' });
    await expect(detectLocation({ fetch: fetchMock, maxAgeMs: 0 })).rejects.toThrow(/Reserved IP/);
    await expect(detectLocation({ fetch: fetchMock, maxAgeMs: 0 })).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it("reports a rate-limit payload as kind 'http' with status 429, not 'not-found'", async () => {
    const fetchMock: FetchLike = async () =>
      json({ error: true, reason: 'RateLimited', message: 'Visit https://ipapi.co/ratelimited/' });
    await expect(detectLocation({ fetch: fetchMock, maxAgeMs: 0 })).rejects.toMatchObject({
      kind: 'http',
      status: 429,
    });
  });

  it.each([
    ['null', { latitude: null, longitude: null }],
    ['non-numeric', { latitude: 'abc', longitude: 'def' }],
  ])("reports %s coordinates as kind 'invalid-response'", async (_label, body) => {
    const fetchMock: FetchLike = async () => json(body);
    await expect(detectLocation({ fetch: fetchMock, maxAgeMs: 0 })).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it("reports a body cut off in transit as kind 'unreachable'", async () => {
    await expect(
      detectLocation({ fetch: async () => truncated(), maxAgeMs: 0 })
    ).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it("reports an HTTP error as kind 'http' with its status", async () => {
    const fetchMock: FetchLike = async () => new Response('', { status: 503 });
    await expect(detectLocation({ fetch: fetchMock, maxAgeMs: 0 })).rejects.toMatchObject({
      kind: 'http',
      status: 503,
    });
  });

  it("reports a network failure as kind 'unreachable'", async () => {
    const fetchMock: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(detectLocation({ fetch: fetchMock, maxAgeMs: 0 })).rejects.toMatchObject({
      kind: 'unreachable',
    });
  });

  it("reports a response without coordinates as kind 'invalid-response'", async () => {
    const fetchMock: FetchLike = async () => json({ city: 'somewhere' });
    await expect(detectLocation({ fetch: fetchMock, maxAgeMs: 0 })).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });
});

describe('RateLimiter', () => {
  it('spaces successive waits by at least the interval', async () => {
    const limiter = new RateLimiter(30);
    const start = Date.now();
    await limiter.wait(); // first is immediate
    await limiter.wait(); // second waits ~30ms
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it('lets the first wait through immediately after a reset', async () => {
    const limiter = new RateLimiter(1000);
    await limiter.wait();
    limiter.reset();
    const start = Date.now();
    await limiter.wait();
    expect(Date.now() - start).toBeLessThan(200);
  });
});
