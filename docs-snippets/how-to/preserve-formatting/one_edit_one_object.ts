import type { IdfDocument } from '@idfkit/core';
import { writeIdf } from '@idfkit/core';
declare const document: IdfDocument;

// --8<-- [start:example]
document.require('Zone', 'Perimeter_ZN_1').set('ceiling_height', 3.2);

// Every other object comes back from the characters it was read from, and so
// does every comment, blank line and line ending between them.
const written = writeIdf(document);
// --8<-- [end:example]

void written;
