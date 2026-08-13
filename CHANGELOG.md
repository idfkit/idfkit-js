# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Both packages in this repository, `@idfkit/core` and `@idfkit/schemas`, are
versioned and released together.

## [Unreleased]

### Fixed

- Schemas now load from hosts that serve `.gz` files with `Content-Encoding: gzip`,
  including the Vite dev server, nginx with `gzip_static on`, and several static
  hosts. `httpSource` inflated every response unconditionally, so a body the HTTP
  client had already inflated failed with `incorrect header check` — surfacing in
  the browser as a bare `TypeError: Failed to fetch` that pointed nowhere near the
  cause. The payload is now checked for the gzip magic bytes and only inflated when
  it is actually compressed.
- `httpSource` accepts a same-origin path such as `httpSource('/schemas/')`, the
  form the README documents. It previously threw `TypeError: Invalid URL` before
  making any request, because the base was required to be absolute. Relative bases
  now resolve against the document base, as `fetch('/schemas/...')` does. In Node,
  where there is no document base, a relative base remains an error but is only
  raised when a schema is read, so constructing a `SchemaBundle` at module scope is
  safe in server-rendered apps.

## [0.0.1] - 2026-08-13

First published release. The API is not yet stable.

### Added

- `@idfkit/core`: parsing and writing for both EnergyPlus input formats — `parseIdf`,
  `parseEpJson`, `writeIdf`, and `writeEpJson` — over a document model of
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

[unreleased]: https://github.com/idfkit/idfkit-js/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/idfkit/idfkit-js/releases/tag/v0.0.1
