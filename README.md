# idfkit-js

EnergyPlus IDF and epJSON tooling for JavaScript and TypeScript. A sibling to the
Python [idfkit](https://github.com/idfkit/idfkit), not a transliteration of it.

| Package            | What it is                                        | npm                                                                |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/core`    | Parsing, the object model, references, writers    | [`@idfkit/core`](https://www.npmjs.com/package/@idfkit/core)       |
| `packages/schemas` | Content-addressed epJSON schemas, all 17 versions | [`@idfkit/schemas`](https://www.npmjs.com/package/@idfkit/schemas) |

It sits alongside [`@idfkit/engine`](https://github.com/idfkit/idfkit-engine),
which runs EnergyPlus itself in the browser via WebAssembly. This repository
handles the model; that one handles the simulation.

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

## Design notes

Five decisions distinguish this from a direct port. Each is a place where doing
the JavaScript-native thing produces a better library than imitating the Python
one would have.

### 1. The core is synchronous and pure; I/O lives at the edges

`parseIdf`, `writeIdf`, and everything on `IDFDocument` are synchronous and take
strings. Reading files is in `@idfkit/core/node`; fetching schemas is in
`SchemaBundle`. So the same core runs unchanged in Node, a browser, a worker, and
an edge runtime, and browser bundles never pull in `node:fs`.

Loading a schema is the one genuinely asynchronous step, and it is explicit
rather than hidden inside `parse`.

### 2. Field access uses real accessors, not a `Proxy`

Python resolves `zone.ceiling_height` through `__getattr__`. The mechanical
translation is a `Proxy`, which we do not use: proxies defeat V8's inline caches,
and they are invisible to TypeScript, so nothing would autocomplete.

Instead each object type gets one prototype carrying `Object.defineProperty`
accessors, built once and shared by every instance. Property reads are ordinary
monomorphic lookups, and writes route through a setter that keeps the reference
graph live, which is what makes rename propagation work without asking callers to
mutate through an explicit `update()` call.

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

This has no Python counterpart, and it is the main reason to do this in
TypeScript rather than treat JavaScript as a lesser target. In Python a
misspelled field surfaces as `None` at simulation time; here it does not compile.

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

Four bugs came out of that loop rather than from writing tests first, and each has
a regression test in `packages/core/tests/regressions.test.ts`:

- Trailing unset fields were trimmed even when an extensible group followed,
  shifting every component of a `Branch` one slot and silently corrupting HVAC
  topology.
- `WeatherProperty:SkyTemperature` may have a legitimately blank name, which is
  not the same as having no name field.
- Integers are declared two ways in the schema (`"type": "integer"` and
  `"type": "number"` with `data_type`); handling only one left values as strings.
- `-0` in a source file round-tripped to `0`, which is equal but not identical,
  producing phantom diffs.

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

| Area                         | Why                                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simulation                   | [`@idfkit/engine`](https://github.com/idfkit/idfkit-engine) already runs EnergyPlus in the browser via WASM. Shelling out to a local install would duplicate it for the smaller audience. |
| Weather                      | Station index and EPW download want a service or a separate package, not the core.                                                                                                        |
| Geometry, schedules, thermal | Pure math, ports cleanly, simply not written yet.                                                                                                                                         |
| Validation                   | Beyond parse-time checks; the schema data needed for it is already in the bundle.                                                                                                         |
| Formatting round-trip        | Requires a concrete syntax tree. `3.0` currently comes back as `3`: semantically identical, textually different.                                                                          |

### The drift problem

Two implementations of a schema-driven format will diverge, and the divergence is
silent because each side passes its own tests. The mitigation that works is a
shared conformance suite: fixture IDFs with expected canonical epJSON output and
expected diagnostics, versioned independently and run by both CI pipelines. That
does not exist yet and should be built before the two implementations are used in
anger together.

## License

MIT
