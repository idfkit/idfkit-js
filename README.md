<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/idfkit/idfkit-brand/identity-2026.5/marks/mark-on-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/idfkit/idfkit-brand/identity-2026.5/marks/mark-on-light.svg">
    <img alt="idfkit" width="72" src="https://raw.githubusercontent.com/idfkit/idfkit-brand/identity-2026.5/marks/tile.png">
  </picture>
</p>

# idfkit-js

EnergyPlus IDF and epJSON parsing and manipulation for JavaScript and TypeScript.

[idfkit](https://idfkit.com) · [Developers](https://developers.idfkit.com) · [EnergyPlus docs](https://docs.idfkit.com) · [Envelop](https://app.idfkit.com) · [MCP](https://mcp.idfkit.com) · [Shoebox](https://shoebox.idfkit.com) · [GitHub](https://github.com/idfkit)

[![Release](https://img.shields.io/github/v/release/idfkit/idfkit-js?filter=v*)](https://github.com/idfkit/idfkit-js/releases) [![Build status](https://img.shields.io/github/actions/workflow/status/idfkit/idfkit-js/main.yml?branch=main)](https://github.com/idfkit/idfkit-js/actions/workflows/main.yml?query=branch%3Amain) [![codecov](https://codecov.io/gh/idfkit/idfkit-js/branch/main/graph/badge.svg)](https://codecov.io/gh/idfkit/idfkit-js) [![License](https://img.shields.io/github/license/idfkit/idfkit-js)](https://github.com/idfkit/idfkit-js/blob/main/LICENSE) [![Capability parity](https://img.shields.io/badge/capability-parity-informational)](https://developers.idfkit.com/explanation/parity/)

EnergyPlus IDF and epJSON tooling for JavaScript and TypeScript. A sibling to the
Python [idfkit](https://github.com/idfkit/idfkit), not a transliteration of it.

**[Documentation](https://developers.idfkit.com/)** ·
[Tutorial](https://developers.idfkit.com/tutorials/first-model/) ·
[How-to guides](https://developers.idfkit.com/how-to/) ·
[API reference](https://developers.idfkit.com/reference/)

> Documentation source lives in
> [idfkit/idfkit-developers](https://github.com/idfkit/idfkit-developers), not here. This
> repository publishes the TypeScript examples and the TypeDoc reference to it as a pinned
> `docs-YYYY.N` release; see CONTRIBUTING.md. The `docs/` tree and `mkdocs.yml` that remain
> here are the sources of the retired `js.idfkit.com` site, which CI still builds but no
> longer deploys.

One site teaches both languages. `js.idfkit.com` is retired and redirects there.

| Package                | What it is                                                                                           | npm                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/core`        | Parsing, the object model, references, writers                                                       | [`@idfkit/core`](https://www.npmjs.com/package/@idfkit/core)               |
| `packages/schemas`     | Content-addressed epJSON schemas, all 18 versions                                                    | [`@idfkit/schemas`](https://www.npmjs.com/package/@idfkit/schemas)         |
| `packages/weather`     | TMYx station index and browser EPW retrieval                                                         | [`@idfkit/weather`](https://www.npmjs.com/package/@idfkit/weather)         |
| `packages/language`    | The opt-in IDF language service                                                                      | [`@idfkit/language`](https://www.npmjs.com/package/@idfkit/language)       |
| `packages/geometry`    | Read-only geometry extraction: vectors, polygons, a model's resolved scene                           | [`@idfkit/geometry`](https://www.npmjs.com/package/@idfkit/geometry)       |
| `packages/types-v26-2` | Generated interfaces and `TypeMap` for EnergyPlus 26.2.0                                             | [`@idfkit/types-v26-2`](https://www.npmjs.com/package/@idfkit/types-v26-2) |
| `packages/types-v26-1` | Generated interfaces and `TypeMap` for EnergyPlus 26.1.0                                             | [`@idfkit/types-v26-1`](https://www.npmjs.com/package/@idfkit/types-v26-1) |
| `packages/types-v9-4`  | Generated interfaces and `TypeMap` for EnergyPlus 9.4.0                                              | [`@idfkit/types-v9-4`](https://www.npmjs.com/package/@idfkit/types-v9-4)   |
| `packages/idfkit`      | The shared install name: re-exports of core, schemas, and the optional weather and language packages | [`@idfkit/idfkit`](https://www.npmjs.com/package/@idfkit/idfkit)           |

It sits alongside [`@idfkit/engine`](https://www.npmjs.com/package/@idfkit/engine),
which runs EnergyPlus itself in the browser via WebAssembly. This repository
handles the model; that one handles the simulation. See
[How to run a simulation in the browser](https://developers.idfkit.com/how-to/run-a-simulation-in-the-browser/)
for how the two fit together.

> [!NOTE]
> **Release 0.2.0 renamed four exports and moved the generated types out of
> `@idfkit/core`.**
>
> | Before                                              | After                                                |
> | --------------------------------------------------- | ---------------------------------------------------- |
> | `IDFDocument`                                       | `IdfDocument`                                        |
> | `detectVersion(text)`                               | `getIdfVersion(text)`                                |
> | `detectEpJsonVersion(text)`                         | `getEpJsonVersion(text)`                             |
> | `doc.collection(type)`                              | `doc.all(type)`                                      |
> | `import type { TypeMap } from '@idfkit/core/types'` | `import type { TypeMap } from '@idfkit/types-v26-1'` |
>
> Every one is a build-time failure naming the file and line, in plain JavaScript
> as well as TypeScript, so nothing here reaches runtime. Full notes are in the
> [changelog's migration section](CHANGELOG.md#migration).

> **Status: beta.** The latest release is 0.4.0. The API is not yet stable.
>
> All fourteen first-tier capabilities exist here. Twelve are complete: parsing,
> writing, the object model, references, schema access, validation,
> introspection, documentation addresses, generated object types, parse
> diagnostics, the conformance declaration, and geocoding. Two are partial, by
> decision rather than as a gap to close: the weather station index and weather
> file retrieval, which differ from Python in how they are installed and what
> they return. Of the second-tier capabilities, the formatting-preserving
> round-trip and EPW reading are complete here and geometry extraction is
> partial; the remaining seven, and all four third-tier capabilities, are
> Python-only for now. Five further capabilities are permanently Python-only,
> and two, browser simulation and the IDF language service, are permanently
> TypeScript-only.
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
2.5 to 2.8 MB of declarations per EnergyPlus version to parse a file. Everything
below works without them, untyped.

```bash
npm install --save-dev @idfkit/types-v26-1
```

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
const [best] = index.search('chicago ohare');
if (!best) throw new Error('No station matches "chicago ohare".');
const epw = await fetchEpw(best.station);
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
| [Static types generated from the schema](https://developers.idfkit.com/explanation/generated-types/)   | 815 to 880 interfaces per version, so a misspelled field is a compile error.                     |
| [Content-addressed schemas](https://developers.idfkit.com/explanation/content-addressed-schemas/)      | All 18 versions in 1.4 MB gzipped instead of 12.6 MB.                                            |
| [epJSON field names verbatim](https://developers.idfkit.com/explanation/epjson-field-names/)           | `zone_name`. No name-conversion layer to get wrong.                                              |

## Correctness

The conformance suite is the EnergyPlus example set, not hand-written fixtures.
Every file is parsed, written, and re-parsed, and the two documents must be
deeply equal. The figures below were recorded in the initial commit (fb8d91a,
2026-08-12) and have not been re-measured since.

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
