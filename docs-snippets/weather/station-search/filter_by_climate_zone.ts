// Preamble, not shown on the page: the index the page's earlier steps produced.
import type { StationIndex } from '@idfkit/weather';
declare const index: StationIndex;

// --8<-- [start:example]
// Ask for a zone by its code. The code is parsed out of the label rather than
// read off the front of it, which matters: 2,162 of the 69,638 bundled records
// are labelled '7A - ASHRAE Climate Zone could not be determined' or '8A - ...',
// and neither 7A nor 8A is an ASHRAE zone, since zones 7 and 8 carry no suffix.
const zone4a = index.filter({ climateZone: '4A' });

// Combine with the other keys, which all narrow together.
const seattleArea = index.filter({ climateZone: '4C', country: 'USA', state: 'WA' });

// The stations whose zone upstream could not determine are reachable, and only
// this way: no climateZone value returns them. Asking for them is a separate
// question because the zone key's domain is already every real code, so a
// reserved string could not be told apart from one.
const undetermined = index.filter({ climateZoneDetermined: false });
// --8<-- [end:example]

export { zone4a, seattleArea, undetermined };
