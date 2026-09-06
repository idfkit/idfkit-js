/**
 * Symbol-keyed internals.
 *
 * Field accessors are generated from schema field names, which are arbitrary
 * strings. Symbols guarantee an object type can never define a field that
 * collides with our own bookkeeping.
 */

/** Backing store of field values, keyed by epJSON field name. */
export const DATA = Symbol('idfkit.data');

/** The object's shape (type name, schema definition, prototype). */
export const SHAPE = Symbol('idfkit.shape');

/** Owning document, or undefined for a detached object. */
export const OWNER = Symbol('idfkit.owner');

/** The object's name as written in the file. May be empty. */
export const NAME = Symbol('idfkit.name');

/**
 * The object's key within its collection.
 *
 * Usually identical to the name. It differs for objects that have no name
 * (`Version`) and for those whose name is legitimately blank (EnergyPlus lets
 * `WeatherProperty:SkyTemperature` omit its name to mean "all run periods"),
 * which still need a unique slot in the collection.
 */
export const KEY = Symbol('idfkit.key');

/**
 * Index into the document's `PreservedSource.anchors`, or `undefined`.
 *
 * The touched record. An object still carrying its statement's index, whose anchor is still this
 * object, is written by copying those characters; anything that changes the object clears it.
 *
 * Maintained as changes happen rather than compared at write time. Comparing would mean holding a
 * second copy of the model, and it is wrong in the case that matters most: a field written to a
 * new value and back again is unchanged by comparison and touched in truth.
 */
export const SOURCE = Symbol('idfkit.source');
