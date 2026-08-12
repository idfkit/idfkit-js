import type { IdfObject } from './object.js';

/** One field of one object pointing at a name. */
export interface ReferenceEdge {
  readonly from: IdfObject;
  readonly field: string;
  readonly target: string;
  /**
   * Repeat index, when the field lives inside an extensible group. Absent for
   * ordinary positional fields, which is what distinguishes the two.
   */
  readonly index?: number;
}

/**
 * Live index of every name-to-name reference in a document.
 *
 * Kept current by the document as objects are added, removed, renamed, and
 * edited, so `referencing()` is a lookup rather than a scan. EnergyPlus models
 * are dense with references (every surface names a zone and a construction,
 * every construction names materials), and the rename-propagation behaviour
 * that makes the library useful depends on this being exact.
 *
 * Names are matched case-insensitively, because EnergyPlus resolves them that
 * way, but the original casing is preserved for round-tripping.
 */
export class ReferenceGraph {
  /** lowercased target name -> edges pointing at it. */
  #incoming = new Map<string, Set<ReferenceEdge>>();
  /** object -> edges originating from it. */
  #outgoing = new Map<IdfObject, Set<ReferenceEdge>>();

  /** Record that `obj.field` points at `target`. */
  add(obj: IdfObject, field: string, target: string, index?: number): void {
    if (target === '') return;
    const edge: ReferenceEdge = Object.freeze({ from: obj, field, target, index });

    const key = target.toLowerCase();
    let incoming = this.#incoming.get(key);
    if (incoming === undefined) {
      incoming = new Set();
      this.#incoming.set(key, incoming);
    }
    incoming.add(edge);

    let outgoing = this.#outgoing.get(obj);
    if (outgoing === undefined) {
      outgoing = new Set();
      this.#outgoing.set(obj, outgoing);
    }
    outgoing.add(edge);
  }

  /** Index every reference field of an object at once. */
  addObject(obj: IdfObject): void {
    for (const { field, target, index } of obj.outgoingReferences()) {
      this.add(obj, field, target, index);
    }
  }

  /** Drop every edge originating from an object. */
  removeObject(obj: IdfObject): void {
    const outgoing = this.#outgoing.get(obj);
    if (outgoing === undefined) return;
    for (const edge of outgoing) {
      const key = edge.target.toLowerCase();
      const incoming = this.#incoming.get(key);
      if (incoming === undefined) continue;
      incoming.delete(edge);
      if (incoming.size === 0) this.#incoming.delete(key);
    }
    this.#outgoing.delete(obj);
  }

  /** Update the edge for a single field after its value changed. */
  updateField(obj: IdfObject, field: string, previous: unknown, next: unknown): void {
    if (typeof previous === 'string' && previous !== '') {
      const key = previous.toLowerCase();
      const incoming = this.#incoming.get(key);
      const outgoing = this.#outgoing.get(obj);
      if (incoming !== undefined && outgoing !== undefined) {
        for (const edge of outgoing) {
          // `index !== undefined` marks an edge inside an extensible group.
          // Those are re-indexed wholesale, so a positional-field update must
          // not consume one that happens to share the field name.
          if (edge.field !== field || edge.index !== undefined) continue;
          outgoing.delete(edge);
          incoming.delete(edge);
          break;
        }
        if (incoming.size === 0) this.#incoming.delete(key);
      }
    }
    if (typeof next === 'string' && next !== '') this.add(obj, field, next);
  }

  /** Edges pointing at a name. */
  referencing(name: string): ReferenceEdge[] {
    const edges = this.#incoming.get(name.toLowerCase());
    return edges === undefined ? [] : [...edges];
  }

  /** Objects that reference a name, deduplicated. */
  referencingObjects(name: string): IdfObject[] {
    const seen = new Set<IdfObject>();
    for (const edge of this.referencing(name)) seen.add(edge.from);
    return [...seen];
  }

  /** Names an object points at. */
  referencedBy(obj: IdfObject): string[] {
    const edges = this.#outgoing.get(obj);
    return edges === undefined ? [] : [...new Set([...edges].map((e) => e.target))];
  }

  /** Whether anything points at this name. */
  isReferenced(name: string): boolean {
    return (this.#incoming.get(name.toLowerCase())?.size ?? 0) > 0;
  }

  /**
   * Rewrite every edge pointing at `previous` to point at `next`.
   *
   * Only updates the index. The document is responsible for writing the new
   * value into the referencing objects' fields, which it does without going
   * back through the setter hook to avoid re-entering this method.
   */
  retarget(previous: string, next: string): ReferenceEdge[] {
    const key = previous.toLowerCase();
    const edges = this.#incoming.get(key);
    if (edges === undefined) return [];

    const affected = [...edges];
    this.#incoming.delete(key);

    for (const edge of affected) {
      this.#outgoing.get(edge.from)?.delete(edge);
    }
    for (const edge of affected) {
      this.add(edge.from, edge.field, next, edge.index);
    }
    return affected;
  }

  /** Edges whose target does not exist. `valid` holds lowercased names. */
  dangling(valid: ReadonlySet<string>): ReferenceEdge[] {
    const out: ReferenceEdge[] = [];
    for (const [key, edges] of this.#incoming) {
      if (valid.has(key)) continue;
      out.push(...edges);
    }
    return out;
  }

  clear(): void {
    this.#incoming.clear();
    this.#outgoing.clear();
  }

  get size(): number {
    let total = 0;
    for (const edges of this.#incoming.values()) total += edges.size;
    return total;
  }
}
