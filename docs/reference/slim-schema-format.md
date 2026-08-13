# Slim schema format

`@idfkit/schemas` does not ship the raw epJSON schemas. It ships a reduced form
carrying everything needed to parse, write, and resolve references, with the
documentation metadata removed. This page describes that form; see
[Content-addressed schemas](../explanation/content-addressed-schemas.md) for why
it exists.

Keys are single letters. This file is parsed on every cold start, and in a
browser that start is a page load.

## Bundle layout

```
data/
  index.json.gz              versions, and the manifest file for each
  types.json.gz              every unique type definition, keyed by content hash
  manifest-26-1-0.json.gz    type name -> hash, for one version
  manifest-25-2-0.json.gz
  ...
```

`index.json` is `BundleIndex`: a `versions` array, oldest first, and a
`manifests` record mapping version string to manifest file name. A manifest is a
flat `Record<typeName, hash>`. `types.json` is a flat `Record<hash, SlimType>`,
shared by every version.

Files are gzipped and inflated by the source. `httpSource` uses
`DecompressionStream` so the payload stays around 1 MB regardless of whether the
server sets `Content-Encoding`.

## `SlimType`

One object type, e.g. `Zone`.

| Key    | Meaning                                                                  |
| ------ | ------------------------------------------------------------------------ |
| `f`    | All field names in IDF positional order, from `legacy_idd.fields`        |
| `p`    | Field definitions, keyed by epJSON field name                            |
| `r`    | Required field names                                                     |
| `nref` | Reference lists the object's _name_ contributes to                       |
| `nreq` | `1` when the name is required                                            |
| `s`    | `1` when the object is a singleton, e.g. `Version`, `Building`           |
| `anon` | `1` when the object has no name field at all, e.g. `GlobalGeometryRules` |
| `x`    | Extensible group definition, if the type has one                         |
| `g`    | IDD group, e.g. `Thermal Zones and Surfaces`                             |

`f` is the load-bearing one: IDF is positional, and this array is the only thing
that says which slot a value belongs to.

## `SlimField`

| Key    | Meaning                                                                      |
| ------ | ---------------------------------------------------------------------------- |
| `t`    | Storage class, see below                                                     |
| `auto` | `1` when the field accepts `Autosize` or `Autocalculate` as well as a number |
| `ol`   | Reference lists this field points _into_ — it is a foreign key               |
| `ref`  | Reference lists this field contributes _to_ — it is a key                    |
| `e`    | Permitted values, for a choice field                                         |
| `d`    | Schema default, applied on write when the field is absent                    |
| `min`  | Inclusive minimum                                                            |
| `max`  | Inclusive maximum                                                            |
| `xmin` | Exclusive minimum                                                            |
| `xmax` | Exclusive maximum                                                            |
| `u`    | SI units, e.g. `m`                                                           |
| `rc`   | `1` when the value is case-sensitive and must not be normalized              |

`ol` and `ref` together are what the [reference
graph](../explanation/index.md) is built from: `ref` says a name enters a list,
`ol` says a field reads from one.

## `FieldKind`

The `t` key. It records how a value must be formatted on the way back out, which
JavaScript cannot recover on its own — `3` and `3.0` are the same number at
runtime.

| Value   | Meaning                                       |
| ------- | --------------------------------------------- |
| `'a'`   | Alpha. Written verbatim.                      |
| `'n'`   | Real. Written with a decimal point preserved. |
| `'i'`   | Integer. Written without a decimal point.     |
| `'arr'` | Extensible array wrapper.                     |

## `SlimExtensible`

The `x` key on a type that has repeating field groups.

| Key      | Meaning                                                  |
| -------- | -------------------------------------------------------- |
| `key`    | epJSON key holding the array, e.g. `vertices`            |
| `fields` | Field names inside each repeat group, in IDF order       |
| `p`      | Definitions for the inner fields, from the array's items |

## What is dropped

`note`, `memo`, `ip-units`, and `field_info`. That is documentation metadata,
it is most of the weight, and it sits on the critical path of every parse.
Tooling that renders EnergyPlus documentation should read the source schemas
directly, or use [idfkit-docs](https://docs.idfkit.com).

## Reading a definition

```ts
import { localBundle } from '@idfkit/schemas/node';

const schema = await localBundle().load('26.1.0');

schema.resolve('ZONE'); // 'Zone' — IDF type names are case-insensitive
schema.get('Zone'); // the SlimType
schema.field('Zone', 'x_origin'); // { t: 'n', u: 'm', d: 0 }
```

Definitions are frozen and shared by identity across versions with the same
content hash, so they must not be mutated.
