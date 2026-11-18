import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import { IdfDocument } from '@idfkit/core';
import type { ExtensibleGroup, IdfObject } from '@idfkit/core';
import type { Schema } from '@idfkit/schemas';

import type {
  BuildingSurface_Detailed_Extensible,
  Schedule_Compact_Extensible,
  TypeMap,
} from '@idfkit/types-v26-1';
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

/**
 * Extensible groups carry generated row types, so the half of a model that
 * lives in repeats (vertices, compact-schedule fields, equipment rows) is
 * checked like the fixed fields. Each `@ts-expect-error` is only an assertion
 * when `npx tsc -p tsconfig.test.json` runs; vitest strips them unchecked.
 */
describe('typed extensible groups', () => {
  it('types a repeat by the row of its owning type', () => {
    const doc = new IdfDocument<TypeMap>(v26);
    const wall = doc.add('BuildingSurface:Detailed', 'N', {});

    expectTypeOf(wall.extensible).toEqualTypeOf<BuildingSurface_Detailed_Extensible[]>();
    wall.extensible.push({
      vertex_x_coordinate: 0,
      vertex_y_coordinate: 0,
      vertex_z_coordinate: 3,
    });

    const first = wall.extensible[0];
    expectTypeOf(first!.vertex_z_coordinate).toEqualTypeOf<number>();
    expect(first?.vertex_z_coordinate).toBe(3);
  });

  it('rejects a misspelled row field', () => {
    const doc = new IdfDocument<TypeMap>(v26);
    const wall = doc.add('BuildingSurface:Detailed', 'N', {});

    // @ts-expect-error `vertex_x_coordinat` is not a field of the vertex row.
    wall.extensible.push({ vertex_x_coordinat: 0 });
    wall.extensible.push({
      // @ts-expect-error a typo is caught even when the rest of the row is complete.
      vertex_x_coordinat: 0,
      vertex_y_coordinate: 0,
      vertex_z_coordinate: 0,
    });
  });

  it('rejects a string in a numeric row field', () => {
    const doc = new IdfDocument<TypeMap>(v26);
    const wall = doc.add('BuildingSurface:Detailed', 'N', {});

    // @ts-expect-error vertex coordinates are numbers.
    wall.extensible.push({ vertex_x_coordinate: 'abc' });
    wall.extensible.push({
      // @ts-expect-error caught on its own, not only because the row is incomplete.
      vertex_x_coordinate: 'abc',
      vertex_y_coordinate: 0,
      vertex_z_coordinate: 0,
    });
  });

  it('checks rows passed to add()', () => {
    const doc = new IdfDocument<TypeMap>(v26);

    // Compile time only: at run time a row is not checked for unknown keys.
    // @ts-expect-error `foo` is not a field of the vertex row.
    doc.add('BuildingSurface:Detailed', 'S', { vertices: [{ foo: 1 }] });

    const ok = doc.add('BuildingSurface:Detailed', 'S2', {
      vertices: [
        { vertex_x_coordinate: 0, vertex_y_coordinate: 0, vertex_z_coordinate: 0 },
        { vertex_x_coordinate: 1, vertex_y_coordinate: 0, vertex_z_coordinate: 0 },
        { vertex_x_coordinate: 1, vertex_y_coordinate: 0, vertex_z_coordinate: 1 },
      ],
    });
    expect(ok.extensible).toHaveLength(3);
  });

  it('admits both text and numbers in Schedule:Compact rows', () => {
    const doc = new IdfDocument<TypeMap>(v26);
    const rows: Schedule_Compact_Extensible[] = [
      { field: 'Through: 12/31' },
      { field: 'For: AllDays' },
      { field: 'Until: 24:00' },
      { field: 1 },
    ];
    const schedule = doc.add('Schedule:Compact', 'Always On', { data: rows });

    expectTypeOf(schedule.extensible).toEqualTypeOf<Schedule_Compact_Extensible[]>();
    schedule.extensible.push({ field: 'Until: 24:00' }, { field: 0.5 });
    expect(schedule.extensible).toHaveLength(6);
    // @ts-expect-error the compact-schedule row has one field, `field`.
    schedule.extensible.push({ value: 1 });
  });

  it('types the group of a type that has none as empty', () => {
    const doc = new IdfDocument<TypeMap>(v26);
    const zone = doc.add('Zone', 'Z1');

    expectTypeOf(zone.extensible).toEqualTypeOf<never[]>();
    // @ts-expect-error `Zone` has no extensible group, so a push would be dropped.
    zone.extensible.push({ anything: 1 });
  });

  it('stays permissive for untyped documents and unknown names', () => {
    const untyped = new IdfDocument(v26);
    const wall = untyped.add('BuildingSurface:Detailed', 'N', {});
    expectTypeOf(wall.extensible).toEqualTypeOf<ExtensibleGroup[]>();
    wall.extensible.push({
      vertex_x_coordinate: 0,
      vertex_y_coordinate: 0,
      vertex_z_coordinate: 0,
    });

    const typed = new IdfDocument<TypeMap>(v26);
    const typeName: string = 'BuildingSurface:Detailed';
    const dynamic = typed.add(typeName, 'S', { vertices: [{ vertex_x_coordinate: 1 }] });
    expectTypeOf(dynamic.extensible).toEqualTypeOf<ExtensibleGroup[]>();

    // Version-generic code that takes a plain `IdfObject` accepts a typed one.
    const count = (obj: IdfObject): number => obj.extensible.length;
    const surface = typed.add('BuildingSurface:Detailed', 'T', {});
    surface.extensible.push({
      vertex_x_coordinate: 0,
      vertex_y_coordinate: 0,
      vertex_z_coordinate: 0,
    });
    expect(count(surface)).toBe(1);
    expect(count(wall)).toBe(1);
  });
});
