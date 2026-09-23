/**
 * The three-dimensional vector, and the arithmetic the resolution rule needs.
 *
 * The counterpart of `Vector3D` in `idfkit/src/idfkit/geometry.py`, registered as aligned at
 * rename count zero before either side was written. `3D` is a numeral and a letter rather than an
 * acronym, so the casing rule that splits `IDFObject` from `IdfObject` does not apply and the two
 * names are identical.
 *
 * Python spells this arithmetic with operators, which JavaScript has no way to overload. The method
 * names here are the operations' ordinary English names rather than transliterations of `__add__`,
 * and the values they compute are identical.
 */

/** What `math.radians` multiplies by, computed once here as it is there. */
const DEGREES_TO_RADIANS = Math.PI / 180;

/** One point or direction in the model's frame. Immutable: every operation returns a new vector. */
export class Vector3D {
  readonly x: number;
  readonly y: number;
  readonly z: number;

  constructor(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  /** The zero vector, which is the world origin. */
  static origin(): Vector3D {
    return new Vector3D(0, 0, 0);
  }

  /** From a triple, as an expectation file or a test states one. */
  static fromTuple(values: readonly [number, number, number]): Vector3D {
    return new Vector3D(values[0], values[1], values[2]);
  }

  add(other: Vector3D): Vector3D {
    return new Vector3D(this.x + other.x, this.y + other.y, this.z + other.z);
  }

  subtract(other: Vector3D): Vector3D {
    return new Vector3D(this.x - other.x, this.y - other.y, this.z - other.z);
  }

  scale(factor: number): Vector3D {
    return new Vector3D(this.x * factor, this.y * factor, this.z * factor);
  }

  divide(divisor: number): Vector3D {
    return new Vector3D(this.x / divisor, this.y / divisor, this.z / divisor);
  }

  negate(): Vector3D {
    return new Vector3D(-this.x, -this.y, -this.z);
  }

  dot(other: Vector3D): number {
    return this.x * other.x + this.y * other.y + this.z * other.z;
  }

  cross(other: Vector3D): Vector3D {
    return new Vector3D(
      this.y * other.z - this.z * other.y,
      this.z * other.x - this.x * other.z,
      this.x * other.y - this.y * other.x
    );
  }

  /** The magnitude, by `Math.hypot`, which is Python's `math.hypot` and does not overflow. */
  length(): number {
    return Math.hypot(this.x, this.y, this.z);
  }

  /** The unit vector in the same direction, and the zero vector for the zero vector. */
  normalize(): Vector3D {
    const magnitude = this.length();
    if (magnitude === 0) return new Vector3D(0, 0, 0);
    return this.divide(magnitude);
  }

  /**
   * Turned about the vertical axis, counter-clockwise seen from above, in degrees.
   *
   * The engine measures its own north axis the other way round, which is why the resolution negates
   * the angle before calling this rather than this function turning the other way.
   */
  rotateZ(angleDeg: number): Vector3D {
    // `angleDeg * (PI / 180)`, not `(angleDeg * PI) / 180`. The two differ in the last bit, and
    // the first is what `math.radians` computes, so the two libraries resolve a rotated model to
    // the same doubles rather than to doubles that agree to within a tolerance.
    const radians = angleDeg * DEGREES_TO_RADIANS;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return new Vector3D(this.x * cos - this.y * sin, this.x * sin + this.y * cos, this.z);
  }

  /**
   * Whether two vectors hold the same three numbers.
   *
   * Python compares two frozen dataclasses with `==` and gets this for nothing. JavaScript compares
   * object identity, so the comparison has to be written, and a caller who omits it silently gets
   * the answer `false` for two equal vectors.
   */
  equals(other: Vector3D): boolean {
    return this.x === other.x && this.y === other.y && this.z === other.z;
  }

  asTuple(): [number, number, number] {
    return [this.x, this.y, this.z];
  }

  toString(): string {
    return `Vector3D(x=${this.x}, y=${this.y}, z=${this.z})`;
  }
}
