// Preamble, not shown on the page: the values this example assumes it already
// has, each with the type the page's earlier steps would have given it.
import { writeIdf, type IdfDocument } from '@idfkit/core';
declare const model: IdfDocument;

// --8<-- [start:controls]
// Every control, at a value that is not the default.
const text = writeIdf(model, {
  indent: '  ',
  commentColumn: 45,
  comments: true,
});
// --8<-- [end:controls]

// --8<-- [start:compressed]
const compact = writeIdf(model, { compressed: true });
// --8<-- [end:compressed]

void text;
void compact;
