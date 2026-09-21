/**
 * `@idfkit/geometry` — read-only geometry extraction for EnergyPlus models.
 *
 * `getScene(document)` resolves a model's surfaces into one frame and hands back what it placed,
 * what it could not place, and what it did not attempt. It modifies nothing and reads nothing from
 * disk, so it runs unchanged in Node, a browser, a worker or an edge runtime.
 *
 * Geometry AUTHORING is not here. The builders, the transforms, surface matching and zoning are a
 * separate capability, registered under the same reserved package and landed by the change that
 * ports them.
 */

export { Vector3D } from './vector.js';
export { Polygon3D } from './polygon.js';
export { getScene } from './scene.js';
export type {
  AppliedRules,
  ResolvedSurface,
  Scene,
  SceneBounds,
  UnattemptedType,
  UnresolvedObject,
} from './scene.js';
