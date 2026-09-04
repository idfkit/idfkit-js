import { afterEach, describe, expect, it, vi } from 'vitest';

import { httpSource } from '@idfkit/schemas';
import { localBundle, nodeSource } from '@idfkit/schemas/node';

const bundle = localBundle();

describe('httpSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves a relative base against the document base, like fetch does', async () => {
    // Regression: `new URL(fileName, base)` threw "Invalid URL" for a relative
    // base such as '/schemas/' — the natural thing to write in a browser app,
    // and the schemas README's own example.
    const seen: string[] = [];
    vi.stubGlobal('location', { href: 'https://app.example/demo/' });
    vi.stubGlobal('fetch', async (url: URL) => {
      seen.push(url.href);
      return new Response('', { status: 200 });
    });

    const source = httpSource('/schemas/');
    await source.read('index.json').catch(() => undefined);

    expect(seen).toEqual(['https://app.example/schemas/index.json.gz']);
  });

  it('leaves an absolute base untouched', async () => {
    const seen: string[] = [];
    vi.stubGlobal('location', { href: 'https://app.example/demo/' });
    vi.stubGlobal('fetch', async (url: URL) => {
      seen.push(url.href);
      return new Response('', { status: 200 });
    });

    const source = httpSource('https://cdn.example/schemas');
    await source.read('index.json').catch(() => undefined);

    expect(seen).toEqual(['https://cdn.example/schemas/index.json.gz']);
  });
});

describe('SchemaBundle', () => {
  it('ships every supported EnergyPlus version', async () => {
    const versions = await bundle.versions();
    expect(versions.length).toBe(17);
    expect(versions[0]).toBe('8.9.0');
    expect(versions.at(-1)).toBe('26.1.0');
  });

  it('sorts versions numerically, not lexically', async () => {
    // Plain string sort puts 8.9.0 after 22.1.0, which would make `latest()`
    // return the wrong schema.
    const versions = await bundle.versions();
    expect(versions.indexOf('8.9.0')).toBeLessThan(versions.indexOf('9.0.1'));
    expect(versions.indexOf('9.6.0')).toBeLessThan(versions.indexOf('22.1.0'));
    expect(await bundle.latest()).toBe('26.1.0');
  });

  it('returns the same instance for repeat loads', async () => {
    const a = await bundle.load('26.1.0');
    const b = await bundle.load('26.1.0');
    expect(a).toBe(b);
  });

  it('shares one fetch between concurrent loads', async () => {
    const fresh = localBundle();
    const [a, b] = await Promise.all([fresh.load('24.1.0'), fresh.load('24.1.0')]);
    expect(a).toBe(b);
  });

  it('rejects an unknown version with the available list', async () => {
    await expect(bundle.load('7.0.0')).rejects.toThrow(/not in this bundle/);
  });
});

describe('Schema', () => {
  it('resolves type names case-insensitively', async () => {
    const schema = await bundle.load('26.1.0');
    expect(schema.resolve('ZONE')).toBe('Zone');
    expect(schema.resolve('buildingsurface:detailed')).toBe('BuildingSurface:Detailed');
    expect(schema.resolve('NotAThing')).toBeUndefined();
  });

  it('exposes field definitions', async () => {
    const schema = await bundle.load('26.1.0');
    expect(schema.field('Zone', 'x_origin')).toMatchObject({ t: 'n', u: 'm' });
    expect(schema.field('Timestep', 'number_of_timesteps_per_hour')).toMatchObject({ t: 'i' });
  });

  it('marks reference fields in both directions', async () => {
    const schema = await bundle.load('26.1.0');
    // A foreign key: points into a reference list.
    expect(schema.field('BuildingSurface:Detailed', 'zone_name')?.ol).toContain('ZoneNames');
    // And the Zone name contributes to that list.
    expect(schema.get('Zone')?.nref).toContain('ZoneNames');
  });

  it('records extensible groups with their inner field types', async () => {
    const schema = await bundle.load('26.1.0');
    const extensible = schema.get('BuildingSurface:Detailed')?.x;

    expect(extensible?.key).toBe('vertices');
    expect(extensible?.fields).toEqual([
      'vertex_x_coordinate',
      'vertex_y_coordinate',
      'vertex_z_coordinate',
    ]);
    expect(extensible?.p['vertex_x_coordinate']).toMatchObject({ t: 'n' });
  });

  it('keeps both branches of an anyOf field', async () => {
    const schema = await bundle.load('26.1.0');

    // The numeric branch is hoisted onto the record; `se` is the string branch's
    // enum, verbatim. Which literal a field takes is a property of the field:
    // 10565 across the versions take `Autosize` and 1781 take `Autocalculate`,
    // so a consumer cannot assume one of them.
    expect(schema.field('Zone', 'ceiling_height')).toMatchObject({
      t: 'n',
      auto: 1,
      se: ['', 'Autocalculate'],
    });
    expect(
      schema.field('DesignSpecification:ZoneHVAC:Sizing', 'cooling_design_capacity')
    ).toMatchObject({
      auto: 1,
      se: ['Autosize'],
      min: 0,
    });
  });

  it('says "any string" by leaving se off, not by leaving it empty', async () => {
    const schema = await bundle.load('26.1.0');

    // 646 fields put no enum on the string branch at all: the slot holds a
    // number or the name of a variable. `se: ['']` would be the opposite claim,
    // and is what the 68 numeric-choice fields carry.
    const block = schema.field(
      'UtilityCost:Charge:Block',
      'block_1_cost_per_unit_value_or_variable_name'
    );
    expect(block).toMatchObject({ t: 'n', auto: 1 });
    expect(block?.se).toBeUndefined();

    const screen = schema.field(
      'WindowMaterial:Screen',
      'angle_of_resolution_for_screen_transmittance_output_map'
    );
    expect(screen).toMatchObject({ auto: 1, e: [0, 1, 2, 3, 5], se: [''] });
  });

  it('flags the integer branch of an anyOf, not just the number branch', async () => {
    const schema = await bundle.load('26.1.0');

    // Eight fields across the versions declare `anyOf: [{integer}, {string}]`.
    // Matching only `number` left this one with no `auto` flag and a default of
    // `Autosize` that its own declared type rejects.
    expect(
      schema.field('AirTerminal:SingleDuct:ConstantVolume:CooledBeam', 'number_of_beams')
    ).toMatchObject({ t: 'i', auto: 1, se: ['', 'Autosize'], d: 'Autosize' });
  });

  it('carries exclusive bounds in whichever dialect the version shipped', async () => {
    // 8.9.0 through 9.5.0 are draft-04, where the keyword is a flag qualifying
    // the sibling bound. 9.6.0 on are draft-06+, where it is the bound.
    const older = await bundle.load('9.4.0');
    const newer = await bundle.load('26.1.0');

    expect(older.field('Material', 'thickness')).toMatchObject({ min: 0, xmin: true });
    expect(newer.field('Material', 'thickness')).toMatchObject({ xmin: 0 });
    expect(newer.field('Material', 'thickness')?.min).toBeUndefined();
  });

  it('flags singletons and anonymous types', async () => {
    const schema = await bundle.load('26.1.0');
    expect(schema.get('Building')?.s).toBe(1);
    expect(schema.get('Version')?.anon).toBe(1);
    expect(schema.get('Zone')?.anon).toBeUndefined();
  });

  it('shares definitions across versions when they are identical', async () => {
    // The whole point of content-addressing: 17 versions cost barely more than
    // one, because most object types never change between releases.
    const a = await bundle.load('25.2.0');
    const b = await bundle.load('26.1.0');
    expect(a.get('Zone')).toBe(b.get('Zone'));
  });

  it('freezes definitions so a shared blob cannot be mutated', async () => {
    const schema = await bundle.load('26.1.0');
    expect(Object.isFrozen(schema.get('Zone'))).toBe(true);
  });

  it('diffs two versions by manifest comparison', async () => {
    const older = await bundle.load('9.4.0');
    const newer = await bundle.load('26.1.0');
    const delta = newer.changedFrom(older);

    expect(delta.added.length).toBeGreaterThan(0);
    expect(delta.changed.length).toBeGreaterThan(0);
    // Types are only listed once, and never in two buckets at the same time.
    const overlap = delta.added.filter((t) => delta.changed.includes(t));
    expect(overlap).toEqual([]);
  });

  it('reflects real schema evolution between versions', async () => {
    const v9 = await bundle.load('9.4.0');
    const v26 = await bundle.load('26.1.0');

    // `Space` was introduced well after 9.4.
    expect(v9.has('Space')).toBe(false);
    expect(v26.has('Space')).toBe(true);
  });
});

/**
 * Feature 002, US2: the prose pool, and the three field orders it ships beside.
 *
 * These assert the shape of the bundle rather than the description built from
 * it, because a pool that is present but wrongly indexed produces prose that
 * looks plausible and belongs to another field.
 */
describe('the prose pool', () => {
  it('ships as its own file under data/', async () => {
    const pool = (await nodeSource().read('docs.json')) as string[];

    expect(Array.isArray(pool)).toBe(true);
    expect(pool.length).toBeGreaterThan(4000);
  });

  it('holds every string once, and no empties', async () => {
    const pool = (await nodeSource().read('docs.json')) as string[];

    // Deduplication is the whole reason the pool is affordable: 4,878 distinct
    // strings stand in for roughly 119,000 occurrences across the 17 versions.
    // A duplicate means the interning broke and the file is paying twice.
    expect(new Set(pool).size).toBe(pool.length);
    expect(pool.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
  });

  it('is sorted, so the numbering does not depend on read order', async () => {
    const pool = (await nodeSource().read('docs.json')) as string[];

    // The index a record carries is decided before any record is hashed, and a
    // content-addressed bundle cannot afford for that numbering to move. Sorted
    // is what makes it reproducible on a different machine.
    expect([...pool].sort()).toEqual(pool);
  });

  it('is reachable without going near the parse path', async () => {
    // The pool is read through the ordinary bundle source, the same way the
    // manifests and the type store are. There is no new export and no new
    // entry point, so nothing on the read-and-write graph can reach it by
    // accident. `check-bundle-purity.mjs` is the gate that proves the negative;
    // this asserts the positive half, that a caller who wants it can have it.
    const pool = await nodeSource().read('docs.json');

    expect(pool).toBeDefined();
  });

  it('is referenced by index from the type records, never inlined', async () => {
    const store = (await nodeSource().read('types.json')) as Record<string, unknown>;
    const pool = (await nodeSource().read('docs.json')) as string[];

    const records = Object.values(store) as {
      m?: number;
      p?: Record<string, { n?: number }>;
    }[];

    const withMemo = records.filter((r) => r.m !== undefined);
    expect(withMemo.length).toBeGreaterThan(0);
    // Every reference resolves. An index past the end would render as undefined
    // prose, which reads exactly like a type that has none.
    expect(withMemo.every((r) => r.m! >= 0 && r.m! < pool.length)).toBe(true);

    const noteRefs = records.flatMap((r) => Object.values(r.p ?? {}).map((f) => f.n));
    const present = noteRefs.filter((n): n is number => n !== undefined);
    expect(present.length).toBeGreaterThan(0);
    expect(present.every((n) => n >= 0 && n < pool.length)).toBe(true);
  });
});

describe('field order and accepted values in the bundle', () => {
  /**
   * T028: exactly three types need `fo`, and no fourth may silently join them.
   *
   * `fo` is emitted only where `f` holds at most the name and the type has more
   * than one property, which is the condition under which the description path
   * would otherwise fall back to the alphabetized key list. If a future schema
   * adds a fourth such type, this fails and somebody decides deliberately,
   * rather than a reader quietly getting the wrong field order.
   */
  it('records declaration order for exactly three types, in every version', async () => {
    const index = (await nodeSource().read('index.json')) as { versions: string[] };
    const store = (await nodeSource().read('types.json')) as Record<string, { fo?: string[] }>;

    for (const version of index.versions) {
      const manifest = (await nodeSource().read(
        `manifest-${version.replace(/\./g, '-')}.json`
      )) as Record<string, string>;

      const withOrder = Object.entries(manifest)
        .filter(([, hash]) => store[hash]?.fo !== undefined)
        .map(([typeName]) => typeName)
        .sort();

      // `bySurfaceName` in 8.9.0 through 9.3.0, `BySurfaceName` after.
      expect(withOrder.map((n) => n.toLowerCase())).toEqual([
        'solarcollector:unglazedtranspired:multisystem',
        'zoneproperty:userviewfactors:bysurfacename',
        'zoneterminalunitlist',
      ]);
    }
  });

  it('flags the blank enum rather than admitting it into the validated list', async () => {
    const store = (await nodeSource().read('types.json')) as Record<
      string,
      { p?: Record<string, { e?: unknown[]; eb?: 1 }> }
    >;

    const fields = Object.values(store).flatMap((t) => Object.values(t.p ?? {}));
    const flagged = fields.filter((f) => f.eb === 1);

    expect(flagged.length).toBeGreaterThan(0);
    // The flag says the blank was there; `e` must still not contain it, because
    // `e` is what validate() checks against and this feature does not move that.
    expect(flagged.every((f) => !(f.e ?? []).includes(''))).toBe(true);
  });
});
