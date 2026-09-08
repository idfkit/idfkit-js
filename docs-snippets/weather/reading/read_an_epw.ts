// Preamble, not shown on the page: the EPW text the page's earlier step retrieved.
import { parseEpw } from '@idfkit/weather';
declare const epwText: string;

// --8<-- [start:example]
// Reading takes the text you already hold. No network, no filesystem, nothing
// asynchronous, so this runs in a browser tab as readily as in Node.
const epw = parseEpw(epwText);

epw.location.city; // 'Chicago Ohare Intl Ap'
epw.hours.rowCount; // 8760, taken from the file's declared data period

// Every numeric field is a named column, packed and the same length.
const temperature = epw.hours.dryBulbTemperature; // Float64Array, degrees C
temperature[0]; // the first hour of 1 January

// The hour column runs 1 to 24, and hour 24 is the last hour of its OWN day
// rather than hour 0 of the next.
epw.hours.hour[23]; // 24
epw.hours.day[23]; // still 1
// --8<-- [end:example]

export { epw, temperature };
