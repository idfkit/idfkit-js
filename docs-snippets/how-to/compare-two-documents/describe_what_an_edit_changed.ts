// Preamble, not shown on the page: the values this example assumes it already
// has, each with the type the page's earlier steps would have given it.
import type { Schema } from '@idfkit/core';
declare const schema: Schema;
declare const oldText: string;
declare const newText: string;

// --8<-- [start:example]
import { diffDocuments, parseIdf } from '@idfkit/core';

const before = parseIdf(oldText, schema).document;
const after = parseIdf(newText, schema).document;

for (const entry of diffDocuments(before, after).objects) {
  switch (entry.kind) {
    case 'added':
    case 'removed':
      console.log(`${entry.kind} ${entry.type} '${entry.name}'`);
      break;
    case 'renamed':
      console.log(
        `renamed ${entry.type} '${entry.from}' to '${entry.to}', ` +
          `updating ${entry.references.length} references`
      );
      break;
    case 'changed':
      for (const change of entry.fields) {
        if (change.kind === 'field') {
          console.log(
            `${entry.type} '${entry.name}' ${change.field}: ${change.before} -> ${change.after}`
          );
        }
      }
      break;
  }
}
// --8<-- [end:example]
