# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The packages in this repository, `@idfkit/core`, `@idfkit/schemas`, and
`@idfkit/weather`, are versioned and released together.

## [Unreleased]

### Added

- `idfkit` is now the install name in JavaScript, as it already is on PyPI. It
  carries no implementation: it re-exports `@idfkit/core` at `idfkit`, its Node
  edge at `idfkit/node`, `@idfkit/schemas` at `idfkit/schemas`, and
  `@idfkit/weather` at `idfkit/weather`. The scoped packages keep working and are
  not deprecated; the facade exists so a reader can install one name.

  `npm install idfkit` places under 1.5 MB on disk. Weather is an optional peer,
  so it installs no station index and no weather code until you add
  `@idfkit/weather` by name. `@idfkit/engine` is not reachable through this name
  at all and never will be: it carries about 51 MB of WebAssembly and pins one
  EnergyPlus release.

- `@idfkit/types-v26-1` and `@idfkit/types-v9-4`, the per-version object
  interfaces, as opt-in packages. Install one and parameterise a document with
  it (`loadIdf<TypeMap>(...)`) to get the 858 typed object interfaces for that
  EnergyPlus release. Install neither and everything still works, untyped.

- `CONFORMANCE_LEVEL`, exported from `@idfkit/core`, names the cross-language
  conformance corpus level this release is checked against. It is not a version
  number and is not comparable to one: two installed libraries agree about the
  formats when they report the same level, whatever their own versions say.

### Changed

- **Breaking:** the `@idfkit/core/types` subpath is gone. The generated
  per-version object interfaces now ship as the opt-in packages described under
  Added. Replace `import type { TypeMap } from '@idfkit/core/types'` with
  `import type { TypeMap } from '@idfkit/types-v26-1'`, choosing the package for
  the EnergyPlus release you target.

  This is why `@idfkit/core` fell from 6.7 MB unpacked to 286 KB. The two type
  maps were 5.3 MB of it, and every reader paid for both releases whether or not
  they parameterised a single document. They are types only, erased at build
  time, so nothing about runtime behaviour changes either way.

- **Breaking:** `IDFDocument` is now `IdfDocument`. It was the last exported type
  spelling the acronym in full caps, out of step with `IdfObject`,
  `IdfCollection`, and `IdfParseError`, which have always used the `Idf` prefix.

- **Breaking:** `detectVersion()` is now `getIdfVersion()` and
  `detectEpJsonVersion()` is now `getEpJsonVersion()`. Python spells the same
  operation `get_idf_version`, and the shared naming register maps a Python `get_*`
  accessor to a TypeScript `get*` accessor, as it already does for
  `get_surface_coords` and `getSurfaceCoords`. The two libraries now name this
  operation the same way. No alias is kept: a second public name for one concept is
  what the register exists to prevent.

- **Breaking:** `IdfDocument.collection()` is no longer part of the published
  surface. Use `all()`, which returns the same collection and is the name the
  register carries. `collection()` remains inside the package for the parsers, so
  behaviour is unchanged; it is simply no longer importable.

- **Breaking:** `IdfCollection.insert()`, `delete()`, and `rekey()` are no longer
  importable. All three were already tagged `@internal`, but no tsconfig set
  `stripInternal`, so the tag never reached the built declarations and the members
  shipped as public by accident. `stripInternal` is now set, which is what the tag
  always meant.

### Fixed

- A blank `Name` is no longer given an invented name. A type with an optional Name
  field left blank now keeps the blank verbatim as the epJSON key `""`; the
  synthetic `"<Type> N"` key is reserved for types that have no Name field at all.
  Previously, finding index 1 already taken by a real name,
  `IdfDocument.toJSON()` would emit `"<Type> 2"` for the blank-named object, so a
  document round-tripped through epJSON came back with an object nobody had named.
  Both parsers already preserved the distinction; only serialization discarded it.
  ([#7](https://github.com/idfkit/idfkit-js/issues/7))

### Migration

Every rename above is the one rename that name will get. The shared naming register
records a rename budget per name and its merge gate blocks a second one, so these
spellings are now fixed.

| Before                                              | After                                                |
| --------------------------------------------------- | ---------------------------------------------------- |
| `IDFDocument`                                       | `IdfDocument`                                        |
| `detectVersion(text)`                               | `getIdfVersion(text)`                                |
| `detectEpJsonVersion(text)`                         | `getEpJsonVersion(text)`                             |
| `doc.collection(type)`                              | `doc.all(type)`                                      |
| `import type { TypeMap } from '@idfkit/core/types'` | `import type { TypeMap } from '@idfkit/types-v26-1'` |

**What a missed rename looks like.** All of these are named exports, so a bundler
resolves them at build time and says which one is missing:

```
src/model.js (1:9): "IDFDocument" is not exported by
  "node_modules/@idfkit/core/dist/index.js", imported by "src/model.js".
```

You do not need TypeScript to get that error; rollup, esbuild and Vite all report
it. A plain-JavaScript project upgrading this release will be told exactly which
file and line to change.

The type-package split fails differently, because it is a subpath rather than a
name: `Cannot find module '@idfkit/core/types'`. Install the package for the
EnergyPlus release you target and change the specifier.

**Checked against a real consumer.** `idfkit-shoebox`, a browser application
using `parseIdf`, `writeIdf`, `SchemaBundle`, `httpSource`, `fetchWeatherFiles`
and `loadStationIndex`, upgraded across this release with **two changed lines**,
both the `IDFDocument` rename. Every other symbol it imports resolved unchanged.

## [0.1.0] - 2026-08-13

### Added

- `@idfkit/weather`, a new package for finding an EnergyPlus weather file and
  downloading it. `StationIndex` searches the climate.onebuilding.org TMYx index of
  69,638 stations by name, WMO number, filename, or distance from a coordinate, and
  `fetchWeatherFiles` and `fetchEpw` fetch a station's archive and return its EPW,
  DDY, and STAT files as text, ready to pass to
  [`@idfkit/engine`](https://www.npmjs.com/package/@idfkit/engine). Search is
  synchronous and pure, retrieval is the only async part, and nothing outside the
  platform is required: the ZIP reader is built on `DecompressionStream`, so the
  package runs unchanged in a browser, a worker, an edge runtime, or Node.
  climate.onebuilding.org sends no CORS header, so calls from a page need a proxy;
  `rewriteUrl`, `baseUrl`, and `fetch` options are provided to route through one.
- `geocode` and `detectLocation` turn a place name or the caller's IP address into
  the `[latitude, longitude]` pair that `StationIndex.nearest` takes, sharing one
  rate limiter that holds to the upstream geocoder's one-request-per-second policy.
- `@idfkit/weather/node` reads the station index bundled with the package straight
  off disk with `loadBundledIndex` and writes downloaded files out, so a script can
  search without touching the network. In the browser, `loadStationIndex` fetches
  the same index over HTTP.

### Fixed

- Schemas now load from hosts that serve `.gz` files with `Content-Encoding: gzip`,
  including the Vite dev server, nginx with `gzip_static on`, and several static
  hosts. `httpSource` inflated every response unconditionally, so a body the HTTP
  client had already inflated failed with `incorrect header check`, surfacing in the
  browser as a bare `TypeError: Failed to fetch` that pointed nowhere near the
  cause. The payload is now checked for the gzip magic bytes and only inflated when
  it is actually compressed.
- `httpSource` accepts a same-origin path such as `httpSource('/schemas/')`, the
  form the README documents. It previously threw `TypeError: Invalid URL` before
  making any request, because the base was required to be absolute. Relative bases
  now resolve against the document base, as `fetch('/schemas/...')` does. In Node,
  where there is no document base, a relative base remains an error but is only
  raised when a schema is read, so constructing a `SchemaBundle` at module scope is
  safe in server-rendered apps.
- `@idfkit/weather` carries a real version number. Its first upload to npm went out
  under the in-repo placeholder `0.0.0`, which the release tooling treats as "not a
  release". Anyone who installed that build should move to `0.1.0`; the code is the
  same, the version is not.

## [0.0.1] - 2026-08-13

First published release. The API is not yet stable.

### Added

- `@idfkit/core`: parsing and writing for both EnergyPlus input formats (`parseIdf`,
  `parseEpJson`, `writeIdf`, and `writeEpJson`) over a document model of
  `IDFDocument`, `IdfCollection`, and `IdfObject`, with case-insensitive lookup by
  type and name.
- A live reference graph. Renaming an object rewrites every reference to it, and
  writes through field accessors keep the graph current rather than requiring a
  rebuild.
- Generated TypeScript interfaces for each EnergyPlus version, so a misspelled field
  name is a compile error instead of a silent `undefined`.
- `@idfkit/schemas`: epJSON schemas for all 17 supported EnergyPlus versions, 8.9.0
  through 26.1.0, in roughly 1 MB gzipped. Definitions identical across versions are
  stored once and shared by content hash.
- A synchronous core that runs unchanged in browsers, workers, and edge runtimes.
  File I/O is confined to `@idfkit/core/node`, which adds `loadIdf`, `loadEpJson`,
  `saveIdf`, and `saveEpJson`.
- `SchemaBundle` with two sources: `httpSource` to fetch schemas over HTTP in the
  browser, and `localBundle` to read them from disk in Node.
- `resolveVersion`, which matches an IDF's `Version` object on major and minor and
  takes the newest matching patch. It returns `undefined` rather than guessing when
  no schema matches, because loading the wrong schema mis-maps every positional
  field instead of failing.

[unreleased]: https://github.com/idfkit/idfkit-js/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/idfkit/idfkit-js/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/idfkit/idfkit-js/releases/tag/v0.0.1
