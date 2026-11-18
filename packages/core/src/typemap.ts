/**
 * Version-specific static typing, with no runtime cost at all.
 *
 * An opt-in package (`@idfkit/types-v26-1`, one per EnergyPlus version) exports
 * one interface per object type plus a `TypeMap` joining type name to
 * interface. A document parameterized by that map resolves `doc.all('Zone')` to
 * a collection of objects with `Zone`'s fields, and the editor completes among
 * all 858 type names as you type the string. Install none of them and every
 * document is an `UntypedMap`: nothing stops working, the field names are
 * simply not checked.
 *
 * This is where JavaScript beats the Python original rather than imitating it.
 * `__getattr__` resolves names at runtime, so an editor cannot see them and a
 * typo surfaces as `None` at simulation time. Here the schema is compiled into
 * the type system, so `doc.all('Zone').first.celing_height` is a compile error,
 * and none of it exists once the code is running: the maps are types, erased at
 * build time, and the argument really is just a string.
 */

import type { ExtensibleGroup, FieldValues, IdfObject } from './object.js';

/** Base constraint: any map from object type name to its field interface. */
export type AnyTypeMap = Record<string, object>;

/** A document with no version types attached. */
export type UntypedMap = Record<never, never>;

/**
 * Accepted type names for a map.
 *
 * The `string & {}` arm is what keeps literal completion alive while still
 * accepting arbitrary strings: without it TypeScript widens the parameter to
 * `string` and the suggestions disappear.
 */
export type TypeNameOf<M extends AnyTypeMap> = (keyof M & string) | (string & {});

/** Field interface for a type name, or an empty object for unknown names. */
export type ObjectOf<M extends AnyTypeMap, K extends string> = K extends keyof M
  ? M[K]
  : UntypedMap;

/**
 * Field values accepted when creating an object of a given type.
 *
 * Deliberately not `ObjectOf`. For a known type name this is the exact field
 * interface, so TypeScript's excess-property check rejects a misspelled field
 * in an object literal. For anything else it widens to the permissive
 * `FieldValues`, which is what version-generic code and untyped documents need.
 * Using one type for both would force a choice between catching typos and
 * allowing dynamic field names; using two costs nothing and gives both.
 */
export type ValuesOf<M extends AnyTypeMap, K extends string> = K extends keyof M
  ? Partial<M[K]>
  : FieldValues;

/**
 * The row type of one repeat of a type's extensible group.
 *
 * Read off the field interface rather than from a second map: the generated
 * interface types its group key (`vertices`, `data`, `equipment`) as an array
 * of the row, and no other field is an array, so the element type of whichever
 * property is one *is* the row. A known type with no group yields `never`,
 * which makes `obj.extensible.push(...)` a compile error on a type that would
 * drop the repeat. Unknown names, untyped documents and the open
 * `AnyTypeMap` keep the permissive `ExtensibleGroup`, on the same terms as
 * `ValuesOf`.
 *
 * The `string extends K` arm comes first and tests only the name, so a type
 * name held in a `string` resolves to `ExtensibleGroup` even inside a function
 * generic over `M`, where every test on `M` is deferred. Without it a helper
 * written as `<M extends AnyTypeMap>(doc: IdfDocument<M>, type: string)` could
 * not push a repeat at all. A literal name in such a helper still defers; widen
 * the object to `IdfObject` there.
 */
export type ExtensibleOf<M extends AnyTypeMap, K extends string> = string extends K
  ? ExtensibleGroup
  : string extends keyof M
    ? ExtensibleGroup
    : K extends keyof M
      ? {
          [P in keyof M[K]]-?: NonNullable<M[K][P]> extends ReadonlyArray<infer R>
            ? R extends ExtensibleGroup
              ? R
              : ExtensibleGroup
            : never;
        }[keyof M[K]]
      : ExtensibleGroup;

/**
 * What `add`, `all`, `get` and `require` hand back for a type name: an
 * `IdfObject` whose `extensible` is narrowed to the type's row, joined with the
 * type's field interface.
 */
export type TypedObject<M extends AnyTypeMap, K extends string> = IdfObject<ExtensibleOf<M, K>> &
  ObjectOf<M, K>;
