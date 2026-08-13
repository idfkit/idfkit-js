# A synchronous core with async edges

`parseIdf`, `writeIdf`, and every method on `IDFDocument` are synchronous and
take strings. None of them can read a file, fetch a URL, or return a promise.
Everything that touches a disk or a network lives in one of two places:
`@idfkit/core/node`, or `SchemaBundle`.

## Why not just accept a path

Because a function that can read a file has to be async, and async is
load-bearing in a way that spreads. If `parseIdf` returned a promise, every
caller of it would return a promise, and so would every caller of those. A pure
transformation of text to a data structure would be modelled as an I/O
operation for the whole call graph, on the strength of one convenience.

The convenience is also small. `await readFile(path)` is one line, and
`@idfkit/core/node` supplies `loadIdf` for the common case anyway.

## What it buys

**The same core runs everywhere.** Node, a browser, a web worker, an edge
runtime. Not "in principle" — there is no environment detection, no conditional
import, no polyfill. The portable entry point cannot import `node:*`, so a
browser bundle physically cannot pull in `node:fs`.

**Bundles stay small.** A bundler tracing `@idfkit/core` finds no I/O, so there
is nothing to shim and nothing to exclude.

**Testing is trivial.** Parser tests pass strings. There are no fixtures on disk
to keep in sync, no temp directories, no cleanup.

**The seam with other tools is text.** `writeIdf(document)` produces a string, and
[`@idfkit/engine`](https://www.npmjs.com/package/@idfkit/engine) takes a string.
Neither library has to know anything about the other's object model. That is the
practical payoff, and it is why the [simulation
handoff](../how-to/run-a-simulation.md) is as short as it is.

## The one asynchronous step

Loading a schema. A schema has to come from somewhere — the package's own data
directory, an HTTP fetch, a bundler-driven `import()` — and there is no way to
make that synchronous in a browser.

So it is explicit rather than hidden:

```ts
const bundle = new SchemaBundle(httpSource('/schemas/'));
const schema = await bundle.load('26.1.0'); // the async part, once
const { document } = parseIdf(idfText, schema); // sync from here on
```

Hold one `SchemaBundle` for the lifetime of the process. It caches by version,
shares one blob store across versions, and de-duplicates concurrent loads of the
same version into a single fetch, so calling `load` freely is fine.

The alternative — an async `parseIdf` that loads the schema itself — would hide
the one genuine I/O operation inside the one function that has no other reason
to be async, and would do it once per parse instead of once per process.
