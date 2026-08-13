# How to collect diagnostics instead of throwing

By default parsing is strict: the first problem throws an `IdfParseError` and
nothing is returned. That is right for a script, where a bad file should stop the
run. It is wrong for an editor, a language server, or a batch job over a
directory of models, all of which need to keep going and report everything.

## Turn strict off

```ts
import { parseIdf } from '@idfkit/core';

const { document, diagnostics } = parseIdf(text, schema, { strict: false });

for (const d of diagnostics) {
  console.warn(`${d.line}: ${d.message}`);
}
```

You get a document either way. With `strict: false` it is the best
reconstruction the parser could manage, and `diagnostics` says what it could not
make sense of.

A `ParseDiagnostic` carries `message`, `line`, and — when the parser knew which
object it was inside — `typeName`.

## Stream them instead of collecting

For a large batch, `onDiagnostic` fires as each problem is found, so you do not
hold every diagnostic for every file in memory at once:

```ts
parseIdf(text, schema, {
  strict: false,
  onDiagnostic: (d) => report(file, d.line, d.message),
});
```

The callback fires in addition to the array being populated, not instead of it.

## From a file, in Node

`loadIdf` discards diagnostics because it returns the document directly. Use
`loadIdfWithDiagnostics` when you want both:

```ts
import { loadIdfWithDiagnostics } from '@idfkit/core/node';

const { document, diagnostics } = await loadIdfWithDiagnostics('model.idf', {
  strict: false,
});
```

## Catching the strict error

When strict mode is what you want, `IdfParseError` carries `line` and — where the
parser knew it — `typeName`, so you can still point at the problem. The message
already includes the line number:

```ts
import { IdfParseError, parseIdf } from '@idfkit/core';

try {
  parseIdf(text, schema);
} catch (error) {
  if (error instanceof IdfParseError) {
    console.error(`line ${error.line} (${error.typeName ?? 'unknown type'}): ${error.message}`);
  }
  throw error;
}
```

## What is not covered

Diagnostics are parse-time only: unknown object types, malformed values, fields
that do not fit their declared kind. They are not schema validation — required
fields, ranges, and choice lists are not checked, and a model that parses
without a single diagnostic can still be rejected by EnergyPlus. Validation is
[deliberately absent for now](../explanation/parity.md).

Reference integrity is separate again, and is available on the document:

```ts
for (const edge of document.danglingReferences()) {
  console.warn(`${edge.field} points at missing "${edge.target}"`);
}
```
