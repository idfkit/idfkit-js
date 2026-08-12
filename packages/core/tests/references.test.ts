import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { IDFDocument } from '@idfkit/core';
import type { Schema } from '@idfkit/schemas';

import { schema } from './helpers.js';

let v26: Schema;
beforeAll(async () => {
  v26 = await schema('26.1.0');
});

let doc: IDFDocument;
beforeEach(() => {
  doc = new IDFDocument(v26);
  doc.add('Zone', 'Z1');
  doc.add('Construction', 'C1', { outside_layer: 'M1' });
  doc.add('BuildingSurface:Detailed', 'S1', { zone_name: 'Z1', construction_name: 'C1' });
  doc.add('BuildingSurface:Detailed', 'S2', { zone_name: 'Z1', construction_name: 'C1' });
});

describe('ReferenceGraph', () => {
  it('indexes references made at construction time', () => {
    expect(
      doc.references
        .referencingObjects('Z1')
        .map((o) => o.name)
        .sort()
    ).toEqual(['S1', 'S2']);
  });

  it('records which field holds each reference', () => {
    const edges = doc.references.referencing('C1');
    expect(edges.map((e) => e.field)).toEqual(['construction_name', 'construction_name']);
  });

  it('matches names case-insensitively', () => {
    expect(doc.references.isReferenced('z1')).toBe(true);
  });

  it('updates when a reference field is reassigned', () => {
    doc.add('Zone', 'Z2');
    const surface = doc.require('BuildingSurface:Detailed', 'S1');
    surface.set('zone_name', 'Z2');

    expect(doc.references.referencingObjects('Z1').map((o) => o.name)).toEqual(['S2']);
    expect(doc.references.referencingObjects('Z2').map((o) => o.name)).toEqual(['S1']);
  });

  it('does not index non-reference fields', () => {
    const surface = doc.require('BuildingSurface:Detailed', 'S1');
    surface.set('surface_type', 'Wall');
    expect(doc.references.isReferenced('Wall')).toBe(false);
  });

  it('lists the names an object points at', () => {
    const surface = doc.require('BuildingSurface:Detailed', 'S1');
    expect(doc.references.referencedBy(surface).sort()).toEqual(['C1', 'Z1']);
  });

  it('finds dangling references', () => {
    // M1 was never created, so Construction C1's outside_layer points nowhere.
    const dangling = doc.danglingReferences();
    expect(dangling.map((e) => e.target)).toEqual(['M1']);
  });
});

describe('rename', () => {
  it('rewrites every referencing field', () => {
    doc.rename(doc.require('Zone', 'Z1'), 'Zone One');

    expect(doc.require('BuildingSurface:Detailed', 'S1').get('zone_name')).toBe('Zone One');
    expect(doc.require('BuildingSurface:Detailed', 'S2').get('zone_name')).toBe('Zone One');
  });

  it('happens on plain property assignment too', () => {
    const zone = doc.require('Zone', 'Z1');
    zone.name = 'Zone One';
    expect(doc.require('BuildingSurface:Detailed', 'S1').get('zone_name')).toBe('Zone One');
  });

  it('re-keys the collection', () => {
    doc.rename(doc.require('Zone', 'Z1'), 'Zone One');

    expect(doc.all('Zone').has('Z1')).toBe(false);
    expect(doc.all('Zone').get('Zone One')?.name).toBe('Zone One');
  });

  it('preserves collection order', () => {
    doc.add('Zone', 'Z2');
    doc.add('Zone', 'Z3');
    doc.rename(doc.require('Zone', 'Z1'), 'Renamed');
    // Delete-then-insert would move the renamed zone to the end, which shows up
    // as a spurious reordering the next time the file is written.
    expect(doc.all('Zone').names()).toEqual(['Renamed', 'Z2', 'Z3']);
  });

  it('leaves the reference index consistent afterwards', () => {
    doc.rename(doc.require('Zone', 'Z1'), 'Zone One');

    expect(doc.references.isReferenced('Z1')).toBe(false);
    expect(doc.references.referencingObjects('Zone One')).toHaveLength(2);
    // And a second rename still works, i.e. the edges were rebuilt not orphaned.
    doc.rename(doc.require('Zone', 'Zone One'), 'Final');
    expect(doc.require('BuildingSurface:Detailed', 'S1').get('zone_name')).toBe('Final');
  });

  it('rejects a rename that would collide', () => {
    doc.add('Zone', 'Z2');
    expect(() => doc.rename(doc.require('Zone', 'Z1'), 'Z2')).toThrow(/already exists/);
    // And nothing was mutated before the throw.
    expect(doc.all('Zone').has('Z1')).toBe(true);
    expect(doc.require('BuildingSurface:Detailed', 'S1').get('zone_name')).toBe('Z1');
  });

  it('is a no-op when the name is unchanged', () => {
    doc.rename(doc.require('Zone', 'Z1'), 'Z1');
    expect(doc.references.referencingObjects('Z1')).toHaveLength(2);
  });
});
