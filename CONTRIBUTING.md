# Contributing to idfkit-js

Contributions are welcome. This file covers the development workflow; for what
the library does and why, see [the documentation](https://developers.idfkit.com/) or
[`CLAUDE.md`](CLAUDE.md) for the short version.

## Setup

```bash
npm install
```

That is the whole setup. There are no runtime dependencies to build and no
native modules.

## The checks

Run all three before proposing a change:

```bash
npm run format:check
npx tsc -p tsconfig.test.json
npm test
```

### The typecheck is not optional

`npx tsc -p tsconfig.test.json` typechecks sources **and tests**, and it is a
separate step for a reason. Vitest transpiles without typechecking, so the
`@ts-expect-error` assertions in `packages/core/tests/typed.test.ts` — the ones
proving the generated types actually reject bad input — mean nothing unless
`tsc` runs. A change that silently breaks the type map passes `npm test`
cleanly.

CI runs it as its own job for the same reason.

### Useful subsets

```bash
npx vitest run packages/core/tests/parse.test.ts   # one file
npm run test:watch                                 # watch mode
npx tsc --build                                    # build to dist/
```

Tests run against TypeScript source through the aliases in `vitest.config.ts`,
so there is no build step between editing a file and testing it.

## The conformance suite

`packages/core/tests/roundtrip.test.ts` is the test that matters. It parses,
writes, and re-parses the IDF files EnergyPlus ships and requires deep equality.

It skips cleanly when no EnergyPlus installation is present, so `npm test` is
green without one. Set `ENERGYPLUS_DIR` to run it locally:

```bash
ENERGYPLUS_DIR=/Applications/EnergyPlus-26-1-0 npm test
```

CI installs EnergyPlus so the suite always runs somewhere, and then separately
asserts that the example directory exists — a conformance job that proved nothing
should fail rather than pass quietly.

**When you fix a bug found this way, add a case to
`packages/core/tests/regressions.test.ts`.** Every bug fixed so far came out of
that loop rather than from writing a test first, and the example set is not a
stable contract.

## Regenerating the schema bundle

The bundle in `packages/schemas/data` is generated from the Python repository's
epJSON schemas and committed:

```bash
npm run build:schemas -- --source ../idfkit/src/idfkit/schemas
```

CI clones the Python repository and rebuilds, failing if the committed bundle
differs. Without that check, someone could edit `build.mjs` and every other test
would still pass against a stale bundle.

Hashes come from a canonical serialization — sorted keys, fixed separators — and
**that must stay stable across rebuilds**. If it drifts, every hash changes and a
regeneration produces a diff covering the whole bundle instead of the handful of
definitions a release actually changed.

## Regenerating the TypeScript interfaces

```bash
npm run codegen -- 26.1.0
```

This also reads the Python repository's schemas, which is why the output is
committed rather than generated at install time. Interfaces are committed for
26.1.0 and 9.4.0, one opt-in package each: `packages/types-v26-1` and
`packages/types-v9-4`.

The generator writes the whole package — `index.d.ts`, manifest, tsconfig,
README — so running it for a version that has none creates one. Add the new
package to the `references` in `tsconfig.json` and to the publish loop in
`.github/workflows/publish.yml`; the script prints that reminder when it
finishes.

The output is a `.d.ts`, not a `.ts`, and that is load-bearing: a type package
must contain no runtime code (FR-039), and nothing compiles a declaration file
into any. TypeScript will still accept an exported `const` inside one — it emits
nothing for it, which makes it a phantom export that crashes whoever imports it
— so `npm run check:type-packages` fails on a single byte of JavaScript and on
any exported value declaration.

`TypeMap` must be emitted as a `type` alias, never an `interface`: interfaces
have no implicit index signature and cannot satisfy `Record<string, object>`.

## Documentation

### Where a documentation change goes

**Not here.** The published site is <https://developers.idfkit.com>, and its source is a
third repository, [idfkit/idfkit-developers](https://github.com/idfkit/idfkit-developers),
which belongs to neither library. It teaches both languages from one navigation: a page
about loading a model is one page with two idioms on it, so prose changes are made there.

What this repository owes that site is an **artifact**, published by
`.github/workflows/publish-docs-artifacts.yml` as a `docs-YYYY.N` release carrying two
things together:

- `docs-snippets.tar.gz` — every TypeScript example the site publishes, as the real modules
  `npm run typecheck:docs` compiled, so a page cannot show text that was never compiled;
- `typedoc.json` — the TypeDoc JSON the TypeScript reference is generated from.

One release carries both, so the reference and the examples on a page always describe the
same commit. The site pins the tag in `[tool.idfkit.docs]`, vendors the trees, and compares
them byte for byte on every run, so cutting a new level is how a change to a documented
TypeScript example reaches a reader.

Cut one by pushing a `docs-YYYY.N` tag, or by dispatching that workflow with the tag as its
input. A level is immutable: to change what a level contains, cut the next one.

### The local site under docs/

The site below is `js.idfkit.com`, which is retired and redirects to the unified site. It is
MkDocs with Material, and the API reference is generated from the TypeScript sources by
TypeDoc through `mkdocstrings-typescript`.

```bash
npm run docs:serve   # http://127.0.0.1:8000
npm run docs:build   # --strict; this is what CI runs
```

Both go through `uv`, so no virtualenv needs managing; dependencies are in
`docs-requirements.txt`. TypeDoc comes from devDependencies and is on `PATH`
because these run as npm scripts — invoking `mkdocs` directly will fail to find
it.

Structure follows [Diátaxis](https://diataxis.fr): a page is a tutorial, a
how-to guide, reference, or explanation, and never two of them. If material
belongs somewhere else, move it and leave a link rather than duplicating it.

`docs/.hooks/typedoc_shim.py` patches `griffe-typedoc` so it can decode current
TypeDoc output; the file explains what it does and when it can be deleted.

### Snippets are executed

`packages/core/tests/readme.test.ts` runs the published README snippets
verbatim. If you change a documented API, that test should fail — **fix the
README, not the test.**

The tutorial is not covered by that harness. If you change the object model,
work through
[`docs/tutorials/first-model.md`](docs/tutorials/first-model.md) in a clean
directory before merging. A tutorial that fails at step 4 costs more confidence
than having no tutorial.

## Conventions

- **Node:** 20+. CI tests 20, 22, and 24, plus macOS and Windows on 22 — the
  parser reads latin-1 and the writer emits it, and line endings have broken
  that before.
- **Formatting:** Prettier. Single quotes, semicolons, ES5 trailing commas,
  width 100.
- **TypeScript:** strict, `type` keyword for type-only imports.
- **Field names:** epJSON names verbatim (`zone_name`). There is deliberately no
  name-conversion layer.
- **Do not import `node:*` outside `node.ts`.** The portable core must stay
  usable in a browser, and nothing enforces this but review.
- **Do not make a core function async.** I/O belongs at the edges.

## Load-bearing decisions

Some parts of this codebase were chosen over an obvious alternative for reasons
that are not visible from the code. Before changing one, read why it is the way
it is:

- [A synchronous core with async edges](docs/explanation/sync-core-async-edge.md)
- [Why accessors and not a `Proxy`](docs/explanation/accessors-not-proxies.md)
- [Static types generated from the schema](docs/explanation/generated-types.md)
- [Content-addressed schemas](docs/explanation/content-addressed-schemas.md)
- [The hazards of a positional format](docs/explanation/positional-format-hazards.md)

## Parity with the Python library

If you are adding a feature that also exists in
[idfkit](https://github.com/idfkit/idfkit), check what it does there rather than
inventing a behaviour. Two implementations of a schema-driven format drift
silently, because each side passes its own tests. See
[Parity with the Python library](docs/explanation/parity.md).
