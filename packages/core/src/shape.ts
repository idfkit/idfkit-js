import type { SlimType } from '@idfkit/schemas';

import { DATA, OWNER, SHAPE } from './internal.js';
import type { IdfObject, StoredValue } from './object.js';

/**
 * Per-object-type prototype carrying real accessors for every field.
 *
 * The Python library resolves `zone.ceiling_height` through `__getattr__`. The
 * mechanical translation of that is a `Proxy`, which we deliberately do not use:
 * proxies defeat V8's inline caches, and more importantly they are invisible to
 * TypeScript, so nothing would autocomplete. Instead each object type gets one
 * prototype with `Object.defineProperty` accessors, built once and shared by
 * every instance of that type. Property access is then an ordinary monomorphic
 * lookup, and the generated `.d.ts` interfaces describe it statically.
 *
 * Shapes are keyed by the schema definition object rather than by type name.
 * Because the schema bundle is content-addressed, `Zone` in 9.4.0 and `Zone` in
 * 26.1.0 are the same frozen definition, so they share one shape and one
 * prototype. Cross-version documents stay monomorphic for free.
 */
export class ObjectShape {
  readonly typeName: string;
  readonly type: SlimType;
  readonly proto: object;

  /** Field names in IDF positional order, excluding the name field. */
  readonly fields: readonly string[];
  /** Fields that point into a reference list, i.e. foreign keys. */
  readonly refFields: readonly string[];
  /**
   * Fields *inside* the extensible group that point into a reference list.
   *
   * Kept separate from `refFields` because these live in `type.x.fields`, not
   * the positional field list, and so need the repeat index to address them.
   * Ignoring them is not cosmetic: `ZoneList`, `Branch`, and the supply/return
   * paths carry all of their references here, so leaving them out of the graph
   * makes `rename()` silently produce a broken model.
   */
  readonly extensibleRefFields: readonly string[];
  /** Fields whose value declares a name other objects may reference. */
  readonly keyFields: readonly string[];
  /** Extensible array key (`vertices`), if this type has one. */
  readonly extensibleKey: string | undefined;
  /** Whether the object carries a name (most do; `Version` does not). */
  readonly named: boolean;

  constructor(typeName: string, type: SlimType, base: object) {
    this.typeName = typeName;
    this.type = type;
    this.named = type.anon !== 1;

    const fields = type.f.filter((f) => f !== 'name');
    this.fields = fields;
    this.extensibleKey = type.x?.key;
    this.refFields = fields.filter((f) => (type.p[f]?.ol?.length ?? 0) > 0);
    this.keyFields = fields.filter((f) => (type.p[f]?.ref?.length ?? 0) > 0);

    const extensible = type.x;
    this.extensibleRefFields =
      extensible === undefined
        ? []
        : extensible.fields.filter((f) => (extensible.p[f]?.ol?.length ?? 0) > 0);

    const proto = Object.create(base) as object;
    for (const field of fields) {
      defineFieldAccessor(proto, field);
    }
    // The extensible array lives under its own epJSON key (`vertices`) rather
    // than in the positional field list, so it needs an accessor of its own.
    if (this.extensibleKey !== undefined && !fields.includes(this.extensibleKey)) {
      defineFieldAccessor(proto, this.extensibleKey);
    }
    this.proto = Object.freeze(proto);
  }
}

function defineFieldAccessor(proto: object, field: string): void {
  Object.defineProperty(proto, field, {
    enumerable: true,
    configurable: false,
    get(this: IdfObject): unknown {
      return this[DATA][field];
    },
    set(this: IdfObject, value: unknown) {
      const previous = this[DATA][field];
      if (previous === value) return;

      if (value === undefined || value === null) delete this[DATA][field];
      else this[DATA][field] = value as StoredValue;

      // The document keeps the reference graph live. Routing writes through a
      // real setter is what lets us do that without a Proxy and without asking
      // callers to mutate via an explicit `update()` call.
      this[OWNER]?.onFieldChanged(this, field, previous, value);
    },
  });
}

const shapeCache = new WeakMap<SlimType, Map<string, ObjectShape>>();

/**
 * Get (or build) the shape for an object type.
 *
 * `base` is `IdfObject.prototype`, threaded in rather than imported to keep
 * this module free of a cycle with `object.ts`.
 */
export function shapeFor(typeName: string, type: SlimType, base: object): ObjectShape {
  let byName = shapeCache.get(type);
  if (byName === undefined) {
    byName = new Map();
    shapeCache.set(type, byName);
  }
  let shape = byName.get(typeName);
  if (shape === undefined) {
    shape = new ObjectShape(typeName, type, base);
    byName.set(typeName, shape);
  }
  return shape;
}

/** Number of distinct shapes built, for tests and diagnostics. */
export function shapeOf(obj: IdfObject): ObjectShape {
  return obj[SHAPE];
}
