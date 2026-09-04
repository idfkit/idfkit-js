// Preamble, not shown on the page: the values this example assumes it already
// has, each with the type the page's earlier steps would have given it.
import { lineColumnAt, scanIdf } from '@idfkit/core';
import type { IdfDocument, ProsePool, Schema } from '@idfkit/core';
import { completionsAt, contextAt, declarationAt, explainAt, findingsIn } from '@idfkit/language';
declare const text: string;
declare const schema: Schema;
declare const model: IdfDocument;
declare const prose: ProsePool;
declare const offset: number;

// --8<-- [start:cursor]
const context = contextAt(text, offset, schema);
context.at; // 'typeName' | 'field' | 'comment' | 'betweenStatements'
context.typeName; // 'BuildingSurface:Detailed', when the schema defines the written type
context.fieldIndex; // which field, counted the way the schema counts them
// --8<-- [end:cursor]

// --8<-- [start:completions]
const completions = completionsAt(text, offset, schema, { document: model, prose });
if (completions.status === 'ok') {
  for (const offer of completions.offers) {
    offer.value; // the text to insert
    offer.replaces; // the characters it stands in for
    offer.required; // whether the schema marks the field required
  }
}
// 'unconstrained', 'noSchema', 'unknownType' and 'notApplicable' are the other
// four states, and each is a different thing to tell the reader.
// --8<-- [end:completions]

// --8<-- [start:meaning]
const meaning = explainAt(text, offset, schema, prose);
if (meaning.status === 'ok') {
  meaning.explanation.prose; // the schema's own words, or undefined where it carries none
  meaning.explanation.field; // type, units, range, default, permitted values
  meaning.explanation.docs; // where the EnergyPlus manual documents it
  meaning.explanation.region; // the characters to highlight while it is shown
}

const declaration = declarationAt(text, offset, schema, model);
if (declaration.status === 'ok') {
  for (const declared of declaration.declarations) {
    declared.region; // where the name under the cursor is declared
    declared.typeName; // the type that declares it
  }
}
// --8<-- [end:meaning]

// --8<-- [start:findings]
const layer = scanIdf(text);
for (const finding of findingsIn(text, schema)) {
  const { line, column } = lineColumnAt(layer, finding.region.start);
  finding.precision; // 'field' when the region is the offending value itself
  console.log(`${line}:${column} ${finding.message}`);
}
// --8<-- [end:findings]
