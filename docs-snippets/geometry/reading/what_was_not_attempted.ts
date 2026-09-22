// Preamble, not shown on the page: the scene the page's first step resolved.
import type { Scene } from '@idfkit/geometry';
declare const scene: Scene;

// --8<-- [start:example]
// A model whose geometry is stated in a form this reads nothing of comes back
// with no surfaces and a populated unattempted, which is a different answer from
// a model that holds no geometry at all.
if (scene.surfaces.length === 0 && scene.unattempted.length > 0) {
  for (const entry of scene.unattempted) {
    console.log(`${entry.objectType}: ${entry.count} not read`);
  }
}

// Everything is accounted for: resolved, unresolved with a reason, or of a type
// recorded as unattempted. There is no fourth outcome and nothing is dropped.
const total =
  scene.surfaces.length +
  scene.unresolved.length +
  scene.unattempted.reduce((sum, entry) => sum + entry.count, 0);
console.log(total);
// --8<-- [end:example]

export { total };
