import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import { IdfDocument } from '@idfkit/core';
import type { Schema } from '@idfkit/schemas';

import type { TypeMap } from '../src/types/v26-1.js';
import type { TypeMap as TypeMapV9 } from '../src/types/v9-4.js';
import { schema } from './helpers.js';

let v26: Schema;
beforeAll(async () => {
  v26 = await schema('26.1.0');
});

/**
 * The generated type map is the payoff of doing this in TypeScript rather than
 * porting the Python API shape verbatim. These assertions run at compile time;
 * the runtime `expect`s only confirm the erasure is total.
 */
describe('typed documents', () => {
  it('narrows field types from the type name alone', () => {
    const doc = new IdfDocument<TypeMap>(v26);
    const zone = doc.add('Zone', 'Z1', { ceiling_height: 2.7, x_origin: 1 });

    expectTypeOf(zone.ceiling_height).toEqualTypeOf<
      number | 'Autosize' | 'Autocalculate' | undefined
    >();
    expectTypeOf(zone.multiplier).toEqualTypeOf<number | undefined>();
    expect(zone.ceiling_height).toBe(2.7);
  });

  it('types choice fields as unions of their permitted values', () => {
    const doc = new IdfDocument<TypeMap>(v26);
    const surface = doc.add('BuildingSurface:Detailed', 'S1', { sun_exposure: 'SunExposed' });

    expectTypeOf(surface.sun_exposure).toEqualTypeOf<'SunExposed' | 'NoSun' | undefined>();
    expect(surface.sun_exposure).toBe('SunExposed');
  });

  it('rejects unknown fields at compile time and at runtime', () => {
    const doc = new IdfDocument<TypeMap>(v26);

    // Untyped documents (what `parseIdf` returns) get no compile-time check, so
    // the same typo has to fail at runtime too rather than being stored and
    // then dropped by the writers.
    expect(() => {
      // @ts-expect-error `celing_height` is a typo; the Python library would
      // silently accept this and produce a model missing the field.
      doc.add('Zone', 'Z1', { celing_height: 2.7 });
    }).toThrow('"celing_height" is not a field of Zone');

    // @ts-expect-error `Multiplier` is not one of the permitted choices.
    doc.add('BuildingSurface:Detailed', 'S1', { sun_exposure: 'Sunny' });

    expect(doc.all('Zone').size).toBe(0);
  });

  it('keeps unknown type names usable but untyped', () => {
    const doc = new IdfDocument<TypeMap>(v26);
    // Version-generic code passes a runtime string and still works.
    const typeName: string = 'Zone';
    const collection = doc.all(typeName);
    expect(collection.typeName).toBe('Zone');
  });

  it('describes each version separately', () => {
    // `Space` exists in 26.1 but not 9.4, and the types say so.
    expectTypeOf<TypeMap>().toHaveProperty('Space');
    expectTypeOf<TypeMapV9>().not.toHaveProperty('Space');
  });

  it('costs nothing at runtime', () => {
    // A typed document and an untyped one are the same object graph; the map
    // exists only in the type system.
    const typed = new IdfDocument<TypeMap>(v26);
    const untyped = new IdfDocument(v26);

    typed.add('Zone', 'Z1', { x_origin: 1 });
    untyped.add('Zone', 'Z1', { x_origin: 1 });

    expect(typed.toJSON()).toEqual(untyped.toJSON());
    expect(Object.getPrototypeOf(typed)).toBe(Object.getPrototypeOf(untyped));
  });
});
