# How to edit extensible groups

Some object types end in a section that repeats: the vertices of a surface, the
components of a branch, the zones in a zone list. In IDF those are just more
commas. Here they are a live array on the object.

## Read them

```ts
const surface = doc.require('BuildingSurface:Detailed', 'Wall-1');

surface.extensible.length; // number of vertices
surface.extensible[0]; // { vertex_x_coordinate: 0, vertex_y_coordinate: 0, ... }
```

Each entry is a plain object keyed by the group's field names, in IDF order. For
a type with no extensible section, `extensible` is an empty array.

## Add and remove

The array is live: mutating it mutates the object.

```ts
surface.extensible.push({
  vertex_x_coordinate: 0,
  vertex_y_coordinate: 0,
  vertex_z_coordinate: 3,
});

surface.extensible.splice(2, 1); // drop the third vertex
surface.extensible[0].vertex_z_coordinate = 3.5;
```

There is no `addVertex` or `setVertices`. It is an array, and the array methods
work.

## Replace the whole section

`extensible` is a getter with no setter, so assigning to it throws a
`TypeError`. Either mutate the array in place:

```ts
surface.extensible.splice(0, surface.extensible.length, ...vertices);
```

or assign to the underlying epJSON key, which is a real field accessor:

```ts
surface.vertices = [
  { vertex_x_coordinate: 0, vertex_y_coordinate: 0, vertex_z_coordinate: 3 },
  { vertex_x_coordinate: 0, vertex_y_coordinate: 0, vertex_z_coordinate: 0 },
  { vertex_x_coordinate: 5, vertex_y_coordinate: 0, vertex_z_coordinate: 0 },
];
```

The key differs by type — `vertices` here, something else elsewhere — and
`schema.get(typeName).x?.key` is where it comes from. The `splice` form does not
need to know it, which is usually the reason to prefer it.

## References inside a group are tracked

This is the part that is easy to assume does not work. `ZoneList`, `Branch`, and
the supply and return paths carry all of their references inside repeat groups,
and the reference graph indexes those too:

```ts
const list = doc.require('ZoneList', 'All Zones');
list.extensible.push({ zone_name: 'Open Office' });

doc.require('Zone', 'Open Office').name = 'Open Plan';
list.extensible[0].zone_name; // 'Open Plan'
```

A rename propagates into extensible groups exactly as it does into ordinary
fields. A graph that ignored them would make `rename()` silently produce a
broken model, which is why `ObjectShape` tracks `extensibleRefFields` separately
from `refFields` — they need the repeat index to be addressed.

## Fill in fields you are not setting

Groups are positional too. If a group has four fields and you set two, the
writer emits empty slots for the rest of that group, which is correct. But do not
leave a group _partially_ populated when you meant to skip it entirely: an empty
repeat in the middle of a section is a real, meaningful thing in IDF, and it is
preserved.

The related hazard is on the fixed fields before the group. When a type has an
extensible section, unset trailing fixed fields are **not** trimmed on write,
because trimming one would shift every group value a slot early. That is handled
for you; see [The hazards of a positional
format](../explanation/positional-format-hazards.md) for what it would otherwise
cost.

## Types are not generated for group fields

The generated interfaces cover the fixed fields. `extensible` is typed as
`ExtensibleGroup[]`, i.e. `Record<string, string | number>[]`, so field names
inside a group are not checked or completed. Get them from the schema:

```ts
doc.schema.get('BuildingSurface:Detailed').x?.fields;
// ['vertex_x_coordinate', 'vertex_y_coordinate', 'vertex_z_coordinate']
```
