# Reference

Facts about what the packages contain and how they behave. For tasks, see the
[how-to guides](../how-to/index.md); for the reasoning behind any of it, see
[Explanation](../explanation/index.md).

## Packages

| Package                             | Import                     | Contents                                                 | Environment |
| ----------------------------------- | -------------------------- | -------------------------------------------------------- | ----------- |
| [`@idfkit/core`](core.md)           | `@idfkit/core`             | Parsing, writing, the object model. Synchronous, no I/O. | Anywhere    |
| [`@idfkit/core/node`](core-node.md) | `@idfkit/core/node`        | `loadIdf`, `saveIdf`, schema discovery from disk         | Node        |
| [`@idfkit/schemas`](schemas.md)     | `@idfkit/schemas`          | Schema bundle, `Schema`, `httpSource`                    | Anywhere    |
| Generated types                     | `@idfkit/core/types/v26-1` | Per-version interfaces and `TypeMap`                     | Types only  |

`@idfkit/core` re-exports `Schema`, `SchemaBundle`, and `httpSource` from
`@idfkit/schemas`, so a browser application usually needs only the one import.

## Other reference

- [Supported versions](versions.md) — the 17 bundled releases and how a version
  string in a file is matched to one of them.
- [Slim schema format](slim-schema-format.md) — what the bundle keeps, what it
  drops, and the single-letter keys.

## How the API pages are produced

The three API pages are generated from the TypeScript sources by TypeDoc, read
into the site through `mkdocstrings-typescript`. Nothing on them is
hand-maintained, so a symbol appears because it is exported and its description
is the TSDoc comment above it.

That handler is at an early stage and renders less structure than its Python
counterpart: prose, headings, and the symbol tree are faithful, but parameter
lists and full type signatures are sparse. Where a signature matters, this
documentation states it in prose rather than relying on the generated page.
