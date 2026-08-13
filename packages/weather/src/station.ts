/**
 * The weather-station data model and search-result shapes.
 *
 * A {@link WeatherStation} is one downloadable weather dataset from
 * climate.onebuilding.org. The same physical station appears more than once
 * when it has several TMYx year-range variants (`TMYx.2007-2021` vs
 * `TMYx.2009-2023`), each a separate entry with its own download URL.
 */

/**
 * The wire form of a station: the exact keys stored in `stations.json.gz`.
 *
 * Snake-case on purpose. This is the serialized shape the Python idfkit library
 * ships, so the two bundles are byte-for-byte interchangeable and a `refresh()`
 * on either side produces a file the other can read. The camelCase API lives on
 * the {@link WeatherStation} class; the conversion is confined to
 * {@link WeatherStation.fromJSON} and {@link WeatherStation.toJSON}.
 */
export interface StationRecord {
  country: string;
  state: string;
  city: string;
  wmo: string;
  source: string;
  latitude: number;
  longitude: number;
  timezone: number;
  elevation: number;
  url: string;
  ashrae_climate_zone: string;
  heating_design_db_c: number;
  cooling_design_db_c: number;
  hdd18: number;
  cdd10: number;
  design_conditions_source_wmo: string | null;
}

/** The fields a {@link WeatherStation} is built from. */
export interface WeatherStationFields {
  /** ISO 3166 country code, e.g. `"USA"`. */
  country: string;
  /** State or province abbreviation, e.g. `"IL"`. Empty when the index has none. */
  state: string;
  /** City or station name as indexed, e.g. `"Chicago.OHare.Intl.AP"`. */
  city: string;
  /** WMO station number, kept as a string so leading zeros survive. */
  wmo: string;
  /** Dataset source identifier, e.g. `"TMYx.2009-2023"` or `"Custom-725300"`. */
  source: string;
  /** Decimal degrees, north positive. */
  latitude: number;
  /** Decimal degrees, east positive. */
  longitude: number;
  /** Hours offset from GMT, e.g. `-6`. */
  timezone: number;
  /** Metres above sea level. */
  elevation: number;
  /** Full download URL for the ZIP archive. */
  url: string;
  /** ASHRAE HOF climate-zone label, e.g. `"5A - Cool - Humid"`. */
  ashraeClimateZone: string;
  /** 99% heating design dry-bulb temperature, °C. */
  heatingDesignDbC: number;
  /** 1% cooling design dry-bulb temperature, °C. */
  coolingDesignDbC: number;
  /** Heating degree-days, base 18 °C. */
  hdd18: number;
  /** Cooling degree-days, base 10 °C. */
  cdd10: number;
  /**
   * When a station borrows design conditions from a neighbour, that
   * neighbour's WMO number; otherwise `null`.
   */
  designConditionsSourceWmo?: string | null;
}

/**
 * Metadata for a single weather-file entry from climate.onebuilding.org.
 *
 * Instances are immutable: every field is read-only, and the computed
 * properties are derived from the download URL. Construct one directly for a
 * test, or let {@link StationIndex} hand them to you from the bundled index.
 */
export class WeatherStation implements Readonly<Required<WeatherStationFields>> {
  readonly country: string;
  readonly state: string;
  readonly city: string;
  readonly wmo: string;
  readonly source: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly timezone: number;
  readonly elevation: number;
  readonly url: string;
  readonly ashraeClimateZone: string;
  readonly heatingDesignDbC: number;
  readonly coolingDesignDbC: number;
  readonly hdd18: number;
  readonly cdd10: number;
  readonly designConditionsSourceWmo: string | null;

  constructor(fields: WeatherStationFields) {
    this.country = fields.country;
    this.state = fields.state;
    this.city = fields.city;
    this.wmo = fields.wmo;
    this.source = fields.source;
    this.latitude = fields.latitude;
    this.longitude = fields.longitude;
    this.timezone = fields.timezone;
    this.elevation = fields.elevation;
    this.url = fields.url;
    this.ashraeClimateZone = fields.ashraeClimateZone;
    this.heatingDesignDbC = fields.heatingDesignDbC;
    this.coolingDesignDbC = fields.coolingDesignDbC;
    this.hdd18 = fields.hdd18;
    this.cdd10 = fields.cdd10;
    this.designConditionsSourceWmo = fields.designConditionsSourceWmo ?? null;
    Object.freeze(this);
  }

  /**
   * A human-readable name with location context, e.g.
   * `"Chicago OHare Intl AP, IL, USA"`. Dots and dashes in the city name
   * become spaces.
   */
  get displayName(): string {
    const name = this.city.replace(/[.-]/g, ' ').trim();
    const parts: string[] = [];
    if (name) parts.push(name);
    if (this.state) parts.push(this.state);
    parts.push(this.country);
    return parts.join(', ');
  }

  /**
   * The canonical filename stem: the ZIP name without its `.zip` extension,
   * e.g. `"USA_IL_Chicago.OHare.Intl.AP.725300_TMYx.2009-2023"`.
   */
  get filenameStem(): string {
    const filename = this.url.split('/').pop() ?? '';
    return filename.replace(/\.zip$/, '');
  }

  /**
   * The TMYx dataset variant taken from the URL, e.g. `"TMYx"` or
   * `"TMYx.2004-2018"` — everything after the last underscore in the stem.
   */
  get datasetVariant(): string {
    const stem = this.filenameStem;
    const cut = stem.lastIndexOf('_');
    return cut === -1 ? stem : stem.slice(cut + 1);
  }

  /** 99% heating design dry-bulb temperature, °F. */
  get heatingDesignDbF(): number {
    return (this.heatingDesignDbC * 9) / 5 + 32;
  }

  /** 1% cooling design dry-bulb temperature, °F. */
  get coolingDesignDbF(): number {
    return (this.coolingDesignDbC * 9) / 5 + 32;
  }

  /** Serialize to the snake-case {@link StationRecord} wire form. */
  toJSON(): StationRecord {
    return {
      country: this.country,
      state: this.state,
      city: this.city,
      wmo: this.wmo,
      source: this.source,
      latitude: this.latitude,
      longitude: this.longitude,
      timezone: this.timezone,
      elevation: this.elevation,
      url: this.url,
      ashrae_climate_zone: this.ashraeClimateZone,
      heating_design_db_c: this.heatingDesignDbC,
      cooling_design_db_c: this.coolingDesignDbC,
      hdd18: this.hdd18,
      cdd10: this.cdd10,
      design_conditions_source_wmo: this.designConditionsSourceWmo,
    };
  }

  /**
   * Build a station from the snake-case wire form.
   *
   * Required climate fields are read directly so a stale or corrupt payload
   * fails loudly rather than silently producing `NaN`s;
   * `design_conditions_source_wmo` is genuinely optional.
   */
  static fromJSON(record: StationRecord): WeatherStation {
    const sourceWmo = record.design_conditions_source_wmo;
    return new WeatherStation({
      country: String(record.country),
      state: String(record.state),
      city: String(record.city),
      wmo: String(record.wmo),
      source: String(record.source),
      latitude: Number(record.latitude),
      longitude: Number(record.longitude),
      timezone: Number(record.timezone),
      elevation: Number(record.elevation),
      url: String(record.url),
      ashraeClimateZone: String(record.ashrae_climate_zone),
      heatingDesignDbC: Number(record.heating_design_db_c),
      coolingDesignDbC: Number(record.cooling_design_db_c),
      hdd18: Number(record.hdd18),
      cdd10: Number(record.cdd10),
      designConditionsSourceWmo: sourceWmo == null ? null : String(sourceWmo),
    });
  }
}

/** Which field a text search matched on. */
export type MatchField = 'wmo' | 'name' | 'state' | 'country' | 'filename' | '';

/** A text-search hit with a relevance score. */
export interface SearchResult {
  station: WeatherStation;
  /** Relevance from 0 to 1, higher is better. */
  score: number;
  /** The field that matched. */
  matchField: MatchField;
}

/** A spatial-proximity hit with great-circle distance. */
export interface SpatialResult {
  station: WeatherStation;
  /** Great-circle distance in kilometres. */
  distanceKm: number;
}
