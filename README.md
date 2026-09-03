# idfkit-js

EnergyPlus IDF and epJSON tooling for JavaScript and TypeScript. A sibling to the
Python [idfkit](https://github.com/idfkit/idfkit), not a transliteration of it.

**[Documentation](https://developers.idfkit.com/)** ·
[Tutorial](https://developers.idfkit.com/tutorials/first-model/) ·
[How-to guides](https://developers.idfkit.com/how-to/) ·
[API reference](https://developers.idfkit.com/reference/)

One site teaches both languages. `js.idfkit.com` is retired and redirects there.

| Package            | What it is                                        | npm                                                                |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/core`    | Parsing, the object model, references, writers    | [`@idfkit/core`](https://www.npmjs.com/package/@idfkit/core)       |
| `packages/schemas` | Content-addressed epJSON schemas, all 17 versions | [`@idfkit/schemas`](https://www.npmjs.com/package/@idfkit/schemas) |
| `packages/weather` | TMYx station index and browser EPW retrieval      | [`@idfkit/weather`](https://www.npmjs.com/package/@idfkit/weather) |

It sits alongside [`@idfkit/engine`](https://www.npmjs.com/package/@idfkit/engine),
which runs EnergyPlus itself in the browser via WebAssembly. This repository
handles the model; that one handles the simulation. See
[How to run a simulation in the browser](https://developers.idfkit.com/how-to/run-a-simulation-in-the-browser/)
for how the two fit together.

> **Status: beta, and first-tier only.** `@idfkit/core`, `@idfkit/schemas` and
> `@idfkit/weather` are published at 0.1.0. The API is not yet stable.
>
> All thirteen first-tier capabilities exist here: parsing, the object model,
> references, writers, schema access, validation, introspection, documentation
> addresses, generated object types, parse diagnostics, the weather station
> index, weather file retrieval, and geocoding. Second- and third-tier
> capabilities are Python-only for now, and a few are permanently so.
>
> That is a real difference between the two libraries and not a rounding error,
> so read [Capability
> parity](https://developers.idfkit.com/explanation/parity/) before assuming an
> operation you know from Python exists here. It lists every capability, its
> state in each language, and whether an absence is temporary or permanent.

## Install

```bash
npm install @idfkit/core @idfkit/schemas
```

Static per-version field types are opt-in and installed by name, so nobody pays
5.3 MB of declarations to parse a file. Everything below works without them,
untyped.

```bash
npm install --save-dev @idfkit/types-v26-1
```

> The type packages are built and gated but not yet on the registry, so that
> install fails today. Drop the `TypeMap` import from the quickstart until they
> publish; the runtime behaviour is identical either way.

## Quickstart

```ts
import { loadIdf, saveIdf } from '@idfkit/core/node';
import type { TypeMap } from '@idfkit/types-v26-1';

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

Need a weather file too? [`@idfkit/weather`](https://www.npmjs.com/package/@idfkit/weather)
searches the climate.onebuilding.org TMYx station index and pulls EPW files
browser-side:

```ts
import { loadStationIndex, fetchEpw } from '@idfkit/weather';

const index = await loadStationIndex('/stations.json.gz');
const epw = await fetchEpw(index.search('chicago ohare')[0].station);
```

See [Download weather
files](https://developers.idfkit.com/weather/downloads/).

New to the library? [Build your first
model](https://developers.idfkit.com/tutorials/first-model/) goes from nothing
to a model on disk in about fifteen minutes.

## Why it is built this way

Five decisions shape the API, each chosen over an obvious alternative:

| Decision                                                                                               | In short                                                                                         |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [A synchronous core with async edges](https://developers.idfkit.com/explanation/sync-core-async-edge/) | The same core runs in Node, a browser, a worker, and an edge runtime.                            |
| [Real accessors, not a `Proxy`](https://developers.idfkit.com/explanation/accessors-not-proxies/)      | Editors can see the fields, V8 can optimize them, and the setter keeps the reference graph live. |
| [Static types generated from the schema](https://developers.idfkit.com/explanation/generated-types/)   | 858 interfaces per version, so a misspelled field is a compile error.                            |
| [Content-addressed schemas](https://developers.idfkit.com/explanation/content-addressed-schemas/)      | All 17 versions in ~1 MB gzipped instead of 11.9 MB.                                             |
| [epJSON field names verbatim](https://developers.idfkit.com/explanation/epjson-field-names/)           | `zone_name`. No name-conversion layer to get wrong.                                              |

## Correctness

The conformance suite is the EnergyPlus example set, not hand-written fixtures.
Every file is parsed, written, and re-parsed, and the two documents must be
deeply equal.

```
files          760
clean          760
parse issues   0
roundtrip diff 0
objects        290,313
throughput     ~36k objects/sec (parse + write + re-parse)
```

IDF is a positional format, so its edge cases corrupt a model quietly rather than
failing. Every such case the example set has surfaced is pinned in
`packages/core/tests/regressions.test.ts`. See [How conformance is
established](https://developers.idfkit.com/explanation/conformance/).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

```bash
npm install
npm run format:check && npx tsc -p tsconfig.test.json && npm test
```

## License

MIT
