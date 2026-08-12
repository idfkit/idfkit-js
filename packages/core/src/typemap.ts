/**
 * Version-specific static typing, with no runtime cost at all.
 *
 * A generated module (`@idfkit/core/types/v26-1`) exports one interface per
 * object type plus a `TypeMap` joining type name to interface. A document
 * parameterized by that map resolves `doc.all('Zone')` to a collection of
 * objects with `Zone`'s fields, and the editor completes among all 858 type
 * names as you type the string.
 *
 * This is where JavaScript beats the Python original rather than imitating it.
 * `__getattr__` resolves names at runtime, so an editor cannot see them and a
 * typo surfaces as `None` at simulation time. Here the schema is compiled into
 * the type system, so `doc.all('Zone').first.celing_height` is a compile error,
 * and none of it exists once the code is running: the maps are types, erased at
 * build time, and the argument really is just a string.
 */

import type { FieldValues } from './object.js';

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
