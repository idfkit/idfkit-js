// Preamble, not shown on the page: the document the page's earlier step parsed.
import type { IdfDocument } from '@idfkit/core';
import { getScene } from '@idfkit/geometry';
declare const document: IdfDocument;

// --8<-- [start:example]
// One argument, one return value, no options. Reading touches no disk and does
// not modify the document: writing it out before and after yields the same bytes.
const scene = getScene(document);

for (const surface of scene.surfaces) {
  // objectType with name is the address. A name alone is not unique across
  // types, so a consumer that stored only the name has to search to get back.
  console.log(surface.objectType, surface.name, surface.zone);

  // The vertices are already in the frame the engine computes. Nothing here
  // has to be offset by a zone origin or turned by a north axis afterwards.
  for (const vertex of surface.polygon.vertices) {
    console.log(vertex.x, vertex.y, vertex.z);
  }

  console.log(surface.area, surface.normal);
}
// --8<-- [end:example]

export { scene };
