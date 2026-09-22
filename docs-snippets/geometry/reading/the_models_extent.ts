// Preamble, not shown on the page: the scene the page's first step resolved.
import type { Scene } from '@idfkit/geometry';
declare const scene: Scene;

// --8<-- [start:example]
const bounds = scene.bounds;

// Absent rather than zero when nothing was placed, so an empty model and a model
// sitting on the origin are distinguishable.
if (bounds === undefined) {
  console.log('nothing resolved');
} else {
  console.log(bounds.min.x, bounds.min.y, bounds.min.z);
  console.log(bounds.max.x, bounds.max.y, bounds.max.z);

  const centreX = (bounds.min.x + bounds.max.x) / 2;
  const centreY = (bounds.min.y + bounds.max.y) / 2;
  console.log(centreX, centreY);
}
// --8<-- [end:example]

export { bounds };
