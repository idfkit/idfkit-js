# How to parse in the browser

The parser itself needs nothing special: `@idfkit/core` has no I/O and no
`node:*` imports, so a bundler pulls in the parser and nothing else. The only
question is where the schema comes from.

## Serve the bundle

Copy the data directory to a path your server serves:

```bash
cp -r node_modules/@idfkit/schemas/data public/schemas
```

Then point `httpSource` at it:

```ts
import { parseIdf, SchemaBundle, httpSource } from '@idfkit/core';

const bundle = new SchemaBundle(httpSource('/schemas/'));
const schema = await bundle.load('26.1.0');

const { document } = parseIdf(idfText, schema);
```

`httpSource` fetches the gzipped files and inflates them with
`DecompressionStream`, so the payload stays around 1 MB for all 17 versions and
does not depend on your server setting `Content-Encoding`.

Hold the `SchemaBundle` for the lifetime of the page. It caches by version,
shares one blob store across versions, and collapses concurrent loads of the
same version into a single fetch.

## Do not put the bundle behind a bundler import

It is tempting to `import schemas from '@idfkit/schemas/data/index.json'` and let
the bundler inline it. Do not: the manifests and blob store are megabytes of
JSON, and inlining them puts all 17 versions into the initial bundle whether or
not the user opens a file.

If you would rather not serve static files at all, supply your own
`BundleSource` backed by dynamic `import()`:

```ts
import { SchemaBundle, type BundleSource } from '@idfkit/core';

const source: BundleSource = {
  async read(fileName) {
    return (await import(`./schemas/${fileName}.json`)).default;
  },
};

const bundle = new SchemaBundle(source);
```

That keeps each manifest in its own chunk, fetched on demand.

## Reading a file the user picked

`File.text()` decodes as UTF-8, which is wrong for IDF often enough to matter:
real models carry single high bytes in degree signs and accented station names.
Decode as latin-1, the way `loadIdf` does on the server:

```ts
const buffer = await file.arrayBuffer();
const text = new TextDecoder('latin1').decode(buffer);
```

Reading it as UTF-8 turns those bytes into U+FFFD, and they will still be U+FFFD
when you write the model back out.

## Getting the version right

A file states its own version, and it usually states two components where the
schema keys have three. Resolve rather than assume — see
[How to handle a version you do not know ahead of
time](handle-unknown-versions.md).

## Parsing off the main thread

Nothing here needs the DOM, so a worker works unchanged:

```ts
// worker.ts
import { parseIdf, writeIdf, SchemaBundle, httpSource } from '@idfkit/core';

const bundle = new SchemaBundle(httpSource('/schemas/'));

self.onmessage = async ({ data }) => {
  const schema = await bundle.load(data.version);
  const { document } = parseIdf(data.text, schema);
  self.postMessage({ objects: document.size, idf: writeIdf(document) });
};
```

Documents themselves are not structured-cloneable — they hold prototypes and a
live reference graph — so pass text across the boundary in both directions.
