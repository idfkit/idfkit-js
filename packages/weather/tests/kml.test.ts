import { describe, expect, it } from 'vitest';

import { parseKml, parseUrlMetadata } from '@idfkit/weather';

import { kmlDocument, OHARE_PLACEMARK, SENTINEL_PLACEMARK } from './helpers.js';

describe('parseKml', () => {
  it('parses every field of a real placemark', () => {
    const [station, ...rest] = parseKml(kmlDocument(OHARE_PLACEMARK), 'Region4_USA.kml');
    expect(rest).toHaveLength(0);
    expect(station).toBeDefined();
    if (!station) throw new Error('unreachable');

    expect(station.country).toBe('USA');
    expect(station.state).toBe('IL');
    expect(station.city).toBe('Chicago.OHare.Intl.AP');
    expect(station.wmo).toBe('725300');
    expect(station.source).toBe('Custom-725300');
    expect(station.latitude).toBeCloseTo(41.98333, 5);
    expect(station.longitude).toBeCloseTo(-87.9, 5);
    expect(station.timezone).toBe(-6);
    expect(station.elevation).toBe(202);
    expect(station.ashraeClimateZone).toBe('5A - Cool - Humid');
    expect(station.heatingDesignDbC).toBe(-15.3);
    expect(station.coolingDesignDbC).toBe(31.5);
    expect(station.hdd18).toBe(3172);
    expect(station.cdd10).toBe(1794);
    expect(station.designConditionsSourceWmo).toBeNull();
    expect(station.url).toContain('USA_IL_Chicago.OHare.Intl.AP.725300_TMYx.2004-2018.zip');
  });

  it('skips sentinel placemarks with no download URL', () => {
    const stations = parseKml(kmlDocument(SENTINEL_PLACEMARK, OHARE_PLACEMARK));
    expect(stations).toHaveLength(1);
    expect(stations[0]?.wmo).toBe('725300');
  });

  it('returns an empty array for a document with no placemarks', () => {
    expect(parseKml(kmlDocument())).toEqual([]);
  });
});

describe('parseUrlMetadata', () => {
  it('splits a country/state/city/wmo URL', () => {
    expect(
      parseUrlMetadata('https://x/USA_IL_Chicago.OHare.Intl.AP.725300_TMYx.2009-2023.zip')
    ).toEqual(['USA', 'IL', 'Chicago.OHare.Intl.AP', '725300']);
  });

  it('handles a stateless country/city/wmo URL', () => {
    expect(parseUrlMetadata('https://x/GBR_London.Heathrow.AP.037720_TMYx.zip')).toEqual([
      'GBR',
      '',
      'London.Heathrow.AP',
      '037720',
    ]);
  });
});
