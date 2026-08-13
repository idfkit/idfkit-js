import { crc32, deflateRawSync } from 'node:zlib';

import { WeatherStation, type WeatherStationFields } from '@idfkit/weather';

/** A real Chicago O'Hare placemark, verbatim from Region4_USA. Guards the parser. */
export const OHARE_PLACEMARK = `<Placemark>
    <name>Chicago.OHare.Intl.AP IL USA</name>
    <description><![CDATA[<table><tr><td colspan="2"><b>USA IL Chicago.OHare.Intl.AP.725300 TMYx.2004-2018</b></td></tr>
       <tr><td><b>Data Source Custom-725300</td></tr>
       <tr><td>NCEI ISD - #years=[15] Period of Record=2004-2018</td></tr>
       <tr><td>WMO <b>725300</b></td></tr>
       <tr><td><b>N 41&deg; 59.00'   W 87&deg; 54.00'</b></td></tr>
       <tr><td>Elevation <b>202</b> m</td></tr>
       <tr><td>Time Zone {GMT <b>-6.0</b> hours}</td></tr>
       <tr><td>ASHRAE HOF 2025 Climate Zone <b>5A - Cool - Humid</b></td></tr>
       <tr><td>99% Heating DB <b>-15.3 C</b>, <b>4.5 F</b></td></tr>
       <tr><td>1% Cooling DB <b>31.5 C</b>, <b>88.7 F</b></td></tr>
       <tr><td>HDD18 <b>3172</b>, CDD10 <b>1794</b></td></tr>
       <tr><td>URL https://climate.onebuilding.org/WMO_Region_4_North_and_Central_America/USA_United_States_of_America/IL_Illinois/USA_IL_Chicago.OHare.Intl.AP.725300_TMYx.2004-2018.zip</td></tr></table>]]></description>
   <styleUrl>#weatherlocation</styleUrl>
   <Point>
     <altitudeMode>absolute</altitudeMode>
     <coordinates>-87.90000,41.98333,201.8</coordinates>
   </Point>
  </Placemark>`;

/** A sentinel placemark: a region label with no download URL. Must be skipped. */
export const SENTINEL_PLACEMARK = `<Placemark>
    <name>Region 4 USA</name>
    <description><![CDATA[<b>Region 4 North and Central America</b>]]></description>
    <Point><coordinates>-98.0,39.0,0</coordinates></Point>
  </Placemark>`;

/** Wrap placemark bodies in a minimal KML document. */
export function kmlDocument(...placemarks: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
${placemarks.join('\n')}
</Document></kml>`;
}

/** Build a station with sensible defaults, overriding only what a test cares about. */
export function makeStation(overrides: Partial<WeatherStationFields> = {}): WeatherStation {
  return new WeatherStation({
    country: 'USA',
    state: 'IL',
    city: 'Chicago.OHare.Intl.AP',
    wmo: '725300',
    source: 'TMYx.2009-2023',
    latitude: 41.98333,
    longitude: -87.9,
    timezone: -6,
    elevation: 202,
    url: 'https://climate.onebuilding.org/WMO_Region_4_North_and_Central_America/USA_United_States_of_America/IL_Illinois/USA_IL_Chicago.OHare.Intl.AP.725300_TMYx.2009-2023.zip',
    ashraeClimateZone: '5A - Cool - Humid',
    heatingDesignDbC: -15.3,
    coolingDesignDbC: 31.5,
    hdd18: 3172,
    cdd10: 1794,
    ...overrides,
  });
}

/**
 * Build a valid ZIP archive in memory from `{ name -> bytes }`, deflating each
 * member. Enough of the format for {@link unzip} to read it back — the same
 * layout real climate.onebuilding.org archives use.
 */
export function buildZip(entries: Record<string, Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const [name, data] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const compressed = new Uint8Array(deflateRawSync(data));
    const crc = crc32(data) >>> 0;

    const local = new Uint8Array(30 + nameBytes.length + compressed.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 8, true); // method: deflate
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(compressed, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = locals.reduce((n, l) => n + l.length, 0) + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const l of locals) {
    out.set(l, p);
    p += l.length;
  }
  for (const c of centrals) {
    out.set(c, p);
    p += c.length;
  }
  out.set(eocd, p);
  return out;
}
