import { afterEach, describe, expect, it, vi } from 'vitest';

import { httpSource } from '@idfkit/schemas';
import { localBundle } from '@idfkit/schemas/node';

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
