import type { Manifest, SlimField, SlimType } from './types.js';

/**
 * A single EnergyPlus version's schema, backed by a shared blob store.
 *
 * Type definitions are hydrated lazily and cached in the store, so loading a
 * second version only pays for the definitions that version does not already
 * share with one in memory. In practice that is a couple hundred out of 858.
 */
export class Schema {
  readonly version: string;

  #manifest: Manifest;
  #store: BlobStore;
  #typeNames: string[] | undefined;
  /** Lowercased type name -> canonical type name, built on first lookup miss. */
  #lookup: Map<string, string> | undefined;

  constructor(version: string, manifest: Manifest, store: BlobStore) {
    this.version = version;
    this.#manifest = manifest;
    this.#store = store;
  }

  /** Canonical object type names, in schema order. */
  get typeNames(): readonly string[] {
    this.#typeNames ??= Object.keys(this.#manifest);
    return this.#typeNames;
  }

  /** Whether this version defines the given object type. Case-insensitive. */
  has(typeName: string): boolean {
    return this.resolve(typeName) !== undefined;
  }

  /**
   * Resolve a possibly mis-cased type name to its canonical spelling.
   *
   * IDF is case-insensitive on type names and real files are inconsistent
   * (`ZONE`, `Zone`, `zone` all appear in the wild), so every lookup path goes
   * through here rather than trusting the input.
   */
  resolve(typeName: string): string | undefined {
    if (Object.hasOwn(this.#manifest, typeName)) return typeName;
    this.#lookup ??= new Map(this.typeNames.map((n) => [n.toLowerCase(), n]));
    return this.#lookup.get(typeName.toLowerCase());
  }

  /** Definition for an object type, or undefined if this version lacks it. */
  get(typeName: string): SlimType | undefined {
    const canonical = this.resolve(typeName);
    if (canonical === undefined) return undefined;
    return this.#store.hydrate(this.#manifest[canonical]!);
  }

  /** Definition for an object type, throwing if absent. */
  require(typeName: string): SlimType {
    const type = this.get(typeName);
    if (type === undefined) {
      throw new Error(`Object type "${typeName}" is not defined in EnergyPlus ${this.version}`);
    }
    return type;
  }

  /** Field definition for a type, or undefined. */
  field(typeName: string, fieldName: string): SlimField | undefined {
    return this.get(typeName)?.p[fieldName];
  }

  /**
   * Object type names whose definition hash differs from `other`.
   *
   * Because definitions are content-addressed this is a manifest comparison,
   * not a deep diff of two 10 MB documents, which is what makes cross-version
   * work (migration planning, "what changed in 25.2") cheap.
   */
  changedFrom(other: Schema): SchemaDelta {
    const mine = this.#manifest;
    const theirs = other.#manifest;
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];

    for (const name of Object.keys(mine)) {
      if (!Object.hasOwn(theirs, name)) added.push(name);
      else if (theirs[name] !== mine[name]) changed.push(name);
    }
    for (const name of Object.keys(theirs)) {
      if (!Object.hasOwn(mine, name)) removed.push(name);
    }
    return { added, removed, changed };
  }
}

export interface SchemaDelta {
  /** Types present in this version but not the other. */
  added: string[];
  /** Types present in the other version but not this one. */
  removed: string[];
  /** Types present in both, with a differing definition. */
  changed: string[];
}

/**
 * Shared, deduplicated store of object-type definitions.
 *
 * One instance is shared by every Schema loaded from the same bundle, which is
 * what makes multi-version documents in a single process cheap.
 */
export class BlobStore {
  #raw: Record<string, SlimType>;
  #hydrated = new Map<string, SlimType>();

  constructor(raw: Record<string, SlimType>) {
    this.#raw = raw;
  }

  hydrate(hash: string): SlimType {
    let cached = this.#hydrated.get(hash);
    if (cached === undefined) {
      const raw = this.#raw[hash];
      if (raw === undefined) throw new Error(`Schema blob ${hash} missing from bundle`);
      // Frozen because the same object is handed to every version that shares
      // this hash; a mutation would silently corrupt unrelated versions.
      cached = Object.freeze(raw);
      this.#hydrated.set(hash, cached);
    }
    return cached;
  }

  get size(): number {
    return Object.keys(this.#raw).length;
  }
}
