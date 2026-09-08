// Preamble, not shown on the page: a weather file the page's earlier step read.
import { monthlyMeans, type WeatherFile } from '@idfkit/weather';
declare const epw: WeatherFile;

// --8<-- [start:example]
// A measurement the file says was not taken is absent, not the number the format
// reserves for it. Absence is NaN: no weather file can express one, so it is not
// a value the column could otherwise have held.
const albedo = epw.hours.albedo;
Number.isNaN(albedo[0]); // true where the file wrote its missing value

// How many hours of a column are present is carried rather than recomputed.
epw.hours.presentCount.albedo;

// A monthly mean excludes the absent hours from the sum AND from the divisor, so
// it is the mean of the values that exist. The count says how many that was.
const january = monthlyMeans(epw, 'dryBulbTemperature')[0]!;
january.mean; // NaN when the month held no measurement at all
january.count; // and 0 beside it, which says why
// --8<-- [end:example]

export { albedo, january };
