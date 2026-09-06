import type { IdfDocument } from '@idfkit/core';
declare const document: IdfDocument;
declare const warn: (message: string) => void;

// --8<-- [start:example]
if (document.rawText === undefined) {
  warn('This file was read without preserveFormatting, so saving will reformat it.');
}
// --8<-- [end:example]
