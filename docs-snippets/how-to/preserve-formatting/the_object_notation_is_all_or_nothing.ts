import type { Schema } from '@idfkit/core';
import { parseEpJson, writeEpJson } from '@idfkit/core';
declare const schema: Schema;
declare const text: string;

// --8<-- [start:example]
const { document } = parseEpJson(text, schema, { preserveFormatting: true });

writeEpJson(document) === text; // true, while nothing has changed

document.remove(document.require('Zone', 'Perimeter_ZN_1'));

// Any change at all falls the WHOLE document back to ordinary formatted output.
// The object notation has no statements, so there is nothing to anchor one
// object's own characters to and no way to reproduce one while reformatting
// another.
writeEpJson(document) === text; // false
// --8<-- [end:example]
