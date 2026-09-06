import type { SlimField, SlimType } from '@idfkit/schemas';

import { ExtensibleList } from './extensible.js';
import { DATA, KEY, NAME, ORIGIN, OWNER, SHAPE, SOURCE } from './internal.js';
import { shapeFor, type ObjectShape } from './shape.js';

/** A scalar field value. `undefined` means the field is absent. */
export type FieldValue = string | number | undefined;

/** One repeat of an extensible group, e.g. a single vertex. */
export type ExtensibleGroup = Record<string, string | number>;

/** Anything storable in a field slot. */
export type StoredValue = string | number | ExtensibleGroup[];

/** Field values accepted when constructing or updating an object. */
export type FieldValues = Record<string, StoredValue | null | undefined>;

/**
 * Something that wants to know when an object changes.
 *
 * Implemented by `IdfDocument`. Declared as an interface so a detached object
 * has no dependency on the document at all.
 */
export interface ObjectOwner {
  onFieldChanged(obj: IdfObject, field: string, previous: unknown, next: unknown): void;
  onNameChanged(obj: IdfObject, previous: string, next: string): void;
  /**
   * Whether an in-place edit to an extensible repeat has to be heard.
   *
   * True only while the document carries a retained source, because that is the only time there is
   * a touched record to maintain. Hearing it costs an accessor on every field of every repeat, and
   * an accessor read is far dearer than a plain one over the vertices of a real model.
   */
  tracksExtensibleEdits(): boolean;
}

/**
 * A single EnergyPlus object.
 *
 * Field access is via real accessors installed on a per-type prototype, so
 * `zone.ceiling_height` is an ordinary property read that TypeScript can see
 * (given the generated interfaces) and V8 can inline. See `shape.ts`.
 *
 * Field names are epJSON names (`zone_name`, `outside_boundary_condition`),
 * not the space-separated IDD names. That is a deliberate break from the Python
 * library's IDF-to-Python conversion: epJSON names are already valid JS
 * identifiers and valid TS interface keys, so using them directly means the
 * on-disk name, the runtime key, and the static type all agree.
 */
export class IdfObject {
  declare readonly [DATA]: Record<string, StoredValue>;
  declare readonly [SHAPE]: ObjectShape;
  declare [OWNER]: ObjectOwner | undefined;
  declare [NAME]: string;
  declare [KEY]: string;
  /** Index into the document's preserved anchors, or `undefined` once anything has changed this. */
  declare [SOURCE]: number | undefined;
  declare [ORIGIN]: number | undefined;

  /**
   * Objects are built through `IdfObject.create`, never `new`, because each
   * instance's prototype depends on its object type.
   */
  private constructor() {
    throw new Error('Use IdfObject.create()');
  }

  static create(
    typeName: string,
    type: SlimType,
    name: string,
    values: FieldValues = {}
  ): IdfObject {
    const shape = shapeFor(typeName, type, IdfObject.prototype);
    const obj = Object.create(shape.proto) as IdfObject;

    Object.defineProperty(obj, DATA, { value: Object.create(null) as Record<string, StoredValue> });
    Object.defineProperty(obj, SHAPE, { value: shape });
    Object.defineProperty(obj, OWNER, { value: undefined, writable: true });
    Object.defineProperty(obj, NAME, { value: name, writable: true });
    Object.defineProperty(obj, KEY, { value: name, writable: true });
    // Left undefined by construction, so an object built after the read is touched from the moment
    // it exists (FR-007). `clone` builds through here too, which is why a copy is touched as well:
    // it is a different object from the one the characters describe.
    Object.defineProperty(obj, SOURCE, { value: undefined, writable: true });
    Object.defineProperty(obj, ORIGIN, { value: undefined, writable: true });

    for (const [field, value] of Object.entries(values)) {
      if (value === undefined || value === null) continue;
      // Rejected rather than stored: an unrecognized name has no accessor and is
      // dropped by every writer, so accepting it here means the caller reads
      // their value back correctly and then loses it on save. `set()` already
      // throws on the same input; this keeps the two paths in agreement.
      if (!Object.hasOwn(type.p, field) && field !== shape.extensibleKey) {
        throw new Error(`"${field}" is not a field of ${typeName}`);
      }
      obj[DATA][field] = value;
    }
    return obj;
  }

  /** Canonical object type name, e.g. `BuildingSurface:Detailed`. */
  get typeName(): string {
    return this[SHAPE].typeName;
  }

  /** Schema definition for this object's type. */
  get schema(): SlimType {
    return this[SHAPE].type;
  }

  /**
   * The object's name, i.e. its key within its collection.
   *
   * Assigning propagates through the document: the collection is re-keyed and
   * every field elsewhere in the model that referenced the old name is updated.
   */
  get name(): string {
    return this[NAME];
  }

  set name(value: string) {
    const previous = this[NAME];
    if (previous === value) return;
    const owner = this[OWNER];
    if (owner === undefined) {
      this[NAME] = value;
      // The key has to move with the name, exactly as `onNameChanged` does for
      // an attached object. Leaving it behind means a detached rename followed
      // by `attach()` files the object under its old name, where no lookup by
      // its current name can reach it.
      if (value !== '') this[KEY] = value;
      return;
    }
    // The document performs the rename so it can reject duplicates before
    // anything mutates, then rewrite referencing fields.
    owner.onNameChanged(this, previous, value);
  }

  /**
   * The object's slot in its collection.
   *
   * Equals `name` for ordinary objects. Objects with no name, or with a blank
   * name, get a synthetic key so they can still be stored and addressed.
   */
  get key(): string {
    return this[KEY];
  }

  /** Whether this object type carries a name at all. */
  get isNamed(): boolean {
    return this[SHAPE].named;
  }

  /** Read a field by name. Untyped escape hatch for version-generic code. */
  get(field: string): StoredValue | undefined {
    return this[DATA][field];
  }

  /** Write a field by name, going through the same hooks as property access. */
  set(field: string, value: StoredValue | null | undefined): void {
    if (!this.hasField(field)) {
      throw new Error(`"${field}" is not a field of ${this.typeName}`);
    }
    // Route through the accessor so reference tracking fires exactly once.
    (this as unknown as Record<string, unknown>)[field] = value ?? undefined;
  }

  /** Apply several fields at once. */
  update(values: FieldValues): this {
    for (const [field, value] of Object.entries(values)) {
      this.set(field, value ?? undefined);
    }
    return this;
  }

  /** Whether the schema defines this field for this object type. */
  hasField(field: string): boolean {
    return Object.hasOwn(this[SHAPE].type.p, field) || field === this[SHAPE].extensibleKey;
  }

  /** Schema definition for one field. */
  fieldSchema(field: string): SlimField | undefined {
    return this[SHAPE].type.p[field];
  }

  /** Field names in IDF positional order, excluding the name. */
  get fieldNames(): readonly string[] {
    return this[SHAPE].fields;
  }

  /** Field names that are actually set on this object. */
  setFieldNames(): string[] {
    return this[SHAPE].fields.filter((f) => this[DATA][f] !== undefined);
  }

  /**
   * Repeat groups of the extensible section, e.g. the vertices of a surface.
   *
   * Returns a live array: pushing to it mutates the object, and so does writing a field of one of
   * its repeats. Both now tell the document, which they did not before: the array handed back was
   * the object's own data, so a pushed vertex reached the object without passing any accessor and
   * a preserving write discarded the edit in a file that loads.
   *
   * It is still an array to everything that reads it. `Array.isArray` is true, indexing and
   * iteration are unchanged, `map` and `filter` hand back plain arrays, and a repeat spreads and
   * compares exactly as the plain object it replaces.
   *
   * **Only when the document carries a retained source.** A repeat's fields are own accessors, and
   * an accessor read is roughly thirty times the cost of a plain property read; over the 33,000
   * vertices of a real model that is measurable, and charging every vertex read is exactly what
   * rejecting a `Proxy` was meant to avoid. A document read without preservation has no touched
   * record to maintain, so it keeps the plain array and today's speed. A document read WITH
   * preservation is being edited, and an edit that reaches the file matters more there than the
   * throughput of reading a coordinate.
   *
   * The wrapper is built once and kept, so a read of a preserving document costs one `instanceof`
   * after the first.
   *
   * One spelling is not heard: replacing a whole repeat by index, `obj.extensible[0] = {...}`,
   * writes through the array's own index slot, which cannot be caught without charging every
   * vertex read. Writing the repeat's fields and `splice` both are heard. See `extensible.ts`.
   */
  get extensible(): ExtensibleGroup[] {
    const key = this[SHAPE].extensibleKey;
    if (key === undefined) return [];
    const held = this[DATA][key];
    if (held instanceof ExtensibleList) return held;
    if (this[OWNER]?.tracksExtensibleEdits() !== true) {
      if (Array.isArray(held)) return held;
      const empty: ExtensibleGroup[] = [];
      this[DATA][key] = empty;
      return empty;
    }

    const list = ExtensibleList.adopt(
      Array.isArray(held) ? held : [],
      this[SHAPE].type.x?.fields ?? [],
      () => {
        this[SOURCE] = undefined;
        this[OWNER]?.onFieldChanged(this, key, held, this[DATA][key]);
      }
    );
    this[DATA][key] = list;
    return list;
  }

  /**
   * Names this object's fields point at, paired with the field holding them.
   *
   * Extensible groups are included, with `index` naming the repeat the value
   * sits in. Half the references in a real model live there.
   */
  outgoingReferences(): Array<{ field: string; target: string; index?: number }> {
    const out: Array<{ field: string; target: string; index?: number }> = [];
    for (const field of this[SHAPE].refFields) {
      const value = this[DATA][field];
      if (typeof value === 'string' && value !== '') out.push({ field, target: value });
    }

    const extensibleRefs = this[SHAPE].extensibleRefFields;
    const key = this[SHAPE].extensibleKey;
    if (extensibleRefs.length > 0 && key !== undefined) {
      // Read through DATA rather than the `extensible` getter, which
      // materializes an empty array as a side effect.
      const list = this[DATA][key];
      if (Array.isArray(list)) {
        list.forEach((group, index) => {
          for (const field of extensibleRefs) {
            const value = group[field];
            if (typeof value === 'string' && value !== '')
              out.push({ field, target: value, index });
          }
        });
      }
    }
    return out;
  }

  /**
   * Names this object contributes to the model's reference lists.
   *
   * Usually just `name`, but anonymous types like `FluidProperties:Name` carry
   * their identity in an ordinary field instead, and other objects reference
   * that value. Treating those as nameless makes every pointer at them look
   * dangling.
   */
  declaredNames(): string[] {
    const out: string[] = [];
    if (this[NAME] !== '') out.push(this[NAME]);
    for (const field of this[SHAPE].keyFields) {
      const value = this[DATA][field];
      if (typeof value === 'string' && value !== '') out.push(value);
    }
    return out;
  }

  /** Detached deep copy, optionally renamed. Not attached to any document. */
  clone(name: string = this[NAME]): IdfObject {
    const copy = IdfObject.create(this.typeName, this[SHAPE].type, name);
    for (const [field, value] of Object.entries(this[DATA])) {
      copy[DATA][field] = Array.isArray(value) ? value.map((group) => ({ ...group })) : value;
    }
    return copy;
  }

  /** Plain epJSON body: field values only, without the name. */
  toJSON(): Record<string, StoredValue> {
    const out: Record<string, StoredValue> = {};
    for (const field of this[SHAPE].fields) {
      const value = this[DATA][field];
      if (value !== undefined) out[field] = value;
    }
    const key = this[SHAPE].extensibleKey;
    if (key !== undefined) {
      const list = this[DATA][key];
      if (Array.isArray(list) && list.length > 0) out[key] = list.map((g) => ({ ...g }));
    }
    return out;
  }

  toString(): string {
    return `${this.typeName}(${this[NAME]})`;
  }
}
