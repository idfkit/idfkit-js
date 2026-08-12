import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { IDFDocument, parseIdf, writeEpJson, writeIdf } from '@idfkit/core';
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

describe('writeIdf', () => {
  it('writes an object with aligned field comments', () => {
    doc.add('Zone', 'Z1', { x_origin: 1.5, y_origin: 2.5 });
    const text = writeIdf(doc);

    expect(text).toContain('Zone,');
    expect(text).toMatch(/Z1, +!- Name/);
    expect(text).toMatch(/1\.5, +!- X Origin/);
  });

  it('omits comments when asked', () => {
    doc.add('Zone', 'Z1', { x_origin: 1.5 });
    expect(writeIdf(doc, { comments: false })).not.toContain('!-');
  });

  it('keeps a decimal point on real-valued fields', () => {
    // JavaScript has one number type, so 3 and 3.0 are indistinguishable at
    // runtime. Without consulting the schema every real field would be written
    // as a bare integer.
    doc.add('Zone', 'Z1', { x_origin: 3 });
    expect(writeIdf(doc)).toMatch(/3\.0; +!- X Origin/);
  });

  it('writes integer fields without a decimal point', () => {
    doc.add('Timestep', null, { number_of_timesteps_per_hour: 6 });
    const text = writeIdf(doc);
    expect(text).toMatch(/\n {4}6;/);
    expect(text).not.toContain('6.0');
  });

  it('drops trailing unset fields rather than emitting bare commas', () => {
    doc.add('Zone', 'Z1', { x_origin: 1 });
    const lines = writeIdf(doc).trim().split('\n');
    expect(lines.at(-1)?.trim()).toMatch(/^1\.0;/);
  });

  it('preserves interior unset fields so positions stay aligned', () => {
    doc.add('Zone', 'Z1', { x_origin: 1, z_origin: 3 });
    const text = writeIdf(doc);
    // y_origin is unset but must still occupy its slot.
    expect(text).toMatch(/,\s+!- Y Origin/);
    expect(text).toMatch(/3\.0;\s+!- Z Origin/);
  });

  it('writes Version first regardless of insertion order', () => {
    doc.add('Zone', 'Z1');
    doc.add('Version', null, { version_identifier: '26.1' });
    expect(writeIdf(doc).trimStart().startsWith('Version,')).toBe(true);
  });

  it('writes extensible groups in order', () => {
    const surface = doc.add('BuildingSurface:Detailed', 'S1');
    surface.extensible.push(
      { vertex_x_coordinate: 0, vertex_y_coordinate: 0, vertex_z_coordinate: 3 },
      { vertex_x_coordinate: 5, vertex_y_coordinate: 0, vertex_z_coordinate: 3 }
    );

    const text = writeIdf(doc);
    expect(text).toMatch(/0\.0, +!- Vertex X Coordinate/);
    expect(text).toMatch(/5\.0, +!- Vertex X Coordinate/);
    expect(text.trimEnd().endsWith('!- Vertex Z Coordinate')).toBe(true);
    expect(text).toMatch(/3\.0; +!- Vertex Z Coordinate/);
  });

  it('re-parses to an equivalent document', () => {
    doc.add('Version', null, { version_identifier: '26.1' });
    doc.add('Zone', 'Zone One', { x_origin: 1.5, ceiling_height: 2.7 });
    doc.add('BuildingSurface:Detailed', 'S1', { zone_name: 'Zone One', surface_type: 'Wall' });

    const reparsed = parseIdf(writeIdf(doc), v26).document;

    expect(reparsed.toJSON()).toEqual(doc.toJSON());
  });
});

describe('writeEpJson', () => {
  it('nests type, name, then fields', () => {
    doc.add('Zone', 'Z1', { x_origin: 1.5 });
    const json = JSON.parse(writeEpJson(doc)) as Record<string, unknown>;

    expect(json).toEqual({ Zone: { Z1: { x_origin: 1.5 } } });
  });

  it('gives anonymous objects the key EnergyPlus expects', () => {
    doc.add('Timestep', null, { number_of_timesteps_per_hour: 6 });
    const json = JSON.parse(writeEpJson(doc)) as Record<string, unknown>;

    expect(json).toEqual({ Timestep: { 'Timestep 1': { number_of_timesteps_per_hour: 6 } } });
  });

  it('omits types with no objects', () => {
    doc.all('Zone'); // touching a type creates an empty collection
    expect(JSON.parse(writeEpJson(doc))).toEqual({});
  });
});
