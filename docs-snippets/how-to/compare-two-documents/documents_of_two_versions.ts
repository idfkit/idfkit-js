// Preamble, not shown on the page: the values this example assumes it already
// has, each with the type the page's earlier steps would have given it.
import type { IdfDocument } from '@idfkit/core';
declare const before: IdfDocument;
declare const after: IdfDocument;

// --8<-- [start:example]
import { diffDocuments, IncomparableVersionsError } from '@idfkit/core';

try {
  diffDocuments(before, after);
} catch (error) {
  if (error instanceof IncomparableVersionsError) {
    console.error(`One document targets ${error.before}, the other ${error.after}.`);
  } else {
    throw error;
  }
}
// --8<-- [end:example]
