// Preamble, not shown on the page: the values this example assumes it already
// has, each with the type the page's earlier steps would have given it.
import type { Schema } from '@idfkit/core';
import { parseIdf } from '@idfkit/core';
declare const schema: Schema;
declare const text: string;

// --8<-- [start:example]
const { document } = parseIdf(text, schema, { preserveFormatting: true });
// --8<-- [end:example]

void document;
