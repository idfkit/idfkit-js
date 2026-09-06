# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The packages in this repository, `@idfkit/core`, `@idfkit/schemas`,
`@idfkit/weather` and `@idfkit/language`, are versioned and released together.

## [Unreleased]

## [0.3.0-rc.1] - 2026-09-06

This release moves to `conformance-2026.10` and `governance-2026.14`. Those two
levels are what a formatting-preserving writer costs in a corpus that proves
agreement: the assertion was cut at `conformance-2026.9` while this library
still failed it, with one divergence entry per case, and `conformance-2026.10`
is that level with the entries removed by the change that ended the absence.

### Added

- **`preserveFormatting` on the read, and a write that gives the file back.**
  `parseIdf(text, schema, { preserveFormatting: true })` retains the syntax
  layer and an index from each statement to the object it produced. `writeIdf`
  then walks the two together: every object nothing has changed is reproduced
  from the characters it was read from, and everything between the objects is
  copied.

  That last clause is most of the value. The comments, the blank lines that
  group four hundred surfaces into rooms, the indentation as the author left
  it, the line endings whatever they are, and whether the file ends in a
  newline all survive, because every character is either inside a statement or
  in a gap and nothing in a gap belongs to an object.

  Off by default. A caller who does not ask pays neither the scan nor the
  retention, and reading costs what it cost before.

- **`IdfDocument.rawText`**, the text a document was read from, or `undefined`
  after an ordinary read. How an editor answers whether saving will reformat
  the file without reaching into anything.

- **`preserveFormatting` on `writeIdf` and `writeEpJson`**, tri-state: absent
  decides from the document, `true` preserves and refuses a contradictory
  request, `false` formats. Preservation asked for on a document read without
  it is not an error, because nothing was promised.

  Asking to preserve _and_ to reformat is refused: `indent`, `commentColumn`,
  `ordering` and `versionFirst` all raise a `TypeError` naming the whole class
  of controls. Asking to preserve and for a different output _form_,
  `compressed` or `comments: false`, produces the form, because a form is a
  different artifact the original text was never going to express.

- **The object notation preserves on all-or-nothing terms.** `parseEpJson` with
  the option retains its text, and `writeEpJson` reproduces it only while
  nothing has been touched, added or removed. It has no statements, so there is
  nothing to anchor one object's characters to. This differs from the text
  format's per-object terms and differs the same way in Python.

### Changed

- **An extensible group now tells the document when it is mutated.**
  `get extensible()` returned the object's own array, so `push` and writing a
  repeat's field reached the object without passing any accessor and notified
  nobody — an edit a preserving writer would discard in a file that loads. It
  now returns an `Array` subclass whose mutators are heard, holding repeats
  whose fields are own accessors.

  It is still an array to everything that reads it: `Array.isArray` is true,
  indexing and iteration are unchanged, `map` and `filter` return plain arrays,
  and a repeat spreads and compares as the plain object it replaces.

  **The accessors are installed only on a document read with
  `preserveFormatting`.** Reading a coordinate through one costs about 33 times
  a plain property read, and a document with no retained source has no record
  to keep, so a geometry pipeline reads vertices at the cost it always has.

  One spelling is not heard: replacing a whole repeat by index,
  `obj.extensible[0] = {...}`. Catching it needs a `Proxy` or an accessor per
  index, both of which charge every vertex read to catch a write. Use `splice`,
  or write the repeat's fields.

- **A rename marks every object it rewrites.** `onNameChanged` rewrites
  referencing fields directly, bypassing the accessor on purpose, so none of
  those objects reported a change. A preserving write emitted them from their
  original text, producing a file that loads and names a construction layer
  that no longer exists. Both branches of the retarget loop now mark, including
  references reached through an extensible repeat.

- **The install budget (SC-012) rose from 1.75 MB to 1.875 MB.** The writer is
  47.7 KB of `dist` and does not fit the old figure. The reasoning is in
  `scripts/check-install-size.mjs`, including the lever left unpulled: 396 KB of
  the install is source maps, which serve debugging and nothing at runtime.

## [0.2.0] - 2026-09-04

This release stays on `conformance-2026.8`, the corpus level `CONFORMANCE_LEVEL`
reports, and adds no cases to it. A capability that exists in one language
asserts no cross-language agreement, so there is nothing for the corpus to
compare; the parity ledger carries the absence instead.

The governance level moves to `governance-2026.12`. `governance-2026.11`
registers the language service's names and carries that ledger entry;
`governance-2026.12` adds the two that reach the schema prose.

### Added

- A syntax layer in `@idfkit/core`. `scanIdf(text)` returns a `SyntaxLayer`:
  every statement, with the region of its type name and of each field it was
  written with, plus every meaningful token in source order, packed. It takes
  text and nothing else, because the layer records what the text says and never
  what it means, and it never throws for any input. Text that breaks the grammar
  is represented rather than stopped at: an unterminated final statement runs to
  the end of the input and says so, a statement written with no type name still
  gets a region, and empty text produces an empty layer.

  Nothing builds it implicitly. `parseIdf` and `lex` read the same characters
  through the same scan and construct none of it, so **a caller who never names
  `scanIdf` pays neither its time nor its memory**, and reading a file costs what
  it did before.

  `classify(layer)` is that layer read for drawing: the stored tokens with the
  gaps between them filled as `trivia`, so the sequence tiles the whole text with
  no hole and no overlap, and no token crosses a line boundary, because no token
  encoding in use can express one that does. It is a generator, so a consumer
  colouring a viewport stops where it stops rather than materialising every token
  in the file. `lineColumnAt` and `offsetAt` convert between an offset and a
  1-based line and column.

- `@idfkit/language`, the opt-in language service for IDF text, reachable under
  the shared name at `idfkit/language`. It answers a cursor and positions
  findings, and does nothing else:

  - `contextAt(text, offset, schema?)` reports what the cursor is on: the
    statement it is in, whether the offset falls on the type name, in a field,
    inside a comment, or between statements, and which field it is.
  - `completionsAt`, `explainAt`, and `declarationAt` answer what may be written
    here, what this means in the schema's own words, and where the name under the
    cursor is declared. Each returns a discriminated union rather than a list
    that is sometimes empty, because "the schema permits anything here" and "I
    could not consult a schema" are different states, and an editor that rendered
    them alike would look broken in the first case and be silently wrong in the
    second.
  - `findingsIn(text, schema)` reads, validates, and gives every finding a region
    plus the precision of that region, `field` or `statement`.
    `position(findings, layer, schema)` does the same for findings a caller
    already holds, so a consumer with its own parse pays for one scan rather than
    a second read. No validator changed and no finding is filtered or reworded:
    correlation is a separate step over the layer, and a caller that never asks
    for a position receives exactly what it received before.

  Everything here is synchronous, free of input and output, and holds no state.
  There is no service object to construct, because a service object is where
  state would accumulate, and every answer takes the text itself rather than a
  path, since an editor's buffer differs from the file on disk whenever there are
  unsaved changes. The same code therefore runs unchanged in Node, in a browser,
  in a browser worker, and behind an editor server. Nothing here imports or names
  a type from any editor protocol, and nothing here ever will; a consumer
  translates.

  An answer costs the statement rather than the file. The statement containing an
  offset is found by scanning backwards to the nearest semicolon that is not
  inside a comment, so there is no reparse, no incremental parser, and no cache.
  A committed measurement under `bench/` holds that to ratios rather than to
  milliseconds, which is the form that survives being run on someone else's
  machine: a cursor answer at most 2 percent of `parseIdf` over the same text,
  and `scanIdf` at most 1.25 times it.

  **It is not installed by default.** `npm install idfkit` places zero bytes of
  the service on disk, exactly as it places no weather code. Add
  `@idfkit/language` by name to get it, and importing `idfkit/language` without
  it names the package to install rather than failing with
  `ERR_MODULE_NOT_FOUND`.

  There is no Python counterpart, and there is not going to be one. The answers
  are computed from byte offsets into the source text, and a second
  implementation of that arithmetic is the drift the corpus is least able to
  police, since it compares findings on `(code, line, typeName)` and never on a
  column. The decision is on the parity ledger as `idf-language-service`, at
  `never`, which is terminal: adding a counterpart takes a constitutional
  amendment rather than an edit. What it costs a reader is stated rather than
  implied. These answers need a JavaScript runtime, and `pip install idfkit`
  alone does not provide them.

- `SchemaBundle.loadProse()` and `SchemaBundle.prose()`, the pair that lets a
  consumer of the shared name reach the schema's own explanatory prose. The
  strings have shipped since 0.2.0-rc.2 and `describeObjectType` has always
  resolved them, but there was no way to obtain the pool without depending on
  `@idfkit/schemas/node`, a package a consumer of `idfkit` did not install, and
  hardcoding a file name the bundle layout does not promise.

  `loadProse()` reads it once, `prose()` returns it synchronously or
  `undefined`, exactly as `load(version)` and `loaded(version)` already work for
  schemas. The synchronous half is the point: everything that reads prose is
  synchronous, so an editor server loads once when a document arrives and reads
  on the request path without holding a thread.

  **On the bundle rather than beside it**, because the indices are only
  meaningful against manifests built in the same run. A pool paired with another
  build's manifests resolves every sentence to a real sentence belonging to a
  different field, and nothing fails. Keeping the loader on the object that
  carries the indices is what makes that pairing hard to reach by accident.

  It works in a browser through `httpSource` on the same terms, and the parse
  path is unchanged: the pool is still its own file behind its own call, and a
  read-and-write bundle still carries none of it.

  `ProsePool` now comes from `@idfkit/schemas`, which is the package that builds
  the pool. `@idfkit/core` re-exports it, so the name a consumer imports is
  unchanged.

### Changed

- `ParseDiagnostic.column` is filled. It was declared in 0.2.0-rc.2 and left
  undefined because the lexer counted lines and not columns; the shared scan
  counts both, and a reading finding now reports the column its statement begins
  at, taken at the first non-blank character and counted from 1. The field is
  still optional, so nothing that treated it as absent breaks.

  A column is the one location the two libraries measure in different units, and
  that is registered rather than left to be found: Python counts code points and
  JavaScript counts UTF-16 code units, so the two agree everywhere except in text
  containing an astral character, which in practice means an emoji in a comment.
  Each unit is the one its own ecosystem's editors want, so neither is converted.
  Nothing compares columns across the two libraries today; the corpus matches
  findings on `(code, line, typeName)`.

- `lex` and `parseIdf` read through the same scan the syntax layer is built from.
  Both keep their surface and their behaviour; there is now one scanner rather
  than two, which is what keeps a position the layer reports and a position a
  finding reports from drifting apart.

## [0.2.0-rc.2] - 2026-09-04

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

- `ParseDiagnostic` gains a `code` and an `objectName`, and declares a `column`
  and a `filepath` so both libraries carry the same kinds of location. `code` is
  one of eight values shared with the Python library. Match on it rather than
  on `message`: the corpus compares findings on `(code, line, typeName)` and
  never on wording.

  Both are optional, and each is filled at the one place that knows the value.
  `parseIdf` takes text and cannot know where the text came from, so `filepath`
  is stamped by the Node file-reading edge: `loadIdf` and
  `loadIdfWithDiagnostics` attach the path they read to every finding, on the
  result and on the error alike. A caller parsing a string still gets none,
  because a string names no file. `column` is filled by the reader itself, from
  the statement's first non-blank character, once the shared scan arrived to
  count it (see Unreleased).

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

[unreleased]: https://github.com/idfkit/idfkit-js/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/idfkit/idfkit-js/compare/v0.2.0-rc.2...v0.2.0
[0.2.0-rc.2]: https://github.com/idfkit/idfkit-js/compare/v0.2.0-rc.1...v0.2.0-rc.2
[0.2.0-rc.1]: https://github.com/idfkit/idfkit-js/compare/v0.1.0...v0.2.0-rc.1
[0.1.0]: https://github.com/idfkit/idfkit-js/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/idfkit/idfkit-js/releases/tag/v0.0.1
