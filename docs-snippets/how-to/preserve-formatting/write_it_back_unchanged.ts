import type { IdfDocument } from '@idfkit/core';
import { writeIdf } from '@idfkit/core';
declare const document: IdfDocument;
declare const text: string;

// --8<-- [start:example]
writeIdf(document) === text; // true
// --8<-- [end:example]
