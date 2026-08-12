# @idfkit/core

EnergyPlus IDF and epJSON parsing and manipulation for JavaScript.

Zero runtime dependencies apart from [`@idfkit/schemas`](../schemas). The main
entry point is synchronous and free of I/O, so it runs unchanged in Node, a
browser, a worker, or an edge runtime.

```bash
npm install @idfkit/core @idfkit/schemas
```

## Entry points

| Import                     | Contents                                                 | Environment |
| -------------------------- | -------------------------------------------------------- | ----------- |
| `@idfkit/core`             | Parsing, writing, the object model. Synchronous, no I/O. | Anywhere    |
| `@idfkit/core/node`        | `loadIdf`, `saveIdf`, schema discovery from disk         | Node        |
| `@idfkit/core/types/v26-1` | Generated interfaces and `TypeMap` for one version       | Types only  |

## Usage

```ts
import { loadIdf, saveIdf } from '@idfkit/core/node';
import type { TypeMap } from '@idfkit/core/types/v26-1';

const doc = await loadIdf<TypeMap>('model.idf');

// Collections are iterable and indexed by name (case-insensitive, O(1)).
const zones = doc.all('Zone');
zones.size;
zones.get('SPACE1-1')?.ceiling_height;
zones.map((z) => z.name);

// Surfaces on a zone, via the reference graph rather than a scan.
doc.references.referencingObjects('SPACE1-1');

// Creating objects.
const zone = doc.add('Zone', 'Open Office', { ceiling_height: 2.7, multiplier: 1 });

// Extensible groups are a live array.
const surface = doc.add('BuildingSurface:Detailed', 'Wall-1', {
  surface_type: 'Wall',
  zone_name: 'Open Office',
});
surface.extensible.push({
  vertex_x_coordinate: 0,
  vertex_y_coordinate: 0,
  vertex_z_coordinate: 3,
});

// Renaming rewrites every field elsewhere that pointed at the old name.
zone.name = 'Open Plan';
surface.zone_name; // 'Open Plan'

await saveIdf(doc, 'out.idf');
```

### Without a filesystem

```ts
import { parseIdf, writeIdf, SchemaBundle, httpSource } from '@idfkit/core';

const bundle = new SchemaBundle(httpSource('/schemas/'));
const schema = await bundle.load('26.1.0');

const { document, diagnostics } = parseIdf(text, schema, { strict: false });
const output = writeIdf(document);
```

### Diagnostics

`strict: true` (the default) throws an `IdfParseError` on the first problem.
`strict: false` collects diagnostics and keeps going, which is what an editor or
a batch job wants:

```ts
const { document, diagnostics } = parseIdf(text, schema, { strict: false });
for (const d of diagnostics) {
  console.warn(`${d.line}: ${d.message}`);
}
```

## API

### `IDFDocument<M>`

| Member                                    | Description                                                   |
| ----------------------------------------- | ------------------------------------------------------------- |
| `all(type)`                               | Collection for a type. Creates an empty one if absent.        |
| `get(type, name)` / `require(type, name)` | One object; `require` throws.                                 |
| `add(type, name, values?)`                | Create and attach. `name` may be `null` for anonymous types.  |
| `attach(obj)` / `remove(obj)`             | Move a detached object in, or take one out.                   |
| `rename(obj, next)`                       | Rename with reference propagation. Same as `obj.name = next`. |
| `objects()`                               | Generator over every object.                                  |
| `references`                              | The live `ReferenceGraph`.                                    |
| `danglingReferences()`                    | Edges whose target does not exist.                            |
| `toJSON()`                                | epJSON representation.                                        |

`M` is an optional generated type map. Omit it and everything still works, just
untyped.

### `IdfObject`

Fields are real properties. `obj.get(field)` and `obj.set(field, value)` are the
untyped equivalents, for version-generic code.

| Member                 | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `name`                 | The name as written. Assigning renames and propagates. |
| `typeName`, `schema`   | Canonical type name and its schema definition.         |
| `extensible`           | Live array of repeat groups.                           |
| `update(values)`       | Apply several fields at once.                          |
| `clone(name?)`         | Detached deep copy.                                    |
| `outgoingReferences()` | Fields that point at other objects.                    |

### `IdfCollection`

Iterable. `get`, `require`, `has`, `names`, `toArray`, `filter`, `map`, `find`,
`where(field, value)`, `first`, `only`, `size`.

## Notes

Field names are epJSON names (`zone_name`), not the space-separated IDD labels.

Numeric fields holding `Autosize` or `Autocalculate` stay as strings; the
generated types reflect that with `number | 'Autosize' | 'Autocalculate'`.

Writing does not preserve source formatting. `3.0` comes back as `3`, since
JavaScript has one number type and the distinction is gone once parsed. The
models are semantically identical and EnergyPlus reads both, but a textual diff
will show those fields.

See the [repository README](../../README.md) for the design rationale.
