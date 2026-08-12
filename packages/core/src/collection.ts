import type { IdfObject } from './object.js';

/**
 * Name-indexed collection of objects of one type.
 *
 * Iterable, so `for (const zone of doc.all('Zone'))` works, and array-like
 * enough that `[...collection]`, `.map`, `.filter` read naturally. Lookup by
 * name is O(1) and case-insensitive, matching EnergyPlus semantics.
 *
 * Insertion order is preserved. IDF files are hand-edited and diffed, so
 * reordering objects on a round-trip would produce noisy diffs for no reason.
 */
export class IdfCollection<T extends IdfObject = IdfObject> implements Iterable<T> {
  readonly typeName: string;

  /** lowercased collection key -> object. */
  #byName = new Map<string, T>();

  constructor(typeName: string, objects: Iterable<T> = []) {
    this.typeName = typeName;
    for (const obj of objects) this.#byName.set(obj.key.toLowerCase(), obj);
  }

  get size(): number {
    return this.#byName.size;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.#byName.values();
  }

  /** Look up by name, case-insensitively. */
  get(name: string): T | undefined {
    return this.#byName.get(name.toLowerCase());
  }

  /** Look up by name, throwing if absent. */
  require(name: string): T {
    const obj = this.get(name);
    if (obj === undefined) {
      throw new Error(`No ${this.typeName} named "${name}"`);
    }
    return obj;
  }

  has(name: string): boolean {
    return this.#byName.has(name.toLowerCase());
  }

  /** The only object of this type, for singletons like `Building`. */
  get only(): T | undefined {
    if (this.#byName.size !== 1) return undefined;
    return this.#byName.values().next().value;
  }

  /** The first object, in insertion order. */
  get first(): T | undefined {
    return this.#byName.values().next().value;
  }

  names(): string[] {
    return [...this.#byName.values()].map((obj) => obj.name);
  }

  toArray(): T[] {
    return [...this.#byName.values()];
  }

  filter(predicate: (obj: T, index: number) => boolean): T[] {
    return this.toArray().filter(predicate);
  }

  map<R>(fn: (obj: T, index: number) => R): R[] {
    return this.toArray().map(fn);
  }

  find(predicate: (obj: T, index: number) => boolean): T | undefined {
    return this.toArray().find(predicate);
  }

  /** Objects whose `field` equals `value`, compared case-insensitively. */
  where(field: string, value: string): T[] {
    const needle = value.toLowerCase();
    return this.filter((obj) => {
      const actual = obj.get(field);
      return typeof actual === 'string' && actual.toLowerCase() === needle;
    });
  }

  // --- mutation, used by IDFDocument -------------------------------------

  /** @internal */
  insert(obj: T): void {
    this.#byName.set(obj.key.toLowerCase(), obj);
  }

  /** @internal */
  delete(name: string): boolean {
    return this.#byName.delete(name.toLowerCase());
  }

  /**
   * Re-key an object after a rename, preserving insertion order.
   *
   * A plain delete-then-insert would move the object to the end of the
   * collection, which shows up as a spurious reordering when the document is
   * written back out.
   * @internal
   */
  rekey(previous: string, next: string): void {
    const entries = [...this.#byName.entries()];
    this.#byName.clear();
    const previousKey = previous.toLowerCase();
    for (const [key, obj] of entries) {
      this.#byName.set(key === previousKey ? next.toLowerCase() : key, obj);
    }
  }
}
