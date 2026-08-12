import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseIdf, SchemaBundle, writeIdf, type BundleSource } from '@idfkit/core';
import { loadIdf, saveIdf } from '@idfkit/core/node';
import { readBundleFileSync } from '@idfkit/schemas/node';

import type { TypeMap } from '../src/types/v26-1.js';

/**
 * The examples from the README and package docs, executed.
 *
 * Documentation that has never been run is documentation that is wrong, usually
 * within one refactor. These are the published snippets, not paraphrases.
 */
let dir: string;
let modelPath: string;

const MODEL = `
Version, 26.1;

Zone,
  SPACE1-1,      !- Name
  0,             !- Direction of Relative North
  0, 0, 0,       !- Origin
  1,             !- Type
  1,             !- Multiplier
  2.7;           !- Ceiling Height

BuildingSurface:Detailed,
  Wall-1, Wall, C1, SPACE1-1, , Outdoors, , SunExposed, WindExposed, 0.5, 3,
  0.0, 0.0, 3.0,
  0.0, 0.0, 0.0,
  5.0, 0.0, 0.0;
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'idfkit-readme-'));
  modelPath = join(dir, 'model.idf');
  writeFileSync(modelPath, MODEL, 'latin1');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('README quickstart', () => {
  it('loads, iterates, renames, and saves', async () => {
    const doc = await loadIdf<TypeMap>(modelPath, { strict: false });

    const names: string[] = [];
    for (const zone of doc.all('Zone')) {
      names.push(zone.name);
      expect(zone.ceiling_height).toBe(2.7);
    }
    expect(names).toEqual(['SPACE1-1']);

    doc.require('Zone', 'SPACE1-1').name = 'Open Office';

    const outPath = join(dir, 'model-renamed.idf');
    await saveIdf(doc, outPath);

    const reloaded = await loadIdf<TypeMap>(outPath, { strict: false });
    expect(reloaded.all('Zone').names()).toEqual(['Open Office']);
    expect(reloaded.require('BuildingSurface:Detailed', 'Wall-1').zone_name).toBe('Open Office');
  });
});

describe('core README usage', () => {
  it('runs the collection and reference examples', async () => {
    const doc = await loadIdf<TypeMap>(modelPath, { strict: false });

    const zones = doc.all('Zone');
    expect(zones.size).toBe(1);
    expect(zones.get('SPACE1-1')?.ceiling_height).toBe(2.7);
    expect(zones.map((z) => z.name)).toEqual(['SPACE1-1']);

    expect(doc.references.referencingObjects('SPACE1-1').map((o) => o.name)).toEqual(['Wall-1']);
  });

  it('runs the object creation example', async () => {
    const doc = await loadIdf<TypeMap>(modelPath, { strict: false });

    const zone = doc.add('Zone', 'Open Office', { ceiling_height: 2.7, multiplier: 1 });

    const surface = doc.add('BuildingSurface:Detailed', 'Wall-2', {
      surface_type: 'Wall',
      zone_name: 'Open Office',
    });
    surface.extensible.push({
      vertex_x_coordinate: 0,
      vertex_y_coordinate: 0,
      vertex_z_coordinate: 3,
    });

    zone.name = 'Open Plan';
    expect(surface.zone_name).toBe('Open Plan');
    expect(surface.extensible).toHaveLength(1);
  });

  it('runs the browser-style example against a non-filesystem source', async () => {
    // Stands in for `httpSource`: the point is that SchemaBundle only needs a
    // `read(fileName)`, so the same code path works over fetch in a browser.
    const source: BundleSource = {
      read: (fileName) => Promise.resolve(readBundleFileSync(fileName)),
    };
    const bundle = new SchemaBundle(source);
    const schema = await bundle.load('26.1.0');

    const { document, diagnostics } = parseIdf(MODEL, schema, { strict: false });
    expect(diagnostics).toEqual([]);
    expect(writeIdf(document)).toContain('SPACE1-1');
  });

  it('runs the diagnostics example', async () => {
    const schema = await new SchemaBundle({
      read: (fileName) => Promise.resolve(readBundleFileSync(fileName)),
    }).load('26.1.0');

    const { diagnostics } = parseIdf(`${MODEL}\nNotAThing, X;`, schema, { strict: false });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.line).toBeGreaterThan(0);
  });
});

describe('README simulation handoff', () => {
  /**
   * The engine half of the snippet cannot run here: `@idfkit/engine` is not a
   * dependency of this repo, and it needs a browser and a ~28 MB WASM binary.
   * What is testable is our side of the seam — that the IDF text handed to
   * `ep.run({ idf })` is what the edited document actually says — and that is
   * the half that breaks when this library changes.
   */
  it('produces the IDF text the engine is handed', async () => {
    const schema = await new SchemaBundle({
      read: (fileName) => Promise.resolve(readBundleFileSync(fileName)),
    }).load('26.1.0');

    const { document } = parseIdf<TypeMap>(MODEL, schema, { strict: false });
    document.require('Zone', 'SPACE1-1').ceiling_height = 3;

    const idf = writeIdf(document);

    // Round-trips as a whole model, not just as a string containing the edit:
    // this is exactly what the engine will parse.
    const reparsed = parseIdf<TypeMap>(idf, schema, { strict: false });
    expect(reparsed.diagnostics).toEqual([]);
    expect(reparsed.document.require('Zone', 'SPACE1-1').ceiling_height).toBe(3);
    expect(idf).toMatch(/^Version,/m);
  });
});

describe('schemas README usage', () => {
  it('runs the bundle and diff examples', async () => {
    const bundle = new SchemaBundle({
      read: (fileName) => Promise.resolve(readBundleFileSync(fileName)),
    });

    expect(await bundle.latest()).toBe('26.1.0');

    const schema = await bundle.load('26.1.0');
    expect(schema.resolve('ZONE')).toBe('Zone');
    expect(schema.field('Zone', 'x_origin')).toMatchObject({ t: 'n', u: 'm' });

    const delta = schema.changedFrom(await bundle.load('9.4.0'));
    expect(delta.added).toContain('Space');

    const a = await bundle.load('25.2.0');
    expect(a.get('Zone')).toBe(schema.get('Zone'));
  });
});
