import type { FieldValues, IdfObject } from './object.js';

/**
 * What a collection creates objects through: its document.
 *
 * An interface rather than an import of `IdfDocument`, which imports this module.
 * @internal
 */
export interface CollectionOwner {
  createIn(collection: IdfCollection, name: string | null, values: FieldValues): IdfObject;
}

/**
 * Name-indexed collection of objects of one type.
 *
 * Iterable, so `for (const zone of doc.all('Zone'))` works, and array-like
 * enough that `[...collection]`, `.map`, `.filter` read naturally. Lookup by
 * name is O(1) and case-insensitive, matching EnergyPlus semantics.
 *
 * Insertion order is preserved. IDF files are hand-edited and diffed, so
 * reordering objects on a round-trip would produce noisy diffs for no reason.
 *
 * `V` is what {@link IdfCollection.add} accepts. A typed document's `all()`
 * sets it to the exact field interface, so a misspelled field is a compile
 * error there exactly as it is through `IdfDocument.add`; everywhere else it is
 * the permissive `FieldValues`.
 */
export class IdfCollection<
  T extends IdfObject = IdfObject,
  V extends object = FieldValues,
> implements Iterable<T> {
  readonly typeName: string;

  /** lowercased collection key -> object. */
  #byName = new Map<string, T>();

  /** The document `add` creates through; `undefined` for one constructed directly. */
  #owner: CollectionOwner | undefined;

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

  /**
   * Create an object of this collection's type and add it to the document.
   *
   * Shorthand for `doc.add(collection.typeName, name, values)`, and it is that
   * call: the same schema resolution, duplicate and singleton checks, and
   * reference-graph update, with the same typing. `doc.add` is not deprecated
   * and stays the primary form; this one reads better when a typed collection
   * is already in hand.
   *
   * ```ts
   * const zones = doc.all('Zone');
   * const office = zones.add('Office', { ceiling_height: 3 });
   * doc.all('Version').add(null, { version_identifier: '26.1' });
   * ```
   *
   * Anonymous types (`Version`, `Timestep`) take `null` for the name.
   *
   * A type with no objects yet reads as an empty collection the document does
   * not store, since reading never adds to a document. Adding through it stores
   * it, so `zones` above holds `Office` and is the collection a later
   * `doc.all('Zone')` returns. If the type was stored meanwhile through another
   * path, the object goes to the document's collection instead.
   *
   * @throws TypeError if the collection belongs to no document, as one
   *   constructed directly with `new IdfCollection(...)` does.
   */
  add(name: string | null, values: V = {} as V): T {
    if (this.#owner === undefined) {
      throw new TypeError(
        `IdfCollection(${this.typeName}) belongs to no document (constructed directly); use IdfDocument.add`
      );
    }
    // `this` widened: `V` is a field interface, not `FieldValues`, on a typed collection.
    return this.#owner.createIn(this as unknown as IdfCollection, name, values as FieldValues) as T;
  }

  // --- mutation, used by IdfDocument -------------------------------------

  /**
   * An empty collection that creates objects through `owner`.
   * @internal
   */
  static owned(typeName: string, owner: CollectionOwner): IdfCollection {
    const collection = new IdfCollection(typeName);
    collection.#owner = owner;
    return collection;
  }

  /**
   * Whether `owner` is the document this collection creates through.
   * @internal
   */
  ownedBy(owner: CollectionOwner): boolean {
    return this.#owner === owner;
  }

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
