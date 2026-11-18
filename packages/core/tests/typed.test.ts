import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import { IdfDocument, type IdfCollection, type IdfObject } from '@idfkit/core';
import type { Schema } from '@idfkit/schemas';

import type { TypeMap } from '@idfkit/types-v26-1';
import type { TypeMap as TypeMapV9 } from '@idfkit/types-v9-4';
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

  it('types collection.add exactly like doc.add', () => {
    const doc = new IdfDocument<TypeMap>(v26);
    const zones = doc.all('Zone');
    const office = zones.add('Office', { ceiling_height: 3 });

    expectTypeOf(office.ceiling_height).toEqualTypeOf<
      number | 'Autosize' | 'Autocalculate' | undefined
    >();
    expect(office.ceiling_height).toBe(3);

    expect(() => {
      // @ts-expect-error `ceilng_height` is a typo, caught as an excess property.
      zones.add('Bad', { ceilng_height: 3 });
    }).toThrow('"ceilng_height" is not a field of Zone');

    // @ts-expect-error `ceiling_height` takes a number or a keyword, not any string. Like
    // `doc.add`, the runtime does not check value types on creation; `validateObject` does.
    zones.add('Tall', { ceiling_height: 'tall' });

    // @ts-expect-error `Sunny` is not one of the permitted choices.
    doc.all('BuildingSurface:Detailed').add('S1', { sun_exposure: 'Sunny' });

    // Anonymous types take null, and the values are still checked.
    doc.all('Version').add(null, { version_identifier: '26.1' });
    // @ts-expect-error `version` is not a field of Version.
    expect(() => doc.all('Timestep').add(null, { version: '26.1' })).toThrow();

    expect(zones.names()).toEqual(['Office', 'Tall']);
  });

  it('keeps a typed collection assignable to a plain one', () => {
    const doc = new IdfDocument<TypeMap>(v26);
    const plain: IdfCollection = doc.all('BuildingSurface:Detailed');
    const generic = <K extends string>(type: K): IdfCollection<IdfObject> => doc.all(type);
    expect(plain.typeName).toBe('BuildingSurface:Detailed');
    expect(generic('Zone').typeName).toBe('Zone');
  });

  it('leaves collection.add permissive on untyped documents and unknown names', () => {
    const untyped = new IdfDocument(v26);
    untyped.all('Zone').add('Z1', { ceiling_height: 3 });

    const typed = new IdfDocument<TypeMap>(v26);
    const typeName: string = 'Zone';
    typed.all(typeName).add('Z1', { ceiling_height: 3 });

    expect(untyped.toJSON()).toEqual(typed.toJSON());
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
