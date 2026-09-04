# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The packages in this repository, `@idfkit/core`, `@idfkit/schemas`, and
`@idfkit/weather`, are versioned and released together.

## [Unreleased]

### Added

- `describeObjectType` reports the schema's explanatory prose. It takes an
  optional third argument, the prose pool, and fills `memo` on a type
  description and `note` on a field description from it.

  The pool ships in the default install at `@idfkit/schemas`'s `data/`
  directory, as `docs.json.gz`, and is read the same way the manifests and the
  type store are. It is 4,878 distinct strings standing in for roughly 119,000
  occurrences across the seventeen bundled schemas.

  The signature stays synchronous and the pool is passed in rather than reached
  for. Reading a file is not synchronous, and making the function async to
  fetch something most callers do not want would be a breaking change serving
  the minority. **A caller who passes nothing gets exactly what they got
  before**: `undefined` prose, everywhere.

  The prose never reaches the model-reading path. It is a separate file under
  `data/`, which the bundle-purity check already fences: an esbuild metafile
  for a minimal read-and-write page contains zero inputs under any `data/`
  directory, and that check now covers the pool with no change.

- `writeIdf` takes `compressed`, putting each object on one line with no
  comments and no blank separators. The counterpart of the Python library's
  `output_type="compressed"`, and it means the same thing.

  `comments: false` is not this: it skips the padding and the comment and still
  puts every field on its own line.

- `IdfParseError` carries `diagnostics`, every finding that stopped the parse,
  rather than one finding flattened into two fields. `.line` and `.typeName`
  still resolve to the first finding's values, so no existing caller breaks.

- `ParseDiagnostic` gains a `code`, a `column`, a `filepath`, and an
  `objectName`, so both libraries carry the same kinds of location. `code` is
  one of eight values shared with the Python library. Match on it rather than
  on `message`: the corpus compares findings on `(code, line, typeName)` and
  never on wording.

### Fixed

- `enumValues` reports the values it was omitting. The empty string is included
  for the enums that declare one, and the sentinels `Autosize` and
  `Autocalculate` are read from the collapsed `anyOf` string branch, which
  validation has always read and this path never did.

  Validation is unaffected: the blank is still filtered out of the list
  validation checks against and is restored only in the description.

- Three object types reported their fields in alphabetical order rather than
  declaration order: `ZoneProperty:UserViewFactors:BySurfaceName`,
  `ZoneTerminalUnitList`, and `SolarCollector:UnglazedTranspired:Multisystem`.
  These are the three whose positional field list holds only the name, so the
  description fell back to the key order of the property map, which the
  content-addressing serializer had sorted. The bundle now records their
  declaration order explicitly.

### Changed

- The install-size budget for the shared name rose from 1.5 MB to 1.75 MB
  (SC-012). No package grew: this change moves a threshold and nothing else.

  The budget is self-imposed, an improvement target set against this project's
  own former footprint of roughly 7.9 MB rather than any registry limit. It was
  raised to make room for the schema's explanatory prose, which
  `describeObjectType` must return in both languages and which costs 190,471
  bytes gzipped for all seventeen supported EnergyPlus versions, deduplicated to
  4,772 distinct strings plus the references that reach them. Against 1.5 MB that
  landed a clean install at 100.5 percent, over by 8,352 bytes.

  A clean `npm install idfkit` measures 1.33 MB across 141 files, 76 percent of
  the new budget. About 190 KB of the remaining 434 KB is already promised to the
  prose, which will take the install to roughly 86 percent. 1.6 MB was rejected
  because it would have left less slack than the install has today.

## [0.2.0-rc.1] - 2026-09-04

### Added

- Validation, object type introspection, and documentation URLs, ported from the
  Python library and reaching JavaScript for the first time.

  `validateDocument(doc)` and `validateObject(obj, schema)` check a model against
  its schema. Nothing throws: a finding is a record carrying a `severity`, the
  object it was found on, the `field` it concerns, a `message`, and a `code`.
  Match on `code`, never on `message`: the codes are shared verbatim with the
  Python library (`E001` required field missing, `E003` wrong type, `E004` value
  not among the permitted values, `E005` to `E008` the four bounds, `E009`
  dangling reference, `E010` singleton violation, and `W002`/`W003` for an
  unknown type and an unknown field), while the messages differ between the two
  runtimes because number formatting and type names do.

  Validation is on demand and parsing never triggers it, so reading a file costs
  what it always did. `validateObject` takes its schema as an argument rather
  than reading it off the object, which means an object can be checked while it
  is still detached, before it goes anywhere near a document:

  ```ts
  const candidate = zone.clone();
  candidate.set('ceiling_height', -1);
  const findings = validateObject(candidate, doc.schema);
  // [{ code: 'E005', field: 'ceiling_height', message: 'Value -1 is below minimum 0', ... }]
  ```

  `describeObjectType(schema, typeName)` reports what a type declares, as an
  `ObjectDescription`: every field with its type, whether it is required, its
  default, its units, its permitted values and its bounds, plus whether the type
  carries a name and whether it has an extensible group. It is the schema read as
  a description rather than as storage, which is what a form generator or a field
  editor wants. One sharp edge is worth knowing before you rely on the bounds:
  `exclusiveMinimum` and `exclusiveMaximum` come back as `true` rather than as a
  number on EnergyPlus 8.9.0 through 9.5.0, whose draft-04 schemas use the
  keyword as a flag qualifying `minimum` and `maximum` instead of as a bound of
  its own. Python reports the same raw value. Prefer `validateObject` over
  reading the bounds yourself, which is the case this quirk most easily breaks.

  `docsUrlForObject`, `ioReferenceUrl`, `engineeringReferenceUrl` and `searchUrl`
  return links into the EnergyPlus documentation for an object type, so a tool
  can point at the reference rather than embedding it.

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

- Validation reads the constraints inside an `anyOf` field instead of discarding
  them, and three declared types in `@idfkit/schemas` that did not match what the
  bundle actually held are now honest.

  The validator was deliberately bug-compatible with Python, which never read
  inside an `anyOf` branch. Python is fixed, so the guard is gone. Doing it
  correctly needed the bundle to stop throwing information away: `slimField`
  collapsed an `anyOf` to its numeric branch plus `auto: 1` and discarded the
  string branch, so nothing recorded _which_ sentinel a field accepts. That
  distinction is not academic, since 1,781 fields take `Autocalculate` rather
  than `Autosize` and 646 accept any string at all, and a library that accepts
  either everywhere accepts values EnergyPlus rejects. `SlimField` gains `se`,
  the string branch's enum verbatim, with absent meaning the branch declared no
  enum; the empty string is kept as a value, because "only the empty string" and
  "any string" are opposite claims. The bundle grows 5,416 bytes, 0.52%.

  **Breaking for anyone reading `SlimField` directly:** `xmin` and `xmax` were
  typed `number` but hold a boolean on 8.9.0 through 9.5.0, where draft-04 makes
  the flag qualify its sibling bound. A consumer trusting the old type computed
  `value <= true` and rejected everything at or below 1 in a positive-bounded
  field. `e` was typed `string[]` but holds numbers for the 68 fields carrying a
  numeric enum. Both types now describe what is really there, so code reading
  them may need to widen. `describeObjectType` follows the widened types and now
  reports `integer|string` for `number_of_beams`, closing its last known
  divergence from Python.

  The same change removes reference-check false positives from lists nothing can
  populate, `ZoneList`-expanded names, and implicit remainder spaces. Across the
  760 EnergyPlus example files that is 19,793 spurious findings gone, and files
  that validate cleanly rise from 149 to 470.

- Reading an unknown object type no longer modifies the document. `all()`
  resolves the type name through the schema, but on a miss it used to store the
  new empty collection, so `doc.all('Zoen')` permanently added a junk key as a
  side effect of a read. The read path now returns a detached `IdfCollection` and
  leaves the document alone; only `attach()` and a rename may add a key. An
  unknown name still returns empty rather than throwing, matching Python, because
  a schemaless document cannot tell a typo from a valid type and version-generic
  code legitimately asks for types that exist in some releases and not others.

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

[unreleased]: https://github.com/idfkit/idfkit-js/compare/v0.2.0-rc.1...HEAD
[0.2.0-rc.1]: https://github.com/idfkit/idfkit-js/compare/v0.1.0...v0.2.0-rc.1
[0.1.0]: https://github.com/idfkit/idfkit-js/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/idfkit/idfkit-js/releases/tag/v0.0.1
