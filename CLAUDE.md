# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**idfkit-js** is the JavaScript/TypeScript sibling of the Python
[idfkit](https://github.com/idfkit/idfkit): EnergyPlus IDF and epJSON parsing and
manipulation. It is a deliberate re-design for JavaScript, not a transliteration.

**Node:** 20+ | **License:** MIT | **Package manager:** npm workspaces

| Package            | npm name          | Purpose                                           |
| ------------------ | ----------------- | ------------------------------------------------- |
| `packages/core`    | `@idfkit/core`    | Parser, object model, reference graph, writers    |
| `packages/schemas` | `@idfkit/schemas` | Content-addressed epJSON schemas, all 17 versions |

Related: [`@idfkit/engine`](https://www.npmjs.com/package/@idfkit/engine) runs
EnergyPlus in the browser via WASM. This repo handles the model, that one the
simulation. Do not add simulation execution here.

The two meet over IDF text: `writeIdf(document)` goes into `ep.run({ idf, epw })`,
and results come back in the engine's own shapes, never through this library. The
README's "Running a simulation" section is the documented contract; keep it in
sync if the write path changes. Note `idfkit-engine` is a private repo, so link to
npm rather than GitHub in anything public.

## Common Commands

```bash
npm install
npm test                                     # vitest, all packages
npx vitest run packages/core/tests/parse.test.ts   # single file
npx tsc -p tsconfig.test.json                # typecheck sources AND tests
npx tsc --build                              # build to dist/
npm run format:check                         # prettier
npm run build:schemas                        # regenerate the schema bundle
npm run codegen -w @idfkit/core -- 26.1.0    # regenerate TypeScript interfaces
```

**Before proposing changes:** `npm run format:check && npx tsc -p tsconfig.test.json && npm test`

`npx tsc -p tsconfig.test.json` is not optional. Vitest transpiles without
typechecking, so the `@ts-expect-error` assertions in `packages/core/tests/typed.test.ts`
(which prove the generated types actually reject bad input) mean nothing unless
`tsc` runs. A change that silently breaks the type map will pass `npm test`.

## Architecture

### Core object model

- **`IDFDocument<M>`** — collections by type, live reference graph, bound to one
  EnergyPlus version. `M` is an optional generated type map (see below).
- **`IdfObject`** — one EnergyPlus object. Fields are real accessors on a
  per-type prototype, built in `shape.ts`.
- **`IdfCollection`** — name-indexed, insertion-ordered, case-insensitive lookup.
- **`ReferenceGraph`** — every name-to-name edge, kept current on add, remove,
  rename, and field write.
- **`Schema` / `SchemaBundle`** (`@idfkit/schemas`) — lazily hydrated,
  content-addressed schema definitions.

### Load-bearing design decisions

Read these before changing the relevant file; each was chosen over an obvious
alternative for a reason that is not visible from the code alone.

1. **Sync pure core, async edge.** Everything in `@idfkit/core` is synchronous
   and takes strings. All I/O is in `@idfkit/core/node` or `SchemaBundle`. Do
   not make a core function async, and do not import `node:*` outside `node.ts`.

2. **Real accessors, never a `Proxy`** (`shape.ts`). Proxies defeat V8 inline
   caches and are invisible to TypeScript. One prototype per object type, with
   `Object.defineProperty` accessors, shared by every instance. The setter is
   what keeps the reference graph live.

3. **Generated static types** (`scripts/emit-types.mjs`, `typemap.ts`). The
   `TypeMap` must be emitted as a `type` alias, not an `interface`: interfaces
   have no implicit index signature and cannot satisfy `Record<string, object>`.
   `add()` takes `ValuesOf` (exact interface, so typos are caught) while `all()`
   returns `ObjectOf` — keeping these separate is what preserves both
   excess-property checking and version-generic usage.

4. **Content-addressed schemas.** 87% of object-type definitions are identical
   across versions. Definitions are frozen and shared by identity, so `Zone` in
   9.4.0 and 26.1.0 are the same object and share one prototype. Hashes come
   from a canonical serialization and must stay stable across rebuilds.

5. **epJSON field names verbatim.** `zone_name`, not a converted form. There is
   no name-conversion layer, deliberately.

### Positional format hazards

IDF is positional, and two rules exist because violating them corrupts models
silently rather than failing:

- Trailing unset fields may be trimmed **only** when no extensible group
  follows. Otherwise every group value lands one slot early.
- A blank name is not the same as no name. Types like
  `WeatherProperty:SkyTemperature` have an optional name that still occupies a
  field slot. `IdfObject` tracks `name` (as written) separately from `key` (its
  collection slot) for exactly this.

## Testing

Tests live in `packages/*/tests/` and run against TypeScript source via aliases
in `vitest.config.ts`, so there is no build step between editing and testing.

The real conformance suite is `roundtrip.test.ts`, which parses, writes, and
re-parses the EnergyPlus example files and requires deep equality. It skips
cleanly when no EnergyPlus install is present, and CI installs one so it always
runs somewhere. Every bug fixed so far came from that loop rather than from
writing a test first; when you fix one, add a case to `regressions.test.ts`.

`readme.test.ts` executes the published README snippets verbatim. If you change
a documented API, that test should fail. Fix the README, not the test.

## Version Support

EnergyPlus 8.9.0 through 26.1.0, all shipped together. IDF files write
`Version, 9.0;` while schemas are keyed `9.0.1`, so `resolveVersion` matches on
major.minor and takes the newest patch. It returns `undefined` rather than
guessing when there is no match: loading the wrong schema mis-maps every
positional field instead of failing.

## Parity with Python idfkit

Not implemented here: simulation, weather, geometry, schedules, thermal
properties, full validation, formatting-preserving round-trip (needs a CST).

Two implementations of a schema-driven format will drift silently. A shared
conformance suite (fixture IDFs plus expected canonical epJSON and diagnostics,
run by both CI pipelines) is the mitigation and does not exist yet. If you are
adding a feature that also exists in the Python library, check its behaviour
rather than inventing one.
