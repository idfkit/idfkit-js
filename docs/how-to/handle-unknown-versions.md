# How to handle a version you do not know ahead of time

A viewer, a converter, or anything else that opens files it did not write cannot
hard-code `26.1.0`. Loading the wrong schema does not throw — IDF is positional,
so a field-order difference mis-maps values into neighbouring slots and the parse
"succeeds" with a corrupted model.

## In Node, this is already handled

`loadIdf` reads the version from the file, resolves it against the bundle, and
throws a useful error when there is no match:

```ts
import { loadIdf } from '@idfkit/core/node';

const doc = await loadIdf('whatever.idf');
doc.version; // '9.0.1', say
```

Nothing else is needed. The rest of this page is for when you are parsing text
you obtained some other way.

## Detect, resolve, load

Three steps, because each can fail differently:

```ts
import { getIdfVersion, parseIdf, resolveVersion, SchemaBundle, httpSource } from '@idfkit/core';

const bundle = new SchemaBundle(httpSource('/schemas/'));

const detected = getIdfVersion(text); // '9.0', or undefined
if (detected === undefined) {
  throw new Error('No Version object; ask the user which release this is.');
}

const available = await bundle.versions();
const resolved = resolveVersion(detected, available);
if (resolved === undefined) {
  throw new Error(`EnergyPlus ${detected} is not supported. Available: ${available.join(', ')}`);
}

const { document } = parseIdf(text, await bundle.load(resolved));
```

`resolveVersion` exists because IDF files write `Version, 9.0;` while schemas are
keyed `9.0.1`. It matches on major and minor and takes the newest patch. When
nothing matches it returns `undefined` rather than guessing — see [Supported
versions](../reference/versions.md#matching-a-files-version-to-a-schema).

## In Node, with your own text

`schemaFor` is the same three steps, exported for exactly this case:

```ts
import { parseIdf, getIdfVersion } from '@idfkit/core';
import { schemaFor } from '@idfkit/core/node';

const schema = await schemaFor(getIdfVersion(text));
const { document } = parseIdf(text, schema);
```

## Files with no `Version` object

Fragments, snippets, and hand-written test inputs often have none. Pass `version`
explicitly:

```ts
const doc = await loadIdf('fragment.idf', { version: '26.1.0' });
```

`version` overrides detection entirely, so it also works as a "parse this as if
it were 26.1" escape hatch. Use it knowingly: that is precisely the mis-mapping
the resolution logic exists to prevent.

## epJSON

Same shape, different detector:

```ts
import { getEpJsonVersion, parseEpJson } from '@idfkit/core';

const schema = await schemaFor(getEpJsonVersion(text));
const { document } = parseEpJson(text, schema);
```

Or `loadEpJson(path)` in Node, which does all of it.

## Working across versions in one process

Hold one `SchemaBundle`. Loading a second version pays only for the definitions
it does not already share with the first, and definitions common to both are the
same frozen object — which also means the two versions share one object
prototype. See [Content-addressed
schemas](../explanation/content-addressed-schemas.md).

A document is bound to one version for its lifetime. There is no
version-agnostic mode, because field order and reference lists genuinely differ
between releases.
