# Build your first model

By the end of this you will have built an EnergyPlus model in JavaScript from
nothing, seen the reference graph rewrite itself when you rename a zone, written
the model to an IDF file, and read it back.

It takes about fifteen minutes. You need Node 20 or newer and nothing else — no
EnergyPlus installation, no build step, no TypeScript configuration.

You do not need to know EnergyPlus. Where the model needs a number, this page
gives you one.

## Step 1: Set up a project

```bash
mkdir first-model
cd first-model
npm init -y
npm pkg set type=module
npm install @idfkit/core @idfkit/schemas
```

## Step 2: Create an empty model

Every model is bound to one EnergyPlus version, because field order genuinely
differs between releases. So the first thing to get is a schema.

Create `build-model.mjs`:

```js
import { IdfDocument } from '@idfkit/core';
import { schemas } from '@idfkit/core/node';

const schema = await schemas().load('26.1.0');
const doc = new IdfDocument(schema);

doc.add('Version', null, { version_identifier: '26.1' });

console.log('objects:', doc.size);
```

Run it:

```bash
node build-model.mjs
```

```
objects: 1
```

Two things to notice. `schemas()` returns the bundle that ships inside
`@idfkit/schemas`, holding all 17 EnergyPlus versions; loading one is the only
step in this whole tutorial that is asynchronous. And `Version` takes `null`
where the other objects will take a name, because it has no name field at all.

## Step 3: Add a zone

A zone is a volume of air EnergyPlus solves for. Add one, just above the
`console.log`:

```js
const zone = doc.add('Zone', 'Open Office', {
  ceiling_height: 2.7,
  multiplier: 1,
});
```

`add` returns the object, and its fields are ordinary properties. Add this at the
end of the file and run it again:

```js
console.log(zone.name, zone.ceiling_height);
```

```
objects: 2
Open Office 2.7
```

Those field names are the epJSON names, used exactly as the schema spells them:
`ceiling_height`, not `ceilingHeight`. If you are using an editor with
TypeScript support, it can complete all of them — that comes later, in
[Static types generated from the
schema](../explanation/generated-types.md).

## Step 4: Add a wall

A wall needs a construction, and a construction needs a material. Add all three,
after the zone:

```js
doc.add('Material', 'Brick 100mm', {
  roughness: 'MediumRough',
  thickness: 0.1,
  conductivity: 0.89,
  density: 1920,
  specific_heat: 790,
});

doc.add('Construction', 'Exterior Wall', {
  outside_layer: 'Brick 100mm',
});

const wall = doc.add('BuildingSurface:Detailed', 'North Wall', {
  surface_type: 'Wall',
  construction_name: 'Exterior Wall',
  zone_name: 'Open Office',
  outside_boundary_condition: 'Outdoors',
  sun_exposure: 'SunExposed',
  wind_exposure: 'WindExposed',
});
```

The wall has no shape yet. Its corners live in an _extensible group_ — a section
of the object that repeats — which is a live array you push to:

```js
wall.extensible.push(
  { vertex_x_coordinate: 0, vertex_y_coordinate: 0, vertex_z_coordinate: 2.7 },
  { vertex_x_coordinate: 0, vertex_y_coordinate: 0, vertex_z_coordinate: 0 },
  { vertex_x_coordinate: 5, vertex_y_coordinate: 0, vertex_z_coordinate: 0 },
  { vertex_x_coordinate: 5, vertex_y_coordinate: 0, vertex_z_coordinate: 2.7 }
);
```

That is a 5 m by 2.7 m wall, listed anticlockwise from the top left as
EnergyPlus expects.

## Step 5: Check the model hangs together

Three of those objects refer to each other by name: the wall names its
construction and its zone, the construction names its material. Replace the
`console.log` lines at the end with:

```js
console.log('objects:', doc.size);
console.log('dangling:', doc.danglingReferences());
```

```
objects: 5
dangling: []
```

An empty array means every name that is referred to actually exists. Change
`'Exterior Wall'` to `'Exteriar Wall'` in the wall and run it again to see what a
broken reference looks like, then change it back.

## Step 6: Rename the zone

This is the part worth slowing down for. Add to the end of the file:

```js
console.log('wall points at:', wall.zone_name);

zone.name = 'Open Plan';

console.log('after rename:  ', wall.zone_name);
console.log(
  'referencing Open Plan:',
  doc.references.referencingObjects('Open Plan').map((o) => o.name)
);
```

```
wall points at: Open Office
after rename:   Open Plan
referencing Open Plan: [ 'North Wall' ]
```

The wall's `zone_name` changed and you never touched it. Assigning to `.name`
went through a real property setter, and that setter moved the edge in the
document's reference graph, rewriting every field anywhere in the model that
pointed at the old name.

There is no `update()` to call and no index to rebuild, so there is nothing to
forget. Why it works this way is
[Why accessors and not a `Proxy`](../explanation/accessors-not-proxies.md).

## Step 7: Write it out

Add these two lines at the top of the file, next to the other imports:

```js
import { saveIdf } from '@idfkit/core/node';
```

and this at the very bottom:

```js
await saveIdf(doc, 'office.idf');
```

Run it once more, then look at what you made:

```bash
node build-model.mjs
cat office.idf
```

```idf
Zone,
    Open Plan,               !- Name
    ,                        !- Direction of Relative North
    ,                        !- X Origin
    ,                        !- Y Origin
    ,                        !- Z Origin
    ,                        !- Type
    1,                       !- Multiplier
    2.7;                     !- Ceiling Height
```

Your zone is called `Open Plan`, and so is the wall's `Zone Name` further down
the file.

Notice the empty fields you never set. IDF has no field names — the `!-`
comments are comments, and a value's meaning comes entirely from how many commas
precede it. Those blanks are holding positions open. It matters most on the
wall, where dropping one would shift every vertex coordinate into the wrong slot;
[The hazards of a positional
format](../explanation/positional-format-hazards.md) is the long version.

## Step 8: Read it back

New file, `read-model.mjs`:

```js
import { loadIdf } from '@idfkit/core/node';

const doc = await loadIdf('office.idf');

console.log('version:', doc.version);
console.log('objects:', doc.size);

for (const zone of doc.all('Zone')) {
  console.log(`${zone.name}: ceiling ${zone.ceiling_height} m`);
}

const wall = doc.require('BuildingSurface:Detailed', 'North Wall');
console.log('vertices:', wall.extensible.length);
console.log('first vertex:', wall.extensible[0]);
```

```bash
node read-model.mjs
```

```
version: 26.1.0
objects: 5
Open Plan: ceiling 2.7 m
vertices: 4
first vertex: {
  vertex_x_coordinate: 0,
  vertex_y_coordinate: 0,
  vertex_z_coordinate: 2.7
}
```

`loadIdf` read `Version, 26.1;` out of the file and resolved it to the bundled
`26.1.0` schema on its own. Collections are iterable, `require` throws if the
object is missing where `get` would return `undefined`, and the vertices came
back as the same array of objects you pushed.

## What you built

You created a model, connected four objects by name, renamed one and watched the
others follow, wrote real IDF, and parsed it back into the same five objects.

That is the whole object model. Everything else is more object types.

## Where to go next

- Turn on the [generated static
  types](../explanation/generated-types.md) so a misspelled field name becomes a
  compile error instead of a surprise.
- [Run a simulation](../how-to/run-a-simulation.md) with the model you just
  built.
- Browse the [how-to guides](../how-to/index.md) for the task you actually came
  here to do.
