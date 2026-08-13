import { describe, expect, it, vi } from 'vitest';

import { fetchEpw, fetchEpwByFilename, fetchWeatherFiles, StationIndex } from '@idfkit/weather';
import type { FetchLike } from '@idfkit/weather';

import { buildZip, makeStation } from './helpers.js';

function zipResponse(entries: Record<string, Uint8Array>): Response {
  const archive = buildZip(entries);
  return new Response(archive, { status: 200 });
}

const enc = (s: string) => new TextEncoder().encode(s);

describe('fetchWeatherFiles', () => {
  it('downloads, unzips, and decodes epw/ddy/stat', async () => {
    const station = makeStation();
    const fetchMock: FetchLike = vi.fn(async () =>
      zipResponse({
        [`${station.filenameStem}.epw`]: enc('LOCATION,Chicago,IL,USA'),
        [`${station.filenameStem}.ddy`]: enc('DesignDay'),
        [`${station.filenameStem}.stat`]: enc('Statistics'),
        [`${station.filenameStem}.wea`]: enc('ignored'),
      })
    );

    const files = await fetchWeatherFiles(station, { fetch: fetchMock });
    expect(files.epw).toContain('LOCATION,Chicago');
    expect(files.ddy).toBe('DesignDay');
    expect(files.stat).toBe('Statistics');
    expect(files.members.has(`${station.filenameStem}.wea`)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(station.url, expect.anything());
  });

  it('reports null for a missing ddy or stat', async () => {
    const station = makeStation();
    const fetchMock: FetchLike = async () =>
      zipResponse({ [`${station.filenameStem}.epw`]: enc('LOCATION') });
    const files = await fetchWeatherFiles(station, { fetch: fetchMock });
    expect(files.ddy).toBeNull();
    expect(files.stat).toBeNull();
  });

  it('throws when the archive has no epw', async () => {
    const station = makeStation();
    const fetchMock: FetchLike = async () => zipResponse({ 'x.ddy': enc('d') });
    await expect(fetchWeatherFiles(station, { fetch: fetchMock })).rejects.toThrow(/no \.epw/i);
  });

  it('applies rewriteUrl so a proxy can be injected', async () => {
    const station = makeStation();
    const seen: string[] = [];
    const fetchMock: FetchLike = async (url) => {
      seen.push(String(url));
      return zipResponse({ [`${station.filenameStem}.epw`]: enc('LOCATION') });
    };
    await fetchWeatherFiles(station, {
      fetch: fetchMock,
      rewriteUrl: (u) => `https://proxy.example/?url=${encodeURIComponent(u)}`,
    });
    expect(seen[0]).toBe(`https://proxy.example/?url=${encodeURIComponent(station.url)}`);
  });

  it('surfaces an HTTP error', async () => {
    const station = makeStation();
    const fetchMock: FetchLike = async () => new Response('nope', { status: 404 });
    await expect(fetchEpw(station, { fetch: fetchMock })).rejects.toThrow(/404/);
  });
});

describe('fetchEpwByFilename', () => {
  it('resolves the filename through an index then downloads', async () => {
    const station = makeStation();
    const index = StationIndex.fromStations([station]);
    const fetchMock: FetchLike = async () =>
      zipResponse({ [`${station.filenameStem}.epw`]: enc('LOCATION,Chicago') });

    const epw = await fetchEpwByFilename(`${station.filenameStem}.epw`, index, {
      fetch: fetchMock,
    });
    expect(epw).toContain('Chicago');
  });

  it('throws when the filename matches no station', async () => {
    const index = StationIndex.fromStations([]);
    await expect(fetchEpwByFilename('nope.epw', index)).rejects.toThrow(/No weather station/);
  });
});
