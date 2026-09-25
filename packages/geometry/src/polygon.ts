/**
 * The three-dimensional polygon: a ring of vertices and the quantities read off it.
 *
 * The counterpart of `Polygon3D` in `idfkit/src/idfkit/geometry.py`, registered as aligned at
 * rename count zero. The register records that the two predicates are spelled `isHorizontal` and
 * `isVertical` here by the field-casing rule and that the rest of the members keep their names.
 *
 * Python spells the derived quantities as properties, so a reader writes `polygon.area`. The same
 * reading here is a getter rather than a method for the same reason: a polygon's area is a fact
 * about it, not an instruction to it.
 */

import { Vector3D } from './vector.js';

/** What `math.degrees` multiplies by, computed once here as it is there. See `vector.ts`. */
const RADIANS_TO_DEGREES = 180 / Math.PI;

/** A closed ring of vertices in one frame. Immutable: every transformation returns a new polygon. */
export class Polygon3D {
  readonly vertices: readonly Vector3D[];

  constructor(vertices: readonly Vector3D[]) {
    this.vertices = [...vertices];
  }

  /** From coordinate triples, as an expectation file or a test states them. */
  static fromTuples(coords: readonly (readonly [number, number, number])[]): Polygon3D {
    return new Polygon3D(coords.map((coord) => Vector3D.fromTuple(coord)));
  }

  get numVertices(): number {
    return this.vertices.length;
  }

  /**
   * The surface normal, by Newell's method.
   *
   * Newell rather than the cross product of two edges, because a real model's polygon is not
   * reliably planar and Newell answers for the whole ring rather than for whichever two edges the
   * first three vertices happen to give.
   *
   * A ring of fewer than three vertices has no plane, and this answers `(0, 0, 1)` for it, as the
   * first language does. No resolved surface reaches that case: a surface with fewer than three
   * vertices is reported unresolved rather than placed.
   */
  get normal(): Vector3D {
    if (this.numVertices < 3) return new Vector3D(0, 0, 1);

    let x = 0;
    let y = 0;
    let z = 0;
    for (let at = 0; at < this.numVertices; at += 1) {
      const one = this.vertices[at] as Vector3D;
      const next = this.vertices[(at + 1) % this.numVertices] as Vector3D;
      x += (one.y - next.y) * (one.z + next.z);
      y += (one.z - next.z) * (one.x + next.x);
      z += (one.x - next.x) * (one.y + next.y);
    }
    return new Vector3D(x, y, z).normalize();
  }

  /**
   * The area, by triangulating from the first vertex and summing the cross products.
   *
   * Exact for a non-convex ring as well as a convex one, because the signed contributions cancel
   * on the reflex corners: an L returns 12 and a plus sign 45. **The triangles themselves are not,
   * and this is not a triangulation anyone may draw.** A fan from the first vertex emits triangles
   * outside a non-convex ring, which a signed sum absorbs and a renderer does not: it fills the
   * notch. Every polygon in the 26.1.0 example corpus with more than four vertices is non-convex,
   * 197 surfaces across 25 of 721 geometry-bearing files, so a consumer reusing this as a
   * triangulator draws those 197 wrong and everything else right, which is the hardest kind of
   * wrong to notice.
   *
   * A consumer needing triangles to draw with owns that decision, because it is a property of the
   * drawing device rather than of the model. The scene states a ring because the model states a
   * ring.
   */
  get area(): number {
    if (this.numVertices < 3) return 0;

    const first = this.vertices[0] as Vector3D;
    let total = Vector3D.origin();
    for (let at = 1; at < this.numVertices - 1; at += 1) {
      const one = (this.vertices[at] as Vector3D).subtract(first);
      const next = (this.vertices[at + 1] as Vector3D).subtract(first);
      total = total.add(one.cross(next));
    }
    return total.length() / 2;
  }

  /** The mean of the vertices, which is the anchor a rotation uses when it is given none. */
  get centroid(): Vector3D {
    if (this.numVertices === 0) return Vector3D.origin();

    let x = 0;
    let y = 0;
    let z = 0;
    for (const vertex of this.vertices) {
      x += vertex.x;
      y += vertex.y;
      z += vertex.z;
    }
    return new Vector3D(x / this.numVertices, y / this.numVertices, z / this.numVertices);
  }

  /**
   * The tilt in degrees: 0 facing up, 90 vertical, 180 facing down.
   *
   * The EnergyPlus convention, which is the angle between the outward normal and the vertical.
   */
  get tilt(): number {
    const up = this.normal.z;
    // Clamped because a normal computed in floating point can land a hair outside [-1, 1], where
    // `Math.acos` answers NaN.
    const clamped = Math.max(-1, Math.min(1, up));
    return Math.acos(clamped) * RADIANS_TO_DEGREES;
  }

  /**
   * The azimuth in degrees clockwise from north, which is the +y axis.
   *
   * Zero for a horizontal surface, whose azimuth is undefined rather than north.
   */
  get azimuth(): number {
    const normal = this.normal;
    if (Math.abs(normal.x) < 1e-10 && Math.abs(normal.y) < 1e-10) return 0;
    // `atan2(x, y)` measures from +y toward +x, which is clockwise from north exactly.
    const angle = Math.atan2(normal.x, normal.y) * RADIANS_TO_DEGREES;
    return angle < 0 ? angle + 360 : angle;
  }

  /** Whether this reads as a floor or a ceiling. */
  get isHorizontal(): boolean {
    return Math.abs(this.normal.z) > 0.99;
  }

  /** Whether this reads as a wall. */
  get isVertical(): boolean {
    return Math.abs(this.normal.z) < 0.01;
  }

  translate(offset: Vector3D): Polygon3D {
    return new Polygon3D(this.vertices.map((vertex) => vertex.add(offset)));
  }

  /** Turned about the vertical axis through `anchor`, or through the centroid when given none. */
  rotateZ(angleDeg: number, anchor?: Vector3D): Polygon3D {
    const about = anchor ?? this.centroid;
    return new Polygon3D(
      this.vertices.map((vertex) => vertex.subtract(about).rotateZ(angleDeg).add(about))
    );
  }

  asTupleList(): [number, number, number][] {
    return this.vertices.map((vertex) => vertex.asTuple());
  }
}
