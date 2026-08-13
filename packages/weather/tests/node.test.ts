import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadBundledIndex, saveWeatherFiles } from '@idfkit/weather/node';
import type { WeatherFiles } from '@idfkit/weather';

import { makeStation } from './helpers.js';

describe('loadBundledIndex', () => {
  it('loads the shipped index off disk with no network', async () => {
    const index = await loadBundledIndex();
    expect(index.size).toBeGreaterThan(60_000);

    const results = index.search('chicago ohare');
    expect(results[0]?.station.country).toBe('USA');
    expect(index.getByWmo('725300').length).toBeGreaterThan(0);
  });
});

describe('saveWeatherFiles', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'idfkit-weather-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes epw/ddy/stat and returns their paths', async () => {
    const station = makeStation();
    const files: WeatherFiles = {
      station,
      epw: 'LOCATION,Chicago,IL,USA',
      ddy: 'DesignDay',
      stat: null,
      members: new Map(),
    };

    const saved = await saveWeatherFiles(files, dir);
    expect(saved.epw).toBe(join(dir, `${station.filenameStem}.epw`));
    expect(saved.ddy).toBe(join(dir, `${station.filenameStem}.ddy`));
    expect(saved.stat).toBeNull();
    expect(readFileSync(saved.epw, 'latin1')).toContain('Chicago');
  });

  it('honours a custom stem', async () => {
    const files: WeatherFiles = {
      station: makeStation(),
      epw: 'LOCATION',
      ddy: null,
      stat: null,
      members: new Map(),
    };
    const saved = await saveWeatherFiles(files, dir, { stem: 'weather' });
    expect(saved.epw).toBe(join(dir, 'weather.epw'));
  });
});
