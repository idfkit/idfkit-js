#!/usr/bin/env node
/**
 * Build the bundled weather-station index from climate.onebuilding.org.
 *
 * Downloads the ten regional TMYx KML index files, parses every `<Placemark>`
 * into a station record, and writes the whole set to `data/stations.json.gz`.
 * The output is the same gzip-compressed JSON shape the Python idfkit library
 * ships, so the two bundles are interchangeable:
 *
 *     { "built_at": iso8601,
 *       "last_modified": { "<kml file>": "<http date>" },
 *       "stations": [ { "country": ..., "wmo": ..., ... }, ... ] }
 *
 * The parsing here mirrors `src/kml.ts` field-for-field. That file is the
 * runtime parser (it powers `refreshStationIndex` in the browser); this script
 * is the offline bundler. Keep the two regex sets in sync — a test in
 * `tests/kml.test.ts` guards the runtime one against a real KML fixture.
 *
 * Usage: node scripts/build-index.mjs
 *   IDFKIT_WEATHER_BASE_URL   override the sources base (default upstream)
 */

import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'data', 'stations.json.gz');

const BASE_URL = process.env.IDFKIT_WEATHER_BASE_URL ?? 'https://climate.onebuilding.org/sources';
const USER_AGENT = 'idfkit-js (https://github.com/idfkit/idfkit-js)';

const INDEX_FILES = [
  'Region1_Africa_TMYx_EPW_Processing_locations.kml',
  'Region2_Asia_TMYx_EPW_Processing_locations.kml',
  'Region2_Region6_Russia_TMYx_EPW_Processing_locations.kml',
  'Region3_South_America_TMYx_EPW_Processing_locations.kml',
  'Region4_USA_TMYx_EPW_Processing_locations.kml',
  'Region4_Canada_TMYx_EPW_Processing_locations.kml',
  'Region4_NA_CA_Caribbean_TMYx_EPW_Processing_locations.kml',
  'Region5_Southwest_Pacific_TMYx_EPW_Processing_locations.kml',
  'Region6_Europe_TMYx_EPW_Processing_locations.kml',
  'Region7_Antarctica_TMYx_EPW_Processing_locations.kml',
];

const TAG_RE = /<[^>]+>/g;
const KML_PATTERNS = {
  data_source: /Data Source\s+([A-Za-z0-9._-]+)/,
  elevation: /Elevation\s+([-\d.]+)\s*m/,
  timezone: /Time Zone\s*\{?\s*GMT\s+([-+\d.]+)\s*hours?\s*\}?/,
  climate_zone: /ASHRAE\s+HOF\s+\d+\s+Climate\s+Zone\s+([^\n]+)/,
  heating_db_c: /99%\s+Heating\s+DB\s+([-\d.]+)\s*C/,
  cooling_db_c: /1%\s+Cooling\s+DB\s+([-\d.]+)\s*C/,
  hdd18: /HDD18\s+(\d+)/,
  cdd10: /CDD10\s+(\d+)/,
  url: /(https?:\/\/\S+?\.zip)/,
  alternate_wmo: /Design\s+conditions\s+from\s+alternate\s+WMO\s+(\d+)/,
};

/** Extract `[country, state, city, wmo]` from a ZIP download URL. */
function parseUrlMetadata(url) {
  const filename = url.split('/').pop() ?? '';
  const stem = filename.replace(/\.zip$/, '');
  const parts = stem.split('_');
  if (parts.length === 0) return ['', '', '', ''];
  const country = parts[0];

  let state = '';
  let cityIdx = 1;
  if (parts.length >= 4 && /^[A-Za-z]{1,3}$/.test(parts[1])) {
    state = parts[1];
    cityIdx = 2;
  }
  if (cityIdx >= parts.length) return [country, state, '', ''];

  const cityWithWmo = parts[cityIdx];
  const dot = cityWithWmo.lastIndexOf('.');
  if (dot !== -1) {
    const tail = cityWithWmo.slice(dot + 1);
    if (tail.length > 0 && /^\d+$/.test(tail)) {
      return [country, state, cityWithWmo.slice(0, dot), tail];
    }
  }
  return [country, state, cityWithWmo, ''];
}

function parsePlacemark(block, sourceFilename) {
  const descMatch = /<description>([\s\S]*?)<\/description>/.exec(block);
  const coordsMatch = /<coordinates>([\s\S]*?)<\/coordinates>/.exec(block);
  if (!descMatch || !coordsMatch) return null;

  let description = descMatch[1];
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(description);
  if (cdata) description = cdata[1];
  const plain = description.replace(TAG_RE, '');

  const urlMatch = KML_PATTERNS.url.exec(plain);
  if (!urlMatch) return null;
  const url = urlMatch[1];

  const coordsParts = coordsMatch[1].trim().split(',');
  if (coordsParts.length < 2) return null;
  const longitude = Number(coordsParts[0]);
  const latitude = Number(coordsParts[1]);

  const nameMatch = /<name>([\s\S]*?)<\/name>/.exec(block);
  const placemarkName = nameMatch ? nameMatch[1].trim() : '?';

  const required = (key) => {
    const m = KML_PATTERNS[key].exec(plain);
    if (!m) {
      throw new Error(
        `Placemark ${JSON.stringify(placemarkName)} in ${sourceFilename} is missing required field ${JSON.stringify(key)}`
      );
    }
    return m[1];
  };

  const climateZone = required('climate_zone').trim();
  const heatingDbC = Number(required('heating_db_c'));
  const coolingDbC = Number(required('cooling_db_c'));
  const hdd18 = parseInt(required('hdd18'), 10);
  const cdd10 = parseInt(required('cdd10'), 10);

  const elevMatch = KML_PATTERNS.elevation.exec(plain);
  const elevation = elevMatch ? Number(elevMatch[1]) : 0.0;

  const tzMatch = KML_PATTERNS.timezone.exec(plain);
  const timezone = tzMatch ? Number(tzMatch[1]) : 0.0;

  const sourceMatch = KML_PATTERNS.data_source.exec(plain);
  const source = sourceMatch ? sourceMatch[1] : '';

  const altMatch = KML_PATTERNS.alternate_wmo.exec(plain);
  const alternateWmo = altMatch ? altMatch[1] : null;

  const [country, state, city, wmo] = parseUrlMetadata(url);

  return {
    country,
    state,
    city,
    wmo,
    source,
    latitude,
    longitude,
    timezone,
    elevation,
    url,
    ashrae_climate_zone: climateZone,
    heating_design_db_c: heatingDbC,
    cooling_design_db_c: coolingDbC,
    hdd18,
    cdd10,
    design_conditions_source_wmo: alternateWmo,
  };
}

function parseKml(text, sourceFilename) {
  const stations = [];
  const re = /<Placemark>([\s\S]*?)<\/Placemark>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const station = parsePlacemark(m[1], sourceFilename);
    if (station !== null) stations.push(station);
  }
  return stations;
}

async function fetchKml(filename) {
  const url = `${BASE_URL}/${filename}`;
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!resp.ok) {
    throw new Error(`Failed to download ${filename}: ${resp.status} ${resp.statusText}`);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  // Decode UTF-8 tolerantly: KMLs declare UTF-8 but carry stray Latin-1 bytes.
  const text = new TextDecoder('utf-8').decode(bytes);
  const lastModified = resp.headers.get('last-modified');
  return { text, lastModified };
}

async function main() {
  const allStations = [];
  const lastModified = {};
  for (const filename of INDEX_FILES) {
    process.stdout.write(`  ${filename} ... `);
    const { text, lastModified: lm } = await fetchKml(filename);
    if (lm) lastModified[filename] = lm;
    const stations = parseKml(text, filename);
    allStations.push(...stations);
    process.stdout.write(`${stations.length} stations\n`);
  }

  const data = {
    built_at: new Date().toISOString(),
    last_modified: lastModified,
    stations: allStations,
  };
  const json = JSON.stringify(data);
  const gz = gzipSync(Buffer.from(json, 'utf-8'), { level: 9 });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, gz);

  console.log(`\nWrote ${allStations.length} stations to ${OUT}`);
  console.log(`  raw JSON: ${(json.length / 1e6).toFixed(2)} MB`);
  console.log(`  gzipped:  ${(gz.length / 1e6).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
