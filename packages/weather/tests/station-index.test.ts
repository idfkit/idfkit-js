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

// ---------------------------------------------------------------------------
// Climate zone filtering
// ---------------------------------------------------------------------------
//
// THESE READ THE REAL SHIPPED INDEX, NOT FIXTURES, AND THAT IS THE POINT.
//
// A fixture carrying only A and B zones passes while the marine zones are silently
// dropped. That is not hypothetical: matching the code as `[0-9][AB]?` loses 3C, 4C and
// 5C, which is 1,653 stations, leaves sixteen zones where there are nineteen, throws
// nothing and looks correct. Two authors made that exact slip on this exact data before
// these tests existed.

describe('climate zone filtering, over the shipped index', () => {
  // Counts drawn from the shipped index at its current build, per FR-019b and SC-006.
  // They are the assertion T018 asks for: a change that moves stations between two
  // zones while preserving the total passes every other test in this block.
  const ZONE_COUNTS: Record<string, number> = {
    '0A': 6223,
    '0B': 926,
    '1A': 5122,
    '1B': 746,
    '2A': 6050,
    '2B': 1230,
    '3A': 9048,
    '3B': 1352,
    '3C': 739,
    '4A': 7952,
    '4B': 658,
    '4C': 462,
    '5A': 8641,
    '5B': 740,
    '5C': 452,
    '6A': 6296,
    '6B': 574,
    '7': 6847,
    '8': 3418,
  };

  const ASHRAE_ZONES = Object.keys(ZONE_COUNTS);

  const UNDETERMINED = 2162;

  // Loaded once for the whole suite. The bundled index is 1.7 MB gzipped, and reading,
  // gunzipping and parsing it per test was the bulk of this file's runtime.
  let shipped: Promise<StationIndex> | undefined;

  function shippedIndex(): Promise<StationIndex> {
    shipped ??= import('@idfkit/weather/node').then((m) => m.loadBundledIndex());
    return shipped;
  }

  it('carries exactly the nineteen ASHRAE zones', async () => {
    const index = await shippedIndex();
    const found = new Set(
      index
        .filter({ climateZoneDetermined: true })
        .map((s) => s.ashraeClimateZone.split('-')[0]?.trim())
    );
    // A twentieth code is an upstream change, and this is where it surfaces. It must
    // fail a build rather than quietly alter what a filter returns.
    expect([...found].sort()).toEqual([...ASHRAE_ZONES].sort());
  });

  it('has no station carrying a code outside the nineteen', async () => {
    // The assertion that NAMES an upstream change rather than merely detecting one.
    //
    // The nineteen-zone test above does not catch this: a twentieth code is neither a
    // zone nor undetermined, so it drops out of both filters and leaves nineteen
    // standing. The reachability test below does catch it, as a total that no longer
    // adds up, but reports `expected 69638, got 69588`, which points at the wrong fact.
    const index = await shippedIndex();
    const outside = new Map<string, number>();
    for (const s of index.stations) {
      if (/could not be determined/i.test(s.ashraeClimateZone)) continue;
      const code = (s.ashraeClimateZone.split('-')[0] ?? '').trim().toUpperCase();
      if (!ASHRAE_ZONES.includes(code)) {
        outside.set(code, (outside.get(code) ?? 0) + 1);
      }
    }
    expect([...outside]).toEqual([]);
  });

  it('returns the expected count for every zone', async () => {
    // Counted, not merely non-empty. A change that moves stations between two zones
    // while preserving the total, such as a label parse mapping some 5B labels to 5A,
    // passes a non-emptiness check, passes the prefix check for whatever survives, and
    // passes the partition check below.
    const index = await shippedIndex();
    const counted: Record<string, number> = {};
    for (const zone of ASHRAE_ZONES) counted[zone] = index.filter({ climateZone: zone }).length;
    expect(counted).toEqual(ZONE_COUNTS);
  });

  it('returns only stations of the requested zone, for every zone', async () => {
    const index = await shippedIndex();
    let total = 0;
    for (const zone of ASHRAE_ZONES) {
      const hits = index.filter({ climateZone: zone });
      expect(hits.length).toBeGreaterThan(0);
      for (const s of hits) expect(s.ashraeClimateZone.startsWith(zone)).toBe(true);
      total += hits.length;
    }
    // Every determined station is in exactly one zone, so the zones partition them.
    expect(total).toBe(index.filter({ climateZoneDetermined: true }).length);
    expect(total + UNDETERMINED).toBe(index.size);
  });

  it('never returns an undetermined station under any zone', async () => {
    const index = await shippedIndex();
    const undetermined = index.filter({ climateZoneDetermined: false });
    expect(undetermined.length).toBe(UNDETERMINED);
    for (const zone of ASHRAE_ZONES) {
      for (const s of index.filter({ climateZone: zone })) {
        expect(s.ashraeClimateZone).not.toMatch(/could not be determined/i);
      }
    }
    // The label's first token looks like a code and is not one. Asking for 7A or 8A as
    // zones must find nothing rather than finding these.
    expect(index.filter({ climateZone: '7A' })).toHaveLength(0);
    expect(index.filter({ climateZone: '8A' })).toHaveLength(0);
  });

  it('keeps the undetermined stations reachable rather than omitting them', async () => {
    const index = await shippedIndex();
    const determined = index.filter({ climateZoneDetermined: true }).length;
    const undetermined = index.filter({ climateZoneDetermined: false }).length;
    // Every station is reachable through one of the two, which is what stops the
    // undetermined ones becoming a hole nobody can query.
    expect(determined + undetermined).toBe(index.size);
  });

  it('ignores case and combines with the other keys', async () => {
    const index = await shippedIndex();
    expect(index.filter({ climateZone: '5a' }).length).toBe(
      index.filter({ climateZone: '5A' }).length
    );
    const combined = index.filter({ climateZone: '5A', country: 'USA' });
    for (const s of combined) {
      expect(s.country).toBe('USA');
      expect(s.ashraeClimateZone.startsWith('5A')).toBe(true);
    }
    expect(combined.length).toBeLessThan(index.filter({ climateZone: '5A' }).length);
    // With state too, which is the combination a station picker actually issues. The
    // marine zones are the ones a wrong suffix pattern loses, so 3C is the case chosen.
    expect(index.filter({ climateZone: '3C', country: 'USA', state: 'CA' })).toHaveLength(238);
    expect(index.filter({ climateZone: '4C', country: 'USA', state: 'WA' })).toHaveLength(115);
  });

  it('treats an empty zone as no constraint, as country and state already are', async () => {
    // An empty select is no filter, not a filter matching nothing. A UI binding a blank
    // dropdown to this key would otherwise get zero stations from it and every station
    // from `country` and `state` given the same blank value.
    const index = await shippedIndex();
    expect(index.filter({ climateZone: '' })).toHaveLength(index.size);
    expect(index.filter({ country: '' })).toHaveLength(index.size);
    expect(index.filter({ state: '' })).toHaveLength(index.size);
  });

  it('reads the zone sentence as undetermined, not any other absence', async () => {
    // The guard is anchored on the subject, so it cannot swallow a different absence.
    // A label reporting that something else about the station was undetermined must
    // keep its zone: filing it under undetermined would report that upstream did not
    // state a zone it did state.
    const constructed = StationIndex.fromStations([
      makeStation({
        city: 'Stated',
        ashraeClimateZone: '5A - Cool - Humid (elevation could not be determined)',
      }),
      makeStation({
        city: 'Unstated',
        ashraeClimateZone: '7A - ASHRAE Climate Zone could not be determined',
      }),
    ]);
    expect(constructed.filter({ climateZone: '5A' }).map((s) => s.city)).toEqual(['Stated']);
    expect(constructed.filter({ climateZoneDetermined: false }).map((s) => s.city)).toEqual([
      'Unstated',
    ]);
  });
});
