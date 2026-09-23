// Preamble, not shown on the page: the scene the page's first step resolved.
import type { Scene } from '@idfkit/geometry';
declare const scene: Scene;

// --8<-- [start:example]
const applied = scene.applied;

// What the model stated, in the schema's spelling rather than the file's casing.
console.log(applied.coordinateSystem); // 'Relative' or 'World'
console.log(applied.vertexEntryDirection); // 'Counterclockwise' or 'Clockwise'
console.log(applied.startingVertexPosition); // 'UpperLeftCorner', and so on
console.log(applied.northAxis); // degrees, clockwise from true north

// Two conditions worth asking about directly, since both change the answer.
console.log(applied.isRelative, applied.isClockwise);

// Fields the model did not state, named rather than silently defaulted.
if (applied.defaulted.includes('north_axis')) {
  console.log('no Building north axis stated; resolution assumed 0');
}
// --8<-- [end:example]

export { applied };
