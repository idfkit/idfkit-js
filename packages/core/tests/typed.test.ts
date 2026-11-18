import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import { IdfDocument } from '@idfkit/core';
import type { AnyTypeMap, ExtensibleGroup, IdfCollection, IdfObject } from '@idfkit/core';
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
    // Rejected twice: at compile time here, and at run time by the frozen
    // empty array the getter returns for a type with no group.
    expect(() =>
      // @ts-expect-error `Zone` has no extensible group.
      zone.extensible.push({ anything: 1 })
    ).toThrow(TypeError);
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

  it('admits a variable name where the schema takes any number or any text', () => {
    // Regression: these fields were typed as numbers plus the autosize
    // keywords, which rejected the variable names the schema accepts.
    const doc = new IdfDocument<TypeMap>(v26);
    const tariff = doc.add('UtilityCost:Tariff', 'T', {
      monthly_charge_or_variable_name: 'MonthlyChargeVariable',
    });
    expectTypeOf(tariff.monthly_charge_or_variable_name).toEqualTypeOf<
      number | string | undefined
    >();
    // An integer field with an Autosize branch admits the keyword too.
    doc.add('AirTerminal:SingleDuct:ConstantVolume:CooledBeam', 'B', {
      number_of_beams: 'Autosize',
    });
  });

  it('lets a helper generic over the map push onto a group named at run time', () => {
    const push = <M extends AnyTypeMap>(
      doc: IdfDocument<M>,
      type: string,
      name: string
    ): number => {
      const obj = doc.require(type, name);
      obj.extensible.push({
        vertex_x_coordinate: 0,
        vertex_y_coordinate: 0,
        vertex_z_coordinate: 0,
      });
      return obj.extensible.length;
    };
    const doc = new IdfDocument<TypeMap>(v26);
    doc.add('BuildingSurface:Detailed', 'S', {});
    expect(push(doc, 'BuildingSurface:Detailed', 'S')).toBe(1);
  });
});

describe('collection.add typing', () => {
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

  it('returns the same object type as doc.add, extensible rows included', () => {
    const doc = new IdfDocument<TypeMap>(v26);
    const wall = doc.all('BuildingSurface:Detailed').add('W', { surface_type: 'Wall' });

    expectTypeOf(wall.extensible).toEqualTypeOf<BuildingSurface_Detailed_Extensible[]>();
    wall.extensible.push({
      vertex_x_coordinate: 1,
      vertex_y_coordinate: 0,
      vertex_z_coordinate: 0,
    });
    wall.extensible.push({
      // @ts-expect-error `vertex_x_coordinat` is not a field of the vertex row.
      vertex_x_coordinat: 1,
      vertex_y_coordinate: 0,
      vertex_z_coordinate: 0,
    });

    // Locked like any created object: a misspelled field cannot become an own property.
    expect(() => {
      // @ts-expect-error `ceilng_height` is not a field of Zone.
      doc.all('Zone').add('Z1').ceilng_height = 4;
    }).toThrow(TypeError);

    expect(doc.remove(wall)).toBe(true);
    expect(doc.all('BuildingSurface:Detailed').size).toBe(0);
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
});
