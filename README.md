# idfkit-js

EnergyPlus IDF and epJSON tooling for JavaScript and TypeScript. A sibling to the
Python [idfkit](https://github.com/idfkit/idfkit), not a transliteration of it.

| Package            | What it is                                        | npm                                                                |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/core`    | Parsing, the object model, references, writers    | [`@idfkit/core`](https://www.npmjs.com/package/@idfkit/core)       |
| `packages/schemas` | Content-addressed epJSON schemas, all 17 versions | [`@idfkit/schemas`](https://www.npmjs.com/package/@idfkit/schemas) |

It sits alongside [`@idfkit/engine`](https://www.npmjs.com/package/@idfkit/engine),
which runs EnergyPlus itself in the browser via WebAssembly. This repository
handles the model; that one handles the simulation. See
[Running a simulation](#running-a-simulation) for how the two fit together.

> **Status: prototype.** The core is complete and tested against the full
> EnergyPlus example set, but nothing has been published and the API is not yet
> stable. See [Parity with Python idfkit](#parity-with-python-idfkit) for what is
> deliberately missing.

## Install

```bash
npm install @idfkit/core @idfkit/schemas
```

## Quickstart

```ts
import { loadIdf, saveIdf } from '@idfkit/core/node';
import type { TypeMap } from '@idfkit/core/types/v26-1';

const doc = await loadIdf<TypeMap>('model.idf');

for (const zone of doc.all('Zone')) {
  console.log(zone.name, zone.ceiling_height); // typed, autocompleted
}

// Renaming rewrites every reference to the old name.
doc.require('Zone', 'SPACE1-1').name = 'Open Office';

await saveIdf(doc, 'model-renamed.idf');
```

In a browser, load the schema yourself and keep the parse synchronous:

```ts
import { parseIdf, SchemaBundle, httpSource } from '@idfkit/core';

const bundle = new SchemaBundle(httpSource('/schemas/'));
const schema = await bundle.load('26.1.0');
const { document } = parseIdf(idfText, schema);
```

## Running a simulation

This repository stops at the model. To simulate one, hand the IDF text to
[`@idfkit/engine`](https://www.npmjs.com/package/@idfkit/engine), which runs
EnergyPlus in the browser via WebAssembly. The seam between the two libraries is
plain IDF text, which is the practical payoff of keeping this core synchronous
and string-based.

```bash
npm install @idfkit/core @idfkit/schemas @idfkit/engine @idfkit/engine-assets
npx idfkit-engine-assets public/energyplus   # copy the WASM engine to your own origin
```

```ts
import { parseIdf, writeIdf, SchemaBundle, httpSource } from '@idfkit/core';
import { createEnergyPlus } from '@idfkit/engine';

// 1. Edit the model here.
const schema = await new SchemaBundle(httpSource('/schemas/')).load('26.1.0');
const { document } = parseIdf(idfText, schema);
document.require('Zone', 'SPACE1-1').ceiling_height = 3;

// 2. Hand it over as IDF text. Loading compiles a ~28 MB binary, so create the
//    engine once and reuse it across runs.
const ep = await createEnergyPlus({ assetBaseUrl: '/energyplus' });
const result = await ep.run({ idf: writeIdf(document), epw: epwText });

// 3. A failed run is data, not an exception: the err report is worth reading.
if (result.success) {
  console.log(result.eso?.variables.size, 'output variables');
} else {
  console.error(result.fatalError, result.err?.entries);
}
ep.dispose();
```

Three things worth knowing at the boundary:

**Keep the versions aligned.** `@idfkit/engine-assets` is versioned by the
EnergyPlus release it carries, so `@idfkit/engine-assets@26.1.0` is EnergyPlus
26.1.0, whereas a document here can be any of the 17 supported versions. Load the
schema that matches the asset package you installed. Nothing checks this for you,
and a mismatch means the engine reads a model written for a different release.

**`HVACTemplate:*` objects need no special handling.** `run()` expands them with
the bundled ExpandObjects preprocessor before simulating. Call `expandObjects`
from `@idfkit/engine` yourself only when you want the expanded IDF back, and if
you do, `parseIdf` will read it straight into a document.

**Results do not come back through this library.** The engine returns its own
parsed `err`, `eso`, and `mtr` structures, along with raw `sql` and `html`.
idfkit-js has no output-reading API and is not planning one; re-parsing expanded
IDF is the only return path that involves it.

## Design notes

Five properties are worth knowing before you build on this. Each one is visible
in how the API behaves, so they are easier to work with than to discover.

### 1. The core is synchronous and pure; I/O lives at the edges

`parseIdf`, `writeIdf`, and everything on `IDFDocument` are synchronous and take
strings. Reading files is in `@idfkit/core/node`; fetching schemas is in
`SchemaBundle`. So the same core runs unchanged in Node, a browser, a worker, and
an edge runtime, and browser bundles never pull in `node:fs`.

Loading a schema is the one genuinely asynchronous step, and it is explicit
rather than hidden inside `parse`.

### 2. Field access uses real accessors, not a `Proxy`

`zone.ceiling_height` is a real property, not a `Proxy` trap. That is what lets
an editor autocomplete it and keeps reads on V8's fast path; a `Proxy` would give
you neither, since proxies defeat inline caches and are invisible to TypeScript.

Each object type gets one prototype carrying `Object.defineProperty` accessors,
built once and shared by every instance. Reads are ordinary monomorphic lookups,
and writes route through a setter that keeps the reference graph live. That
setter is why assigning a name propagates to every reference without you calling
an explicit `update()`.

### 3. Static types are generated from the schema

`scripts/emit-types.mjs` turns a version's epJSON schema into TypeScript
interfaces plus a `TypeMap`. Parameterizing a document with that map gives:

```ts
const doc = await loadIdf<TypeMap>('model.idf');

doc.all('Zone'); // completes among 858 type names
doc.add('Zone', 'Z1', { celing_height: 3 }); // compile error: typo
doc.add('BuildingSurface:Detailed', 'S1', { sun_exposure: 'Sunny' }); // compile error
```

The map is a type, so it is erased at build time. A typed document and an untyped
one are the same object graph at runtime.

So a misspelled field name is a build error rather than something you find at
simulation time, which is the practical reason to pass the `TypeMap` even in a
codebase that is otherwise loosely typed. The Python library has no equivalent:
there, the same typo surfaces as a `None`.

### 4. All 17 versions ship together, content-addressed

87% of object-type definitions are byte-identical across EnergyPlus releases:
`Zone` has not changed since 8.9. The bundle therefore stores each unique
definition once and gives every version a manifest of `typeName -> hash`.

|                                          | All 17 versions, gzipped |
| ---------------------------------------- | ------------------------ |
| Raw epJSON schemas, as Python ships them | 11,915 KB                |
| Slimmed (documentation metadata dropped) | 2,922 KB                 |
| Content-addressed                        | **~1,000 KB**            |

Two consequences beyond size. Loading a second version only pays for the
definitions it does not already share with one in memory. And a cross-version
diff is a manifest comparison rather than a deep diff of two 10 MB documents:

```ts
const delta = (await bundle.load('26.1.0')).changedFrom(await bundle.load('9.4.0'));
// { added: [...], removed: [...], changed: [...] }
```

Because definitions are shared by identity, `Zone` in 9.4.0 and `Zone` in 26.1.0
are the same frozen object, so they share one prototype. Mixed-version work stays
monomorphic for free.

### 5. epJSON field names are used verbatim

Fields are `zone_name` and `outside_boundary_condition`, not the Python library's
converted names. epJSON names are already valid JS identifiers and valid
TypeScript interface keys, so the on-disk name, the runtime key, and the static
type all agree. There is no name-conversion layer to get wrong.

## Correctness

The real conformance suite is the EnergyPlus example set, not hand-written
fixtures. Every file is parsed, written, and re-parsed, and the two documents must
be deeply equal.

```
files          760
clean          760
parse issues   0
roundtrip diff 0
objects        290,313
throughput     ~36k objects/sec (parse + write + re-parse)
```

IDF is a positional format, so its edge cases corrupt a model quietly rather than
failing: a trimmed empty field shifts an entire extensible group, and a blank name
is not the same as no name. Every such case the example set has surfaced is pinned
in `packages/core/tests/regressions.test.ts`.

## Development

```bash
npm install
npm run build:schemas   # regenerate the bundle from idfkit's epJSON schemas
npm run codegen -w @idfkit/core -- 26.1.0   # regenerate TypeScript interfaces
npm test
npx tsc -p tsconfig.test.json   # typecheck sources AND tests
```

Run the typecheck separately: vitest transpiles without checking types, so the
`@ts-expect-error` assertions that prove the generated types actually reject bad
input are only enforced by `tsc`.

## Parity with Python idfkit

Present:

| Area                       | Notes                                                  |
| -------------------------- | ------------------------------------------------------ |
| IDF parse and write        | Full example-set conformance                           |
| epJSON parse and write     | Round-trips against IDF                                |
| Object model               | Typed accessors, collections, clone, extensible groups |
| Reference graph            | Live, with rename propagation and dangling detection   |
| All 17 EnergyPlus versions | 8.9.0 through 26.1.0                                   |
| Generated static types     | Per version                                            |

Deliberately absent, with reasons:

| Area                         | Why                                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Simulation                   | [`@idfkit/engine`](https://www.npmjs.com/package/@idfkit/engine) already runs EnergyPlus in the browser via WASM, and [pairs with this library](#running-a-simulation) over IDF text. Shelling out to a local install would duplicate it for the smaller audience. |
| Weather                      | Station index and EPW download want a service or a separate package, not the core.                                                                                                                                                                                 |
| Geometry, schedules, thermal | Pure math, ports cleanly, simply not written yet.                                                                                                                                                                                                                  |
| Validation                   | Beyond parse-time checks; the schema data needed for it is already in the bundle.                                                                                                                                                                                  |
| Formatting round-trip        | Requires a concrete syntax tree. `3.0` currently comes back as `3`: semantically identical, textually different.                                                                                                                                                   |

### The drift problem

Two implementations of a schema-driven format will diverge, and the divergence is
silent because each side passes its own tests. The mitigation that works is a
shared conformance suite: fixture IDFs with expected canonical epJSON output and
expected diagnostics, versioned independently and run by both CI pipelines. That
does not exist yet and should be built before the two implementations are used in
anger together.

## License

MIT
