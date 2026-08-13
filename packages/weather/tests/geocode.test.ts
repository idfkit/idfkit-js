import { describe, expect, it, vi } from 'vitest';

import { detectLocation, geocode, GeocodingError, RateLimiter } from '@idfkit/weather';
import type { FetchLike } from '@idfkit/weather';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('geocode', () => {
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

  it('throws GeocodingError when there are no results', async () => {
    const fetchMock: FetchLike = async () => json([]);
    await expect(geocode('nowhere at all', { fetch: fetchMock })).rejects.toBeInstanceOf(
      GeocodingError
    );
  });

  it('wraps a network failure as GeocodingError', async () => {
    const fetchMock: FetchLike = async () => {
      throw new Error('offline');
    };
    await expect(geocode('x', { fetch: fetchMock })).rejects.toBeInstanceOf(GeocodingError);
  });
});

describe('detectLocation', () => {
  it('reads latitude/longitude from ipapi.co', async () => {
    const fetchMock: FetchLike = async () => json({ latitude: 41.85, longitude: -87.65 });
    const [lat, lon] = await detectLocation({ fetch: fetchMock, maxAgeMs: 0 });
    expect(lat).toBeCloseTo(41.85, 2);
    expect(lon).toBeCloseTo(-87.65, 2);
  });

  it('raises on an ipapi.co error payload', async () => {
    const fetchMock: FetchLike = async () => json({ error: true, reason: 'rate limited' });
    await expect(detectLocation({ fetch: fetchMock, maxAgeMs: 0 })).rejects.toThrow(/rate limited/);
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
