import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { IdfDocument, parseIdf, shapeOf } from '@idfkit/core';
import type { Schema } from '@idfkit/schemas';

import { schema } from './helpers.js';

let v26: Schema;
beforeAll(async () => {
  v26 = await schema('26.1.0');
});

let doc: IdfDocument;
beforeEach(() => {
  doc = new IdfDocument(v26);
});

describe('IdfDocument.add', () => {
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
    const other = new IdfDocument(v25);

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

/**
 * Type-name-keyed lookup: case folding, unknown names, no mutation on read.
 *
 * The companion Python suite is `idfkit/tests/test_type_name_lookup.py`, and the
 * two must stay in step. The one case with no counterpart here is the
 * schemaless document: every `IdfDocument` is bound to a schema at
 * construction, so the Python side carries that case alone.
 */
describe('type-name lookup', () => {
  beforeEach(() => {
    doc.add('Zone', 'Perimeter_ZN_1');
    doc.add('Zone', 'Core_ZN');
    doc.add('ScheduleTypeLimits', 'Any Number');
  });

  it('finds the objects under the canonical name', () => {
    expect([...doc.all('Zone')].map((z) => z.name)).toEqual(['Perimeter_ZN_1', 'Core_ZN']);
  });

  it.each(['zone', 'ZONE', 'ZoNe', 'zOnE'])('finds the same objects for %s', (written) => {
    expect([...doc.all(written)].map((z) => z.name)).toEqual(['Perimeter_ZN_1', 'Core_ZN']);
  });

  it('recovers internal capitals no casing rule could', () => {
    // "scheduletypelimits" carries no casing information, so only a schema
    // lookup gets back to "ScheduleTypeLimits".
    expect(doc.all('scheduletypelimits').size).toBe(1);
    expect(doc.all('SCHEDULETYPELIMITS').size).toBe(1);
  });

  it('does not treat a colon as a word boundary', () => {
    doc.add('Output:Variable', null, {
      key_value: '*',
      variable_name: 'Zone Air Temperature',
      reporting_frequency: 'Hourly',
    });
    expect(doc.all('output:variable').size).toBe(1);
    expect(doc.all('OuTpUt:VaRiAbLe').size).toBe(1);
  });

  it('folds case in has, get and require too', () => {
    expect(doc.has('zone')).toBe(true);
    expect(doc.get('ZONE', 'Core_ZN')?.name).toBe('Core_ZN');
    expect(doc.require('zOnE', 'Core_ZN').name).toBe('Core_ZN');
  });

  it('returns an empty collection for an unknown type name rather than throwing', () => {
    expect(doc.all('Zoen').size).toBe(0);
    expect(doc.has('Zoen')).toBe(false);
  });

  it('keeps the written spelling on a collection nothing resolves', () => {
    expect(doc.all('Zoen').typeName).toBe('Zoen');
  });

  it('still rejects the typo on the paths that write', () => {
    expect(() => doc.add('Zoen', 'X')).toThrow(/not defined in EnergyPlus/);
    expect(doc.schema.has('Zoen')).toBe(false);
    expect(doc.schema.resolve('zone')).toBe('Zone');
  });

  it('adds no collection when an absent or unknown type is read', () => {
    const before = doc.types();
    for (const name of ['Lights', 'People', 'Zoen', 'NotAThing', 'zone', 'ZONE']) {
      doc.all(name);
      doc.has(name);
    }
    expect(doc.types()).toEqual(before);
  });

  it('hands back a detached collection for an absent type', () => {
    expect(doc.all('Lights')).not.toBe(doc.all('Lights'));
    expect(doc.types()).not.toContain('Lights');
  });

  it('leaves toJSON clean after probing', () => {
    for (const name of ['Zoen', 'NotAThing', 'Lights']) doc.all(name);
    expect(Object.keys(doc.toJSON())).toEqual(['Zone', 'ScheduleTypeLimits']);
  });

  it('files a mis-cased add under the canonical key', () => {
    const fresh = new IdfDocument(v26);
    fresh.add('zONE', 'Z1');
    expect(fresh.types()).toEqual(['Zone']);
  });
});

/**
 * The two facts the language service's correlation rests on (research R6).
 *
 * `@idfkit/language` positions a validation finding by matching the object it names against the
 * statements in the text: by folded type name and folded object name for a named object, and by
 * folded type name and ordinal for an anonymous one. Neither key is sound on its own; each is sound
 * only because of behaviour these two tests pin down. Both are asserted rather than trusted because
 * a change to either breaks correlation *silently*: findings keep arriving, they just start
 * underlining the wrong object, and no other test in either repository would notice.
 */
describe('what positioning a finding depends on', () => {
  it('never lets a document parsed from text hold two objects of one type under one name', () => {
    // Without this the name key would be ambiguous, and duplicate names are common in real files.
    // `addRaw` throws on the second one, `parseIdf` catches that, records a `ParseError` and skips
    // the object, so the duplicate reaches a reader as a reading finding positioned by the scanner
    // that saw it, and never reaches correlation at all.
    doc.addRaw('Zone', 'Zone One');
    expect(() => doc.addRaw('Zone', 'Zone One')).toThrow(/already exists/);
    // Folded, because that is the key correlation uses and the key a collection stores under.
    expect(() => doc.addRaw('Zone', 'ZONE ONE')).toThrow(/already exists/);

    const text = [
      'Version, 26.1;',
      '',
      'Zone,',
      '  Zone One,',
      '  0.0;',
      '',
      'Zone,',
      '  Zone One,',
      '  90.0;',
      '',
    ].join('\n');
    const parsed = parseIdf(text, v26, { strict: false });

    expect(parsed.diagnostics.map((d) => d.code)).toEqual(['ParseError']);
    expect(parsed.diagnostics[0]?.line).toBe(7);
    // The first statement is the one the document kept, so a finding about this type and this name
    // is a finding about the first statement in the text.
    expect(parsed.document.all('Zone').size).toBe(1);
    expect(parsed.document.require('Zone', 'Zone One').get('direction_of_relative_north')).toBe(0);
  });

  it('preserves insertion order, so the Nth object of a type is the Nth statement', () => {
    // The ordinal key serves anonymous objects, whose findings carry an empty `objName` and so
    // cannot be correlated by name at all. It is sound only while `parseIdf` adds in source order
    // and `IdfCollection` hands the objects back in the order they were inserted.
    for (const name of ['C', 'A', 'B']) doc.add('Zone', name);
    expect([...doc.all('Zone')].map((zone) => zone.name)).toEqual(['C', 'A', 'B']);

    const text = [
      'Version, 26.1;',
      '',
      'Output:Variable, *, Zone Air Temperature, Hourly;',
      'Output:Variable, *, Site Outdoor Air Drybulb Temperature, Hourly;',
      'Output:Variable, *, Zone Mean Air Temperature, Daily;',
      '',
    ].join('\n');
    const { document } = parseIdf(text, v26, { strict: false });

    expect([...document.all('Output:Variable')].map((obj) => obj.get('variable_name'))).toEqual([
      'Zone Air Temperature',
      'Site Outdoor Air Drybulb Temperature',
      'Zone Mean Air Temperature',
    ]);
  });
});
