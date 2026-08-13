/**
 * Parse a climate.onebuilding.org KML index into weather stations.
 *
 * This is the runtime half of index building: {@link refreshStationIndex} feeds
 * fetched KML text straight through here. The offline bundler in
 * `scripts/build-index.mjs` mirrors this file field-for-field; keep the two
 * regex sets in step, and lean on `tests/kml.test.ts`, which runs this parser
 * against a real placemark and checks every derived field.
 *
 * No XML parser is used. The upstream descriptions are already a small HTML
 * table inside a CDATA block, and the Python library reaches for regex over a
 * DOM for the same reason: it keeps the parser dependency-free and portable to
 * a worker or an edge runtime where no `DOMParser` exists.
 */

import { WeatherStation } from './station.js';

/** Strip HTML tags. Replaced with nothing, matching the Python `_TAG_RE`. */
const TAG_RE = /<[^>]+>/g;

/**
 * Field extractors, run against the tag-stripped description. The `<tr>`/`<td>`
 * whitespace survives tag stripping, so per-row keys stay newline-separated.
 */
const PATTERNS = {
  dataSource: /Data Source\s+([A-Za-z0-9._-]+)/,
  elevation: /Elevation\s+([-\d.]+)\s*m/,
  timezone: /Time Zone\s*\{?\s*GMT\s+([-+\d.]+)\s*hours?\s*\}?/,
  climateZone: /ASHRAE\s+HOF\s+\d+\s+Climate\s+Zone\s+([^\n]+)/,
  heatingDbC: /99%\s+Heating\s+DB\s+([-\d.]+)\s*C/,
  coolingDbC: /1%\s+Cooling\s+DB\s+([-\d.]+)\s*C/,
  hdd18: /HDD18\s+(\d+)/,
  cdd10: /CDD10\s+(\d+)/,
  url: /(https?:\/\/\S+?\.zip)/,
  alternateWmo: /Design\s+conditions\s+from\s+alternate\s+WMO\s+(\d+)/,
} as const;

/**
 * Extract `[country, state, city, wmo]` from a download URL.
 *
 * @example
 * `USA_IL_Chicago.OHare.Intl.AP.725300_TMYx.2009-2023.zip`
 *   → `["USA", "IL", "Chicago.OHare.Intl.AP", "725300"]`
 * `GBR_London.Heathrow.AP.037720_TMYx.zip`
 *   → `["GBR", "", "London.Heathrow.AP", "037720"]`
 */
export function parseUrlMetadata(url: string): [string, string, string, string] {
  const filename = url.split('/').pop() ?? '';
  const stem = filename.replace(/\.zip$/, '');
  const parts = stem.split('_');
  if (parts.length === 0 || parts[0] === undefined) return ['', '', '', ''];
  const country = parts[0];

  // A 1-3 letter alpha segment right after the country is the state, but only
  // when there are 4+ segments (country, state, city.WMO, variant). With three
  // (country, city.WMO, variant) there is no state.
  let state = '';
  let cityIdx = 1;
  if (parts.length >= 4 && parts[1] !== undefined && /^[A-Za-z]{1,3}$/.test(parts[1])) {
    state = parts[1];
    cityIdx = 2;
  }

  const cityWithWmo = parts[cityIdx];
  if (cityWithWmo === undefined) return [country, state, '', ''];

  const dot = cityWithWmo.lastIndexOf('.');
  if (dot !== -1) {
    const tail = cityWithWmo.slice(dot + 1);
    if (tail.length > 0 && /^\d+$/.test(tail)) {
      return [country, state, cityWithWmo.slice(0, dot), tail];
    }
  }
  return [country, state, cityWithWmo, ''];
}

/**
 * Parse one `<Placemark>` body. Returns `undefined` for sentinel placemarks
 * (region labels with no download URL), and throws when a real station is
 * missing a required climate field — the surprise surfaces at build time
 * rather than at search time.
 */
function parsePlacemark(block: string, sourceName: string): WeatherStation | undefined {
  const descMatch = /<description>([\s\S]*?)<\/description>/.exec(block);
  const coordsMatch = /<coordinates>([\s\S]*?)<\/coordinates>/.exec(block);
  if (descMatch?.[1] === undefined || coordsMatch?.[1] === undefined) return undefined;

  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(descMatch[1]);
  const description = cdata?.[1] ?? descMatch[1];
  const plain = description.replace(TAG_RE, '');

  const urlMatch = PATTERNS.url.exec(plain);
  if (urlMatch?.[1] === undefined) return undefined;
  const url = urlMatch[1];

  const coordsParts = coordsMatch[1].trim().split(',');
  if (coordsParts.length < 2 || coordsParts[0] === undefined || coordsParts[1] === undefined) {
    return undefined;
  }
  const longitude = Number(coordsParts[0]);
  const latitude = Number(coordsParts[1]);

  const nameMatch = /<name>([\s\S]*?)<\/name>/.exec(block);
  const placemarkName = nameMatch?.[1]?.trim() ?? '?';

  const required = (key: keyof typeof PATTERNS): string => {
    const m = PATTERNS[key].exec(plain);
    if (m?.[1] === undefined) {
      throw new Error(
        `Placemark ${JSON.stringify(placemarkName)} in ${sourceName} is missing required field ${JSON.stringify(key)}`
      );
    }
    return m[1];
  };

  const climateZone = required('climateZone').trim();
  const heatingDbC = Number(required('heatingDbC'));
  const coolingDbC = Number(required('coolingDbC'));
  const hdd18 = parseInt(required('hdd18'), 10);
  const cdd10 = parseInt(required('cdd10'), 10);

  const elevMatch = PATTERNS.elevation.exec(plain);
  const elevation = elevMatch?.[1] !== undefined ? Number(elevMatch[1]) : 0.0;

  const tzMatch = PATTERNS.timezone.exec(plain);
  const timezone = tzMatch?.[1] !== undefined ? Number(tzMatch[1]) : 0.0;

  const sourceMatch = PATTERNS.dataSource.exec(plain);
  const source = sourceMatch?.[1] ?? '';

  const altMatch = PATTERNS.alternateWmo.exec(plain);
  const alternateWmo = altMatch?.[1] ?? null;

  const [country, state, city, wmo] = parseUrlMetadata(url);

  return new WeatherStation({
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
    ashraeClimateZone: climateZone,
    heatingDesignDbC: heatingDbC,
    coolingDesignDbC: coolingDbC,
    hdd18,
    cdd10,
    designConditionsSourceWmo: alternateWmo,
  });
}

/**
 * Parse an entire KML index file into stations.
 *
 * @param text - The decoded KML document.
 * @param sourceName - A label used in error messages (typically the filename).
 */
export function parseKml(text: string, sourceName = 'KML'): WeatherStation[] {
  const stations: WeatherStation[] = [];
  const re = /<Placemark>([\s\S]*?)<\/Placemark>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] === undefined) continue;
    const station = parsePlacemark(m[1], sourceName);
    if (station !== undefined) stations.push(station);
  }
  return stations;
}
