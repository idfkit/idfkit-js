import type { IdfDocument } from '@idfkit/core';
import { writeIdf } from '@idfkit/core';
declare const document: IdfDocument;

// --8<-- [start:example]
// Refused: reproducing the original text and laying it out differently are
// contradictory requests, so one of them has to be dropped and neither should
// be dropped in silence.
try {
  writeIdf(document, { preserveFormatting: true, indent: '  ' });
} catch (error) {
  (error as TypeError).message;
  // preserveFormatting reproduces the original text, so it cannot also apply
  // indent, commentColumn, ordering or versionFirst. Pass one or the other.
}

// Granted: a different output FORM is a different artifact, which the original
// text was never going to express.
writeIdf(document, { preserveFormatting: true, compressed: true });
// --8<-- [end:example]
