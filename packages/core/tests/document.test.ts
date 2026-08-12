import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { IDFDocument, shapeOf } from '@idfkit/core';
import type { Schema } from '@idfkit/schemas';

import { schema } from './helpers.js';

let v26: Schema;
beforeAll(async () => {
  v26 = await schema('26.1.0');
});

let doc: IDFDocument;
beforeEach(() => {
  doc = new IDFDocument(v26);
});

describe('IDFDocument.add', () => {
  it('creates an object with schema-named fields', () => {
    const zone = doc.add('Zone', 'Z1', { x_origin: 3, ceiling_height: 2.7 });

    expect(zone.name).toBe('Z1');
    expect(zone.get('x_origin')).toBe(3);
    expect(doc.all('Zone').size).toBe(1);
  });

  it('canonicalizes a mis-cased type name', () => {
    doc.add('zone', 'Z1');
    expect(doc.all('Zone').has('Z1')).toBe(true);
    expect(doc.types()).toEqual(['Zone']);
  });

  it('rejects a duplicate name', () => {
    doc.add('Zone', 'Z1');
    expect(() => doc.add('Zone', 'Z1')).toThrow(/already exists/);
  });

  it('rejects a duplicate name case-insensitively, as EnergyPlus does', () => {
    doc.add('Zone', 'Z1');
    expect(() => doc.add('Zone', 'z1')).toThrow(/already exists/);
  });

  it('rejects an unknown object type', () => {
    expect(() => doc.add('NotAThing', 'X')).toThrow(/not defined in EnergyPlus 26.1.0/);
  });

  it('enforces singletons', () => {
    doc.add('Building', 'B1');
    expect(() => doc.add('Building', 'B2')).toThrow(/singleton/);
  });

  it('accepts null for anonymous types', () => {
    const timestep = doc.add('Timestep', null, { number_of_timesteps_per_hour: 6 });
    expect(timestep.isNamed).toBe(false);
  });
});

describe('field access', () => {
  it('exposes fields as real properties, not a Proxy', () => {
    const zone = doc.add('Zone', 'Z1', { x_origin: 3 });

    // A real accessor lives on the prototype. This is what makes the generated
    // .d.ts describe something that actually exists.
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(zone) as object,
      'x_origin'
    );
    expect(descriptor?.get).toBeTypeOf('function');
    expect(zone['x_origin' as keyof typeof zone]).toBe(3);
  });

  it('shares one prototype across instances of a type', () => {
    const a = doc.add('Zone', 'Z1');
    const b = doc.add('Zone', 'Z2');
    expect(Object.getPrototypeOf(a)).toBe(Object.getPrototypeOf(b));
  });

  it('shares one shape across versions with an identical definition', async () => {
    // The payoff of content-addressing the schema: if Zone did not change
    // between two releases, both versions resolve to the same frozen definition
    // and therefore the same prototype, so mixed-version work stays monomorphic.
    const v25 = await schema('25.2.0');
    const other = new IDFDocument(v25);

    const a = doc.add('Zone', 'Z1');
    const b = other.add('Zone', 'Z1');
    expect(v26.get('Zone')).toBe(v25.get('Zone'));
    expect(shapeOf(a)).toBe(shapeOf(b));
  });

  it('rejects writes to fields the schema does not define', () => {
    const zone = doc.add('Zone', 'Z1');
    expect(() => zone.set('not_a_field', 1)).toThrow(/not a field of Zone/);
  });

  it('deletes a field when set to undefined', () => {
    const zone = doc.add('Zone', 'Z1', { x_origin: 3 });
    zone.set('x_origin', undefined);
    expect(zone.get('x_origin')).toBeUndefined();
    expect(zone.toJSON()).not.toHaveProperty('x_origin');
  });

  it('clones detached, without an owner', () => {
    const zone = doc.add('Zone', 'Z1', { x_origin: 3 });
    const copy = zone.clone('Z2');

    expect(copy.name).toBe('Z2');
    expect(copy.get('x_origin')).toBe(3);
    expect(doc.all('Zone').size).toBe(1);

    doc.attach(copy);
    expect(doc.all('Zone').size).toBe(2);
  });

  it('deep-copies extensible groups on clone', () => {
    const surface = doc.add('BuildingSurface:Detailed', 'S1');
    surface.extensible.push({ vertex_x_coordinate: 1 });

    const copy = surface.clone('S2');
    copy.extensible[0]!['vertex_x_coordinate'] = 99;

    expect(surface.extensible[0]?.['vertex_x_coordinate']).toBe(1);
  });
});

describe('remove', () => {
  it('removes an object and drops its reference edges', () => {
    doc.add('Zone', 'Z1');
    const surface = doc.add('BuildingSurface:Detailed', 'S1', { zone_name: 'Z1' });

    expect(doc.references.isReferenced('Z1')).toBe(true);
    expect(doc.remove(surface)).toBe(true);
    expect(doc.references.isReferenced('Z1')).toBe(false);
    expect(doc.all('BuildingSurface:Detailed').size).toBe(0);
  });

  it('returns false for an object that is not in the document', () => {
    const detached = doc.add('Zone', 'Z1').clone('Z2');
    expect(doc.remove(detached)).toBe(false);
  });
});

describe('collections', () => {
  it('preserves insertion order', () => {
    for (const name of ['C', 'A', 'B']) doc.add('Zone', name);
    expect(doc.all('Zone').names()).toEqual(['C', 'A', 'B']);
  });

  it('looks up case-insensitively', () => {
    doc.add('Zone', 'Zone One');
    expect(doc.all('Zone').get('ZONE ONE')?.name).toBe('Zone One');
  });

  it('filters by field value', () => {
    doc.add('Zone', 'Z1');
    doc.add('BuildingSurface:Detailed', 'S1', { surface_type: 'Wall' });
    doc.add('BuildingSurface:Detailed', 'S2', { surface_type: 'Roof' });

    const walls = doc.all('BuildingSurface:Detailed').where('surface_type', 'wall');
    expect(walls.map((s) => s.name)).toEqual(['S1']);
  });

  it('reports the only object of a singleton type', () => {
    doc.add('Building', 'B1');
    expect(doc.all('Building').only?.name).toBe('B1');
    doc.add('Zone', 'Z1');
    doc.add('Zone', 'Z2');
    expect(doc.all('Zone').only).toBeUndefined();
  });

  it('throws a useful error from require', () => {
    expect(() => doc.require('Zone', 'Nope')).toThrow('No Zone named "Nope"');
  });
});
