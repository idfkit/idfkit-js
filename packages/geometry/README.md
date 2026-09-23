# @idfkit/geometry

Read-only geometry extraction for EnergyPlus models: where a model's surfaces
are, in one frame, without editing the model to find out.

Peer-depends on [`@idfkit/core`](../core) and on nothing else. Everything
exported here is synchronous, reads no files and holds no state, so it runs
unchanged in Node, a browser tab, a worker, or an edge runtime.

**[Documentation](https://js.idfkit.com/)** ·
[API reference](https://js.idfkit.com/reference/geometry/)

```bash
npm install @idfkit/geometry
```

## What it answers

```ts
import { parseIdf } from '@idfkit/core';
import { getScene } from '@idfkit/geometry';

const { document } = parseIdf(text, schema);
const scene = getScene(document);

for (const surface of scene.surfaces) {
  console.log(surface.objectType, surface.name, surface.area, surface.normal.asTuple());
}
```

`getScene` takes one argument and returns one value. The vertices it hands back
are already in the frame the engine computes: the zone origin and the zone
rotation are applied where the model declares the relative system, the building's
north axis turns the resolved building as one body, and a ring entered clockwise
is reversed so that the right-hand rule gives the outward normal.

The document is unchanged afterwards. Not "unchanged in the fields extraction
reads": unchanged. A preserving write before and after yields identical bytes,
which is what lets a caller resolve a model it is also editing.

## Nothing is dropped silently

Every geometry object in the model appears exactly once across three lists, and
there is no fourth outcome:

- `scene.surfaces`, the objects that were placed;
- `scene.unresolved`, the objects that could not be, each with an enumerated
  reason and, for the two that are a dangling reference, the name it pointed at;
- `scene.unattempted`, the geometry types this package does not read yet, each
  with a count, so a model stated in the simplified surface family looks
  different from a model with no geometry at all.

`scene.applied` reports the declarations resolution read and names the ones the
model left for it to assume. `scene.bounds` encloses the resolved vertices and is
absent rather than degenerate when nothing was placed.

Extraction never raises over a model's contents. Judging a model is validation's
job; this reports.

## Not here

Geometry **authoring** is not in this package. The builders, the transforms,
surface matching and zoning are a separate capability and land with the change
that ports them.

Reading this package is **not** installed by `@idfkit/idfkit`, and it is not
reachable through a subpath of the shared name. It is added by name, because a
consumer that never asks about geometry should not carry it.

## Versioning

This package joins the repository's release lockstep and peer-depends on
`@idfkit/core` at a caret range rather than an exact pin. It reads only core's
published object model, so a core that changed any of it would break here loudly
at the first call rather than quietly, and a patch of core should reach a
consumer without a release of this package.
