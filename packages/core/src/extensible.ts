import type { ExtensibleGroup, IdfObject } from './object.js';

/** What an extensible wrapper tells when it is mutated. */
export interface ExtensibleOwner {
  (): void;
}

/**
 * The repeats of an extensible section, as an array that says when it is written to.
 *
 * `get extensible()` used to hand back the object's own data array, so `push` reached the object
 * without passing any accessor and notified nobody. A preserving writer then emits the object's
 * original vertices and discards the edit, in a file that loads.
 *
 * An Array subclass, and no `Proxy`: a proxy would charge every read of every vertex to catch a
 * write, and reading vertices is a hot path. `Symbol.species` is `Array`, so `map` and `slice` hand
 * back plain arrays as they always did.
 *
 * @internal
 */
export class ExtensibleList extends Array<ExtensibleGroup> {
  /** Derived operations produce plain arrays, not more of these. */
  static override get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  /** Called after any mutation through this list. */
  declare changed: ExtensibleOwner;
  /** Every field the schema declares for one repeat, so a field added later is heard too. */
  declare fields: readonly string[];

  /**
   * Wrap an object's repeats, arming each one so a write to its fields is heard too.
   *
   * A static rather than a constructor, because `Array`'s constructor takes a length and a
   * subclass whose constructor means something else is one every array operation can misuse.
   */
  static adopt(
    groups: readonly ExtensibleGroup[],
    fields: readonly string[],
    changed: ExtensibleOwner
  ): ExtensibleList {
    const list = new ExtensibleList();
    Object.defineProperty(list, 'changed', { value: changed, enumerable: false });
    Object.defineProperty(list, 'fields', { value: fields, enumerable: false });
    for (const group of groups) Array.prototype.push.call(list, arm(group, fields, changed));
    return list;
  }

  override push(...groups: ExtensibleGroup[]): number {
    const length = super.push(...groups.map((g) => arm(g, this.fields, this.changed)));
    this.changed();
    return length;
  }

  override pop(): ExtensibleGroup | undefined {
    const group = super.pop();
    this.changed();
    return group;
  }

  override shift(): ExtensibleGroup | undefined {
    const group = super.shift();
    this.changed();
    return group;
  }

  override unshift(...groups: ExtensibleGroup[]): number {
    const length = super.unshift(...groups.map((g) => arm(g, this.fields, this.changed)));
    this.changed();
    return length;
  }

  override splice(
    start: number,
    deleteCount?: number,
    ...groups: ExtensibleGroup[]
  ): ExtensibleGroup[] {
    const removed =
      deleteCount === undefined
        ? super.splice(start)
        : super.splice(start, deleteCount, ...groups.map((g) => arm(g, this.fields, this.changed)));
    this.changed();
    return removed;
  }

  override reverse(): this {
    super.reverse();
    this.changed();
    return this;
  }

  override sort(compare?: (a: ExtensibleGroup, b: ExtensibleGroup) => number): this {
    super.sort(compare);
    this.changed();
    return this;
  }
}

/**
 * A repeat that says when one of its fields is written.
 *
 * The accessors are OWN properties, not prototype ones: a repeat is compared with `toEqual` and
 * spread with `{ ...group }`, and both read own enumerable properties. Every field the schema
 * declares is armed, not only the ones this repeat carries, so writing a coordinate the file left
 * blank is heard; a field the repeat does not carry is armed but not enumerable until it is
 * written, so a repeat spreads and compares exactly as the plain object it replaces.
 *
 * Arming happens when a caller reaches for `extensible`, never during a read, so a parse nobody
 * reaches into pays nothing.
 */
function arm(
  group: ExtensibleGroup,
  fields: readonly string[],
  changed: ExtensibleOwner
): ExtensibleGroup {
  if (ARMED in group) return group;

  const values: Record<string, string | number | undefined> = Object.create(null) as Record<
    string,
    string | number | undefined
  >;
  const armed: ExtensibleGroup = {};
  Object.defineProperty(armed, ARMED, { value: true, enumerable: false });

  for (const field of fields.length > 0 ? fields : Object.keys(group)) {
    const present = Object.hasOwn(group, field);
    if (present) values[field] = group[field];
    define(armed, field, values, present, changed);
  }
  // A field the schema does not declare, which a hand-built repeat can still carry. Kept rather
  // than dropped: losing a value on the way through a wrapper is worse than tracking an odd one.
  for (const [field, value] of Object.entries(group)) {
    if (Object.hasOwn(armed, field)) continue;
    values[field] = value;
    define(armed, field, values, true, changed);
  }
  return armed;
}

/** One field's accessor, which makes itself enumerable the first time it is written. */
function define(
  armed: ExtensibleGroup,
  field: string,
  values: Record<string, string | number | undefined>,
  enumerable: boolean,
  changed: ExtensibleOwner
): void {
  Object.defineProperty(armed, field, {
    enumerable,
    configurable: true,
    get(): string | number | undefined {
      return values[field];
    },
    set(this: ExtensibleGroup, next: string | number) {
      if (values[field] === next) return;
      values[field] = next;
      if (!Object.getOwnPropertyDescriptor(this, field)?.enumerable) {
        define(this, field, values, true, changed);
      }
      changed();
    },
  });
}

/** Marks a repeat that already carries its accessors, so arming one twice is free. */
const ARMED = Symbol('idfkit.armed');
