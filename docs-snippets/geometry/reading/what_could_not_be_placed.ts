// Preamble, not shown on the page: the scene the page's first step resolved.
import type { Scene } from '@idfkit/geometry';
declare const scene: Scene;

// --8<-- [start:example]
for (const item of scene.unresolved) {
  // The reason is an enumerated value, not a message, so grouping on it is
  // stable and a reworded string cannot change what a consumer does.
  console.log(item.objectType, item.name, item.reason);

  // 'zone-not-found' and 'parent-surface-not-found' also name what the object
  // pointed at and the model does not hold. The reason says how to group the
  // failure; this says which name to go and look for.
  if (item.missingReference !== undefined) {
    console.log('  names', item.missingReference);
  }
}
// --8<-- [end:example]
