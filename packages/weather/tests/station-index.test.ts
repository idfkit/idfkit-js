import { describe, expect, it } from 'vitest';

import { StationIndex } from '@idfkit/weather';

import { makeStation } from './helpers.js';

const chicago = makeStation();
const chicagoOld = makeStation({
  source: 'TMYx.2004-2018',
  url: 'https://climate.onebuilding.org/WMO_Region_4_North_and_Central_America/USA_United_States_of_America/IL_Illinois/USA_IL_Chicago.OHare.Intl.AP.725300_TMYx.2004-2018.zip',
});
const nyc = makeStation({
  state: 'NY',
  city: 'New.York.LaGuardia.AP',
  wmo: '725030',
  latitude: 40.779,
  longitude: -73.88,
  url: 'https://climate.onebuilding.org/WMO_Region_4_North_and_Central_America/USA_United_States_of_America/NY_New_York/USA_NY_New.York.LaGuardia.AP.725030_TMYx.2009-2023.zip',
});
const london = makeStation({
  country: 'GBR',
  state: '',
  city: 'London.Heathrow.AP',
  wmo: '037720',
  latitude: 51.478,
  longitude: -0.461,
  url: 'https://climate.onebuilding.org/WMO_Region_6_Europe/GBR_United_Kingdom/GBR_London.Heathrow.AP.037720_TMYx.2009-2023.zip',
});

const index = StationIndex.fromStations([chicago, chicagoOld, nyc, london]);

describe('StationIndex construction', () => {
  it('reports size and countries', () => {
    expect(index.size).toBe(4);
    expect(index.countries).toEqual(['GBR', 'USA']);
  });
});

describe('StationIndex.search', () => {
  it('finds a city by name', () => {
    const results = index.search('chicago');
    expect(results[0]?.station.wmo).toBe('725300');
    expect(results[0]?.score).toBeGreaterThan(0.8);
  });

  it('scores an exact WMO number highest', () => {
    const results = index.search('037720');
    expect(results[0]?.station.city).toBe('London.Heathrow.AP');
    expect(results[0]?.score).toBe(1);
    expect(results[0]?.matchField).toBe('wmo');
  });

  it('resolves a canonical EPW filename via the fast path', () => {
    const results = index.search('USA_NY_New.York.LaGuardia.AP.725030_TMYx.2009-2023.epw');
    expect(results).toHaveLength(1);
    expect(results[0]?.matchField).toBe('filename');
    expect(results[0]?.station.wmo).toBe('725030');
  });

  it('restricts by country', () => {
    const results = index.search('a', { country: 'GBR', limit: 50 });
    expect(results.every((r) => r.station.country === 'GBR')).toBe(true);
  });

  it('honours the limit', () => {
    expect(index.search('ap', { limit: 1 })).toHaveLength(1);
  });

  it('returns nothing for a blank query', () => {
    expect(index.search('   ')).toEqual([]);
  });
});

describe('StationIndex.nearest', () => {
  it('orders stations by distance', () => {
    const results = index.nearest(40.71, -74.0); // Manhattan
    expect(results[0]?.station.wmo).toBe('725030');
    expect(results[0]?.distanceKm).toBeLessThan(results[1]?.distanceKm ?? Infinity);
  });

  it('applies a max distance', () => {
    const results = index.nearest(40.71, -74.0, { maxDistanceKm: 50 });
    expect(results.every((r) => r.distanceKm <= 50)).toBe(true);
    expect(results.some((r) => r.station.country === 'GBR')).toBe(false);
  });

  it('restricts by country', () => {
    const results = index.nearest(40.71, -74.0, { country: 'GBR' });
    expect(results).toHaveLength(1);
    expect(results[0]?.station.city).toBe('London.Heathrow.AP');
  });

  it('finds a station across the antimeridian within maxDistanceKm', () => {
    // A station just west of +180° must still be found from a query just east
    // of it — the bounding-box pre-filter must not wrongly reject the wrap.
    const acrossLine = makeStation({ wmo: '999001', latitude: 0, longitude: -179.7 });
    const wrapIndex = StationIndex.fromStations([acrossLine]);
    const results = wrapIndex.nearest(0, 179.9, { maxDistanceKm: 100 });
    expect(results).toHaveLength(1);
    expect(results[0]?.station.wmo).toBe('999001');
    expect(results[0]?.distanceKm).toBeLessThan(100);
  });
});

describe('StationIndex exact lookups', () => {
  it('returns every variant for a WMO number', () => {
    const hits = index.getByWmo('725300');
    expect(hits).toHaveLength(2);
    expect(hits.map((s) => s.datasetVariant).sort()).toEqual(['TMYx.2004-2018', 'TMYx.2009-2023']);
  });

  it('matches a filename with or without extension', () => {
    const withExt = index.getByFilename('USA_IL_Chicago.OHare.Intl.AP.725300_TMYx.2004-2018.epw');
    const withoutExt = index.getByFilename('USA_IL_Chicago.OHare.Intl.AP.725300_TMYx.2004-2018');
    expect(withExt).toHaveLength(1);
    expect(withoutExt).toHaveLength(1);
    expect(withExt[0]?.datasetVariant).toBe('TMYx.2004-2018');
  });

  it('falls back to WMO when the exact filename is unknown', () => {
    const hits = index.getByFilename('USA_IL_Chicago.OHare.Intl.AP.725300_TMYx.1999-2000');
    expect(hits).toHaveLength(2);
  });
});

describe('StationIndex.filter', () => {
  it('filters by country and state', () => {
    expect(index.filter({ country: 'USA', state: 'NY' })).toEqual([nyc]);
  });

  it('infers WMO region from the URL', () => {
    expect(index.filter({ wmoRegion: 6 })).toEqual([london]);
    expect(index.filter({ wmoRegion: 4 }).length).toBe(3);
  });
});
