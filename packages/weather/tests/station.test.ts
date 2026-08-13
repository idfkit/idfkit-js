import { describe, expect, it } from 'vitest';

import { WeatherStation } from '@idfkit/weather';

import { makeStation } from './helpers.js';

describe('WeatherStation', () => {
  it('cleans up the display name and keeps location context', () => {
    expect(makeStation().displayName).toBe('Chicago OHare Intl AP, IL, USA');
  });

  it('drops the state from the display name when absent', () => {
    const s = makeStation({ state: '', city: 'London.Heathrow.AP', country: 'GBR' });
    expect(s.displayName).toBe('London Heathrow AP, GBR');
  });

  it('derives the filename stem and dataset variant from the URL', () => {
    const s = makeStation();
    expect(s.filenameStem).toBe('USA_IL_Chicago.OHare.Intl.AP.725300_TMYx.2009-2023');
    expect(s.datasetVariant).toBe('TMYx.2009-2023');
  });

  it('handles a bare TMYx variant', () => {
    const s = makeStation({
      url: 'https://example.org/GBR_London.Heathrow.AP.037720_TMYx.zip',
    });
    expect(s.datasetVariant).toBe('TMYx');
  });

  it('converts design temperatures to Fahrenheit', () => {
    const s = makeStation({ heatingDesignDbC: -15.3, coolingDesignDbC: 31.5 });
    expect(s.heatingDesignDbF).toBeCloseTo(4.46, 2);
    expect(s.coolingDesignDbF).toBeCloseTo(88.7, 2);
  });

  it('round-trips through the snake_case wire form', () => {
    const s = makeStation({ designConditionsSourceWmo: '725340' });
    const record = s.toJSON();
    expect(record.ashrae_climate_zone).toBe('5A - Cool - Humid');
    expect(record.design_conditions_source_wmo).toBe('725340');

    const back = WeatherStation.fromJSON(record);
    expect(back).toEqual(s);
  });

  it('preserves leading zeros in the WMO number', () => {
    const record = makeStation({ wmo: '037720' }).toJSON();
    expect(record.wmo).toBe('037720');
    expect(WeatherStation.fromJSON(record).wmo).toBe('037720');
  });

  it('is frozen', () => {
    const s = makeStation();
    expect(Object.isFrozen(s)).toBe(true);
  });
});
