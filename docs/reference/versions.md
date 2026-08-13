# Supported versions

All 17 releases ship in one package. There is no per-version install and no
build step to select one.

| EnergyPlus | Schema key | EnergyPlus | Schema key |
| ---------- | ---------- | ---------- | ---------- |
| 8.9        | `8.9.0`    | 23.1       | `23.1.0`   |
| 9.0        | `9.0.1`    | 23.2       | `23.2.0`   |
| 9.1        | `9.1.0`    | 24.1       | `24.1.0`   |
| 9.2        | `9.2.0`    | 24.2       | `24.2.0`   |
| 9.3        | `9.3.0`    | 25.1       | `25.1.0`   |
| 9.4        | `9.4.0`    | 25.2       | `25.2.0`   |
| 9.5        | `9.5.0`    | 26.1       | `26.1.0`   |
| 9.6        | `9.6.0`    |            |            |
| 22.1       | `22.1.0`   |            |            |
| 22.2       | `22.2.0`   |            |            |

`bundle.versions()` returns this list, oldest first; `bundle.latest()` returns
the last entry.

## Generated types

Schemas ship for all 17 versions. Generated TypeScript interfaces are committed
for two of them:

| Import                     | Version |
| -------------------------- | ------- |
| `@idfkit/core/types/v26-1` | 26.1.0  |
| `@idfkit/core/types/v9-4`  | 9.4.0   |

Every version can be generated. The script needs the raw epJSON schemas from the
Python repository, which is why the output is committed rather than produced at
install time:

```bash
npm run codegen -w @idfkit/core -- 25.2.0
```

Types are optional everywhere. A document with no map parameter behaves
identically at runtime; see
[Static types generated from the schema](../explanation/generated-types.md).

## Matching a file's version to a schema

An IDF file writes two components:

```idf
Version, 9.0;
```

Schemas are keyed on three. `resolveVersion` closes that gap:

1. If the detected string is in the available list, use it.
2. Otherwise take every candidate with the same major and minor, and return the
   newest by patch. `9.0` therefore resolves to `9.0.1`.
3. If no candidate shares major and minor, return `undefined`.

Step 3 is deliberate. Loading a schema for the wrong release does not fail: IDF
is positional, so a field-order difference mis-maps values into neighbouring
slots and the parse "succeeds" with a corrupted model. Returning `undefined` and
letting the caller fail is the safe outcome.

`loadIdf` turns that `undefined` into a thrown error naming what was available.
A file with no `Version` object throws a different error, telling you to pass
`version` explicitly:

```ts
const doc = await loadIdf('fragment.idf', { version: '26.1.0' });
```

## Comparing versions

`versionKey` and `compareVersions` sort numerically. Plain string sort is wrong
here, because it places `8.9.0` after `22.1.0`.

```ts
import { compareVersions } from '@idfkit/core';

['22.1.0', '8.9.0', '9.6.0'].sort(compareVersions);
// ['8.9.0', '9.6.0', '22.1.0']
```
