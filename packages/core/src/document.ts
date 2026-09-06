import type { Schema, SlimType } from '@idfkit/schemas';

import { IdfCollection } from './collection.js';
import { DATA, KEY, NAME, OWNER, SHAPE, SOURCE } from './internal.js';
import { IdfObject, type FieldValues, type ObjectOwner, type StoredValue } from './object.js';
import { isUntouched, type PreservedSource } from './preserve/source.js';
import { ReferenceGraph } from './references.js';
import type { AnyTypeMap, ObjectOf, TypeNameOf, UntypedMap, ValuesOf } from './typemap.js';

/**
 * An EnergyPlus model.
 *
 * Holds collections keyed by object type, a live reference graph, and the
 * schema for one specific EnergyPlus version. Every document is bound to a
 * version at construction; there is no version-agnostic mode, because field
 * order and reference lists genuinely differ between releases.
 *
 * The optional `M` parameter attaches a generated type map, which makes field
 * access statically checked without changing anything at runtime. See
 * `typemap.ts`.
 */
export class IdfDocument<M extends AnyTypeMap = UntypedMap> implements ObjectOwner {
  readonly schema: Schema;

  #collections = new Map<string, IdfCollection>();
  #references = new ReferenceGraph();
  /** Objects with no name, or a blank one, get synthetic collection keys. */
  #anonCounter = 0;
  /** What a preserving read retained, or `undefined` for an ordinary read. */
  #source: PreservedSource | undefined;

  constructor(schema: Schema) {
    this.schema = schema;
  }

  /** EnergyPlus version this model targets, e.g. `"26.1.0"`. */
  get version(): string {
    return this.schema.version;
  }

  get references(): ReferenceGraph {
    return this.#references;
  }

  /**
   * The text this document was read from, when it was read with `preserveFormatting`.
   *
   * `undefined` after an ordinary read, which is how a consumer answers whether a write will
   * preserve: a save button that has to say "this will reformat your file" needs this and nothing
   * more. The anchoring behind it stays internal, because `scanIdf` already exports the layer.
   */
  get rawText(): string | undefined {
    return this.#source?.layer.text;
  }

  /**
   * Take the material a preserving read retained. Called once, by the readers.
   *
   * Not public: a retained source is a property of how a document was read, and attaching one
   * afterwards would let a caller claim a file the document did not come from.
   *
   * @internal
   */
  adoptSource(source: PreservedSource): void {
    this.#source = source;
  }

  /**
   * What a preserving read retained, for the writer.
   *
   * @internal
   */
  get preservedSource(): PreservedSource | undefined {
    return this.#source;
  }

  /** Object type names present in this document, in insertion order. */
  types(): string[] {
    return [...this.#collections.keys()];
  }

  /** Total object count across all types. */
  get size(): number {
    let total = 0;
    for (const collection of this.#collections.values()) total += collection.size;
    return total;
  }

  /**
   * Every object of one type.
   *
   * The type name is matched case-insensitively, because EnergyPlus matches it
   * that way: `all('zone')`, `all('ZONE')` and `all('Zone')` are one
   * collection, whatever casing the source file used. Every type-name-keyed
   * entry point resolves identically, so `get`, `require`, `has` and `remove`
   * cannot disagree with this one.
   *
   * When the document carries a generated type map, the argument completes
   * among that version's type names and the result is narrowed to the matching
   * field interface. Unknown names still work and simply stay untyped, which is
   * what version-generic code needs.
   *
   * ## Why an unknown type name returns empty rather than throwing
   *
   * `all('Zoen')` returns an empty collection. Throwing would catch the typo,
   * and it was weighed and rejected. `has()` must answer `false` rather than
   * throw, and an `all()` that throws where `has()` does not is two rules for
   * one question. The version-generic contract above depends on an unknown name
   * being answerable: code written against no particular release asks for types
   * that exist in some versions and not others, and that is not an error. And
   * `idfkit`, the Python library this API is unified with, cannot throw here at
   * all, because a document may carry no schema and then nothing distinguishes
   * a typo from a valid type; a rule that holds only when a schema happens to
   * be loaded is not one rule.
   *
   * The typo is caught on the paths that write, which can afford to be strict:
   * `add()` throws for a type in no schema, so does `attach()`, and the IDF and
   * epJSON parsers reject one. To ask the question directly, call
   * `document.schema.has(name)`.
   *
   * What this must never do, and no longer does, is *store* the empty
   * collection it hands back. A read that mutates the document is wrong on its
   * own terms: probing five misspelled names used to leave five junk keys in
   * `types()`, visible to every later iteration and to `toJSON`. The collection
   * returned for an absent type is detached from the document.
   *
   * `idfkit` resolves and declines to store on exactly the same terms, in
   * `IDFDocument.__getitem__`.
   */
  all<K extends TypeNameOf<M>>(type: K): IdfCollection<IdfObject & ObjectOf<M, K>> {
    return this.collection(type) as IdfCollection<IdfObject & ObjectOf<M, K>>;
  }

  /**
   * Untyped collection access, in-package only.
   *
   * The public `all()` is generic over the type map, which means the compiler
   * cannot verify calls made from inside this class or from the parsers, where
   * the type name is a runtime string. Those go through here instead, so the
   * single unavoidable cast lives in one place rather than at every call site.
   *
   * Not published. `all()` is the one public name for this concept, and it
   * already covers the version-generic case, because it accepts unknown type
   * names and returns them untyped. `stripInternal` keeps this out of the
   * built declarations, so no importer can reach a second name for one
   * operation.
   *
   * @internal
   */
  collection(type: string): IdfCollection {
    const canonical = this.schema.resolve(type) ?? type;
    return this.#collections.get(canonical) ?? new IdfCollection(canonical);
  }

  /**
   * The stored collection a type's objects are filed under, created if absent.
   *
   * The only path that may add a key to `#collections`. Reads go through
   * `collection()`, which hands back a detached empty rather than growing the
   * document; see the note on `all()` for why that separation exists.
   */
  #collectionForWrite(canonical: string): IdfCollection {
    let collection = this.#collections.get(canonical);
    if (collection === undefined) {
      collection = new IdfCollection(canonical);
      this.#collections.set(canonical, collection);
    }
    return collection;
  }

  /** One object by type and name. */
  get<K extends TypeNameOf<M>>(type: K, name: string): (IdfObject & ObjectOf<M, K>) | undefined {
    return this.collection(type).get(name) as (IdfObject & ObjectOf<M, K>) | undefined;
  }

  /** One object by type and name, throwing if absent. */
  require<K extends TypeNameOf<M>>(type: K, name: string): IdfObject & ObjectOf<M, K> {
    return this.collection(type).require(name) as IdfObject & ObjectOf<M, K>;
  }

  /** Whether any object of this type exists. */
  has(type: string): boolean {
    return (this.#collections.get(this.schema.resolve(type) ?? type)?.size ?? 0) > 0;
  }

  /**
   * Create an object and attach it to the document.
   *
   * Anonymous types (`Version`, `Timestep`) take `null` for the name and get a
   * synthetic key that never appears in output.
   */
  add<K extends TypeNameOf<M>>(
    type: K,
    name: string | null,
    values: ValuesOf<M, K> = {} as ValuesOf<M, K>
  ): IdfObject & ObjectOf<M, K> {
    return this.addRaw(type, name, values as FieldValues) as IdfObject & ObjectOf<M, K>;
  }

  /**
   * Untyped object creation, for the parsers.
   *
   * They work from runtime strings, so the compiler cannot check them against
   * the type map. Same reasoning as the in-package collection accessor: one
   * deliberate seam rather than casts scattered through the parse loop.
   */
  addRaw(type: string, name: string | null, values: FieldValues = {}): IdfObject {
    const canonical = this.schema.resolve(type);
    if (canonical === undefined) {
      throw new Error(`Object type "${type}" is not defined in EnergyPlus ${this.version}`);
    }
    const definition = this.schema.require(canonical);
    const collection = this.collection(canonical);

    const key = name ?? ` anon:${this.#anonCounter++}`;
    if (name !== null && collection.has(name)) {
      throw new Error(`A ${canonical} named "${name}" already exists`);
    }
    if (definition.s === 1 && collection.size > 0) {
      throw new Error(`${canonical} is a singleton and is already present`);
    }

    const obj = IdfObject.create(canonical, definition, name ?? '', values);
    obj[KEY] = key;
    this.attach(obj);
    return obj;
  }

  /**
   * Attach an existing detached object, e.g. one produced by `clone()`.
   *
   * Repeats the checks `addRaw` makes rather than trusting the object. An
   * object carries its own schema definition, so one cloned out of a document
   * on a different EnergyPlus version would otherwise be written using that
   * version's field order under this document's `Version` header, which
   * mis-maps every field on reload instead of failing.
   */
  attach(obj: IdfObject): IdfObject {
    if (obj[OWNER] !== undefined && obj[OWNER] !== this) {
      throw new Error(`${obj} already belongs to another document`);
    }
    const canonical = this.schema.resolve(obj.typeName);
    if (canonical === undefined) {
      throw new Error(`Object type "${obj.typeName}" is not defined in EnergyPlus ${this.version}`);
    }
    const definition = this.schema.require(canonical);
    if (definition !== obj.schema && !sameLayout(definition, obj.schema)) {
      throw new Error(
        `${canonical} was built against a different schema than EnergyPlus ${this.version} defines`
      );
    }

    const collection = this.#collectionForWrite(canonical);
    if (collection.get(obj.key) === obj) return obj;
    if (definition.s === 1 && collection.size > 0) {
      throw new Error(`${canonical} is a singleton and is already present`);
    }
    if (obj.name === '') {
      obj[KEY] = ` anon:${this.#anonCounter++}`;
    } else if (collection.has(obj.key)) {
      throw new Error(`A ${obj.typeName} named "${obj.name}" already exists`);
    }
    collection.insert(obj);
    obj[OWNER] = this;
    // New to this document, whatever it carried before. Belt and braces beside the identity check
    // in `isUntouched`, which catches the same thing.
    obj[SOURCE] = undefined;
    this.#references.addObject(obj);
    return obj;
  }

  /** Remove an object. Does not touch objects that referenced it. */
  remove(obj: IdfObject): boolean {
    // Canonicalized like every other collection access: `attach()` files the
    // object under the schema's spelling, so a mis-cased `typeName` (IDF type
    // names are case-insensitive, and `IdfObject.create` is public) would look
    // in a collection that does not exist and report the object as absent while
    // leaving it in the document.
    const collection = this.#collections.get(this.schema.resolve(obj.typeName) ?? obj.typeName);
    if (collection === undefined || collection.get(obj.key) !== obj) return false;
    collection.delete(obj.key);
    this.#references.removeObject(obj);
    obj[OWNER] = undefined;
    return true;
  }

  /**
   * Rename an object and rewrite every reference to it.
   *
   * Equivalent to assigning `obj.name`.
   */
  rename(obj: IdfObject, next: string): void {
    if (obj[OWNER] !== this) {
      throw new Error(`${obj} does not belong to this document`);
    }
    this.onNameChanged(obj, obj.name, next);
  }

  /** Every object in the document, grouped by type in insertion order. */
  *objects(): Generator<IdfObject> {
    for (const collection of this.#collections.values()) yield* collection;
  }

  /**
   * Every object a preserving write will write afresh rather than reproduce.
   *
   * Empty for a document read with `preserveFormatting` and not edited since. Every object for a
   * document read without it, because there is nothing to reproduce.
   *
   * `rawText` answers whether a write will preserve at all. This answers how much of the file it
   * will change, which is what a save button has to put to a user out loud, and it is the part a
   * consumer cannot work out for itself: a rename clears the record on every object that referred
   * to the renamed one, so counting from your own edit log reports one where the answer is nine.
   *
   * A generator, so listing what is about to be reformatted is as easy as counting it:
   *
   * ```ts
   * const changed = [...document.changedObjects()];
   * if (changed.length > 0) warn(`Saving will rewrite ${changed.length} objects.`);
   * ```
   */
  *changedObjects(): Generator<IdfObject> {
    for (const obj of this.objects()) {
      if (!isUntouched(obj, this.#source)) yield obj;
    }
  }

  /** Reference targets that no object provides. */
  danglingReferences(): ReturnType<ReferenceGraph['dangling']> {
    const valid = new Set<string>();
    for (const obj of this.objects()) {
      // Not just `obj.name`: anonymous types such as `FluidProperties:Name`
      // declare the name others reference from an ordinary field, so building
      // the set from names alone reports valid models as broken.
      for (const declared of obj.declaredNames()) valid.add(declared.toLowerCase());
    }
    return this.#references.dangling(valid);
  }

  /**
   * epJSON representation.
   *
   * A type that declares no name field at all, `Version` or
   * `GlobalGeometryRules`, gets the `"<Type> N"` key EnergyPlus itself emits,
   * numbered from 1 in document order, which is what makes the output loadable
   * by the real engine.
   */
  toJSON(): Record<string, Record<string, Record<string, StoredValue>>> {
    const out: Record<string, Record<string, Record<string, StoredValue>>> = {};
    for (const [typeName, collection] of this.#collections) {
      if (collection.size === 0) continue;
      const body: Record<string, Record<string, StoredValue>> = {};
      let anonIndex = 1;
      for (const obj of collection) {
        // The synthetic key belongs to types with no name field, and only to
        // those. A type that declares an optional name and leaves it blank
        // keeps the blank verbatim: the empty string is that object's
        // identity, and minting `"<Type> N"` for it publishes a name the model
        // never declared, which every consumer resolving references by name
        // then resolves to the wrong object, or fails to resolve at all.
        //
        // Numbering only the nameless also ends the collision the old key
        // invited. A user may legitimately name an object `"Zone 1"`, and the
        // types that take a synthetic key carry no names to collide with.
        const key = obj.isNamed ? obj.name : `${typeName} ${anonIndex++}`;
        body[key] = obj.toJSON();
      }
      out[typeName] = body;
    }
    return out;
  }

  // --- ObjectOwner ------------------------------------------------------

  /**
   * Whether an in-place edit to an extensible repeat has to be heard.
   *
   * Only while this document carries a retained source. Without one there is no touched record to
   * maintain and nothing a preserving write would consult, so the repeats stay plain objects and a
   * geometry consumer reads a coordinate at the cost it has always read one at.
   */
  tracksExtensibleEdits(): boolean {
    return this.#source !== undefined;
  }

  onFieldChanged(obj: IdfObject, field: string, previous: unknown, next: unknown): void {
    // No longer the characters it was read from. This fires exactly when a value actually changed,
    // because the accessor compares before writing, so "a write of the value already held marks
    // nothing" costs nothing. Outside both branches below: a change is a change whether or not the
    // field carries a reference.
    obj[SOURCE] = undefined;

    // Replacing the extensible array wholesale changes which repeats hold which
    // references, and the stored repeat indices with it, so the object's edges
    // are rebuilt rather than patched.
    if (field === obj[SHAPE].extensibleKey && obj[SHAPE].extensibleRefFields.length > 0) {
      this.#references.removeObject(obj);
      this.#references.addObject(obj);
      return;
    }
    if (!obj.schema.p[field]?.ol?.length) return;
    this.#references.updateField(obj, field, previous, next);
  }

  onNameChanged(obj: IdfObject, previous: string, next: string): void {
    if (previous === next) return;
    // The write-path collection: the object is attached, so this is the very
    // map entry it lives in, and `rekey` below must land on that entry rather
    // than on a detached empty.
    const collection = this.#collectionForWrite(this.schema.resolve(obj.typeName) ?? obj.typeName);
    const existing = collection.get(next);
    if (existing !== undefined && existing !== obj) {
      throw new Error(`A ${obj.typeName} named "${next}" already exists`);
    }

    // Blanking a name is not a rename. Every field pointing at the old name
    // would be rewritten to `""`, destroying the references instead of moving
    // them, and the object would take `""` as its collection key where the
    // blank-name paths in `addRaw`/`attach` mint a synthetic one.
    if (next === '') {
      throw new Error(
        `Cannot blank the name of ${obj}: remove the object instead, or rename it to a new name`
      );
    }

    collection.rekey(obj.key, next);
    obj[NAME] = next;
    obj[KEY] = next;
    obj[SOURCE] = undefined;

    // Rewrite referencing fields directly rather than through the accessor:
    // the accessor would call back into onFieldChanged, and retarget() has
    // already fixed the index for exactly these edges.
    //
    // Which is why the touched mark is made here, on BOTH branches. Every object in this loop is
    // now different from the characters it was read from and the one path that would have said so
    // is the one this loop bypasses. A writer trusting the listener emits these from their original
    // text, producing a file that loads and names a construction layer that no longer exists.
    //
    // The second branch is the one a test misses: a reference reached through a repeat index is
    // rewritten only there, so a mark on the top-level branch alone passes every test whose
    // reference happens to be a plain field.
    for (const edge of this.#references.retarget(previous, next)) {
      edge.from[SOURCE] = undefined;
      if (edge.index === undefined) {
        edge.from[DATA][edge.field] = next;
        continue;
      }
      const key = edge.from[SHAPE].extensibleKey;
      if (key === undefined) continue;
      const groups = edge.from[DATA][key];
      if (!Array.isArray(groups)) continue;
      const group = groups[edge.index];
      if (group !== undefined) group[edge.field] = next;
    }
  }
}

/**
 * Whether two definitions lay their fields out identically.
 *
 * Definitions are content-addressed and shared by identity, so the identity
 * check upstream covers everything loaded from one bundle. This is the fallback
 * for objects that crossed bundle instances, where the same type hydrates to
 * two equal-but-distinct objects. Only the positional layout matters: that is
 * what a mismatch corrupts.
 */
function sameLayout(a: SlimType, b: SlimType): boolean {
  if (a.f.length !== b.f.length) return false;
  for (let i = 0; i < a.f.length; i += 1) {
    if (a.f[i] !== b.f[i]) return false;
  }
  if (a.x?.key !== b.x?.key) return false;
  const ax = a.x?.fields ?? [];
  const bx = b.x?.fields ?? [];
  if (ax.length !== bx.length) return false;
  return ax.every((field, i) => field === bx[i]);
}
