# idfkit

The shared install name. One package, four subpaths, no implementation of its
own: everything here re-exports a scoped package that stays published under its
own name and remains the real library (FR-036, FR-037).

```bash
npm install idfkit
```

```ts
import { parseIdf } from 'idfkit';
import { loadIdf } from 'idfkit/node';
```

## The subpaths

| Subpath          | Re-exports          | Installed with `idfkit` | Browser-safe                       |
| ---------------- | ------------------- | ----------------------- | ---------------------------------- |
| `idfkit`         | `@idfkit/core`      | yes                     | yes: synchronous, pure, no I/O     |
| `idfkit/node`    | `@idfkit/core/node` | yes                     | no: async, filesystem              |
| `idfkit/schemas` | `@idfkit/schemas`   | yes                     | runtime yes; data loaded on demand |
| `idfkit/weather` | `@idfkit/weather`   | **no, opt-in**          | runtime yes; ships its own index   |

Four subpaths rather than one flat entry point, so a browser bundle that reads
and writes a model pulls in no schema data, no station index, and no generated
types (FR-038, SC-013).

## Weather is opt-in

`@idfkit/weather` is an **optional peer dependency**. `npm install idfkit` does
not install it, which is what keeps its 1.6 MB station index off disk for
everyone who never asks for weather (FR-043, SC-016). Add it by name:

```bash
npm install @idfkit/weather
```

Importing `idfkit/weather` without it fails with a message naming that command
(FR-074). A project that never imports the subpath type-checks clean with the
peer absent (SC-031).

### If you publish a package that depends on `idfkit`

Declare the opt-in components your package imports, in your own dependencies
(FR-089):

```jsonc
{
  "dependencies": {
    "idfkit": "^1.0.0",
    "@idfkit/weather": "^1.0.0", // because this package imports idfkit/weather
  },
}
```

Depending on `idfkit` alone does not bring weather with it, for your package any
more than for anyone else. Leave it undeclared and nothing fails at install
time: the failure arrives at whoever installed _your_ package, at run time, as
the message above naming `npm install @idfkit/weather`. That message is correct
but it is addressed to the wrong person, and they cannot act on it without
reading your source.

## The engine is not here

Browser simulation is a separate install, and deliberately not a subpath of this
package: `@idfkit/engine-assets` is 51 MB, and it versions on the EnergyPlus
release it bundles rather than on this library (FR-070).

```bash
npm install @idfkit/engine @idfkit/engine-assets@26.1
```

## Generated types are a separate install too

`@idfkit/types-v26-1` and `@idfkit/types-v9-4` are opt-in and cost nothing when
declined. A document with no type map is typed permissively rather than not at
all (FR-040, SC-014).

## Nothing runs at install time

No `preinstall`, `install`, `postinstall` or `prepare` script, here or in
anything this package depends on: install-time scripting is silently skipped
under `--ignore-scripts` and in many CI environments (FR-042, SC-015).
