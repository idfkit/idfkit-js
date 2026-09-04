# @idfkit/schemas

EnergyPlus epJSON schemas for every supported version, in a form small enough to
send to a browser.

**[Documentation](https://js.idfkit.com/)** ·
[API reference](https://js.idfkit.com/reference/schemas/) ·
[Slim schema format](https://js.idfkit.com/reference/slim-schema-format/)

```bash
npm install @idfkit/schemas
```

## Why this exists

The raw epJSON schemas are ~10 MB each, 17 of them, 11.9 MB gzipped in total. In
a Python wheel nobody notices. On a page load it decides your architecture.

The 17 manifests name 14,092 object-type definitions between them, and only
2,568 of those are distinct. 82% of what the releases carry is a byte-identical
repeat of a definition another release already has: `Construction`, for
instance, has changed once in 17 releases. So this package stores each unique
definition once, keyed by a content hash, and gives every version a manifest
mapping type name to hash.

|                                          | All 17 versions, gzipped |
| ---------------------------------------- | ------------------------ |
| Raw epJSON schemas                       | 11,915 KB                |
| Slimmed (documentation metadata dropped) | 2,922 KB                 |
| Content-addressed (this package)         | ~1,000 KB                |

Splitting per version would have been the obvious move and is the wrong one: it
duplicates the shared 82% across packages and makes cross-version work require
several installs. The longer argument is in [Content-addressed
schemas](https://js.idfkit.com/explanation/content-addressed-schemas/).

## Usage

```ts
import { SchemaBundle, httpSource } from '@idfkit/schemas';

const bundle = new SchemaBundle(httpSource('/schemas/'));

await bundle.versions(); // ['8.9.0', '9.0.1', ..., '26.1.0']
await bundle.latest(); // '26.1.0'

const schema = await bundle.load('26.1.0');
schema.resolve('ZONE'); // 'Zone' (IDF type names are case-insensitive)
schema.get('Zone'); // full definition
schema.field('Zone', 'x_origin'); // { t: 'n', u: 'm', d: 0 }
```

In Node, read from the package's own data directory:

```ts
import { localBundle } from '@idfkit/schemas/node';

const schema = await localBundle().load('26.1.0');
```

In a browser, copy `node_modules/@idfkit/schemas/data` to a served path and point
`httpSource` at it.

### Cross-version diffs

Because definitions are content-addressed, comparing versions is a manifest
comparison rather than a deep diff of two 10 MB documents:

```ts
const delta = (await bundle.load('26.1.0')).changedFrom(await bundle.load('9.4.0'));
delta.added; // types introduced since 9.4
delta.removed;
delta.changed;
```

See [How to compare two EnergyPlus
versions](https://js.idfkit.com/how-to/compare-versions/).

### Shared identity

Definitions are frozen and shared by identity across every version that has the
same hash:

```ts
const a = await bundle.load('25.2.0');
const b = await bundle.load('26.1.0');
a.get('Zone') === b.get('Zone'); // true
```

`@idfkit/core` uses that to give both versions the same object prototype, so
mixed-version work stays monomorphic.

## What is in the slim format

Everything needed to parse, write, validate, and resolve references: field order,
storage class, reference lists, choice values, defaults, bounds, units,
extensible groups, singleton and anonymous flags.

Deliberately dropped: `note`, `memo`, `ip-units`, and `field_info`. That is
documentation metadata and most of the weight, and it is on the critical path of
every parse. Tooling that renders documentation should read the source schemas.

Keys are single letters because this file is parsed on every cold start. The full
key-by-key description is in [Slim schema
format](https://js.idfkit.com/reference/slim-schema-format/).

## Regenerating

See [CONTRIBUTING.md](../../CONTRIBUTING.md#regenerating-the-schema-bundle).
Hashes are computed from a canonical serialization and must stay stable across
rebuilds.
