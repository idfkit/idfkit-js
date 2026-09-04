# Static types generated from the schema

This is the part with no Python counterpart, and the main reason a JavaScript
library is worth writing rather than merely possible.

`scripts/emit-types.mjs` turns one version's epJSON schema into TypeScript: 858
interfaces for EnergyPlus 26.1, one per object type, plus a `TypeMap` joining
each type name to its interface. Each version's output is its own package, so
you install the ones you want and nothing else:

```bash
npm install --save-dev @idfkit/types-v26-1
```

Parameterizing a document with that map is the whole opt-in:

```ts
import { loadIdf } from '@idfkit/core/node';
import type { TypeMap } from '@idfkit/types-v26-1';

const doc = await loadIdf<TypeMap>('model.idf');

doc.all('Zone'); // completes among 858 type names
doc.add('Zone', 'Z1', { celing_height: 3 }); // compile error: typo
doc.add('BuildingSurface:Detailed', 'S1', { sun_exposure: 'Sunny' }); // compile error
```

The interfaces carry the schema's documentation with them, so units, defaults,
and choice lists are in the editor's tooltip rather than in a reference tab:

```ts
export interface Zone {
  /**
   * X Origin
   * Units: m
   * Default: 0
   */
  x_origin?: number;
  // ...
}
```

## What this replaces

In the Python library, `zone.ceiling_height` resolves at runtime through
`__getattr__`. An editor cannot see through that, so nothing completes and
nothing is checked. `zone.celing_height` is not an error; it is `None`, and it
stays `None` until EnergyPlus rejects the model or, worse, simulates a building
with a defaulted ceiling height.

Here the schema is compiled into the type system, so the same typo is a build
error. That is the practical argument for passing the `TypeMap` even in a
codebase that is otherwise loosely typed.

## It costs nothing, installed or not

The maps are big. EnergyPlus 26.1 is 2.7 MB of declarations and 9.4 is another
2.4 MB, against roughly 170 KB for the whole of `@idfkit/core`. That is why they
are separate packages rather than a subpath of core: install neither and you
have a complete, working library and zero bytes of either map on disk.

Installed, they still cost nothing at run time. `TypeMap` is a type, not a
value. It is erased at build time. A typed document
and an untyped one are the same object graph, running the same code, and
`doc.all('Zone')` really is just a string argument. Omit the parameter and
everything still works, untyped:

```ts
const doc = await loadIdf('model.idf'); // fine, just no completion
```

## Two design details that are easy to get wrong

**`TypeMap` must be emitted as a `type` alias, never an `interface`.** Interfaces
have no implicit index signature, so an interface cannot satisfy
`Record<string, object>` and the map would not fit the `AnyTypeMap` constraint.
This is a real constraint on the generator, not a style preference.

**`add()` and `all()` deliberately use different helpers.** `add()` takes
`ValuesOf`, which resolves to the exact field interface for a known type name —
so TypeScript's excess-property check fires on a misspelled field in an object
literal. `all()` returns `ObjectOf`, which resolves to the interface for known
names and a permissive empty object otherwise, so version-generic code and
untyped documents still work.

Using one helper for both would force a choice between catching typos and
allowing dynamic field names. Using two costs nothing and gives both.

`TypeNameOf` has a similar subtlety: its `(string & {})` arm is what keeps
literal completion alive while still accepting arbitrary strings. Without it
TypeScript widens the parameter to `string` and the 858 suggestions disappear.

## Declarations only, and it is checked

A type package holds one `index.d.ts` and nothing else. No `main`, no
`dependencies`, no build step, and no JavaScript: nothing compiles a declaration
file, so there is nowhere for runtime code to be produced the way it was when
these were ordinary `.ts` modules inside `@idfkit/core`. `npm run
check:type-packages` measures the emitted JavaScript in every type package, both
in the working tree and in what `npm pack` would ship, and fails the build on
one byte of it — or on an exported value, which a declaration file will accept
and then emit nothing for, leaving an export that crashes whoever imports it.

`@idfkit/core` is a peer range rather than an exact version. The map borrows
exactly one type from core, `ExtensibleGroup`, and neither package carries
runtime, so a skew between the two is a type error at your build and never a
failure at run time.

## How this is kept honest

Vitest transpiles without typechecking. A change that silently breaks the type
map passes `npm test` cleanly, so the `@ts-expect-error` assertions in
`packages/core/tests/typed.test.ts` — the ones proving the generated types
actually _reject_ bad input — mean nothing unless `tsc` runs:

```bash
npx tsc -p tsconfig.test.json
```

That is why it is a separate, non-optional step in
[CONTRIBUTING](https://github.com/idfkit/idfkit-js/blob/main/CONTRIBUTING.md)
and a separate job in CI.
