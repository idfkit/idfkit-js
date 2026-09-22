/**
 * Geometry extraction resolves where the engine resolves, and leaves the model alone.
 *
 * The counterpart of `idfkit/tests/test_scene.py`, assertion for assertion, and the library-side
 * half of the corpus check `checks/geometry-vertices`.
 *
 * THE TWO SOURCES OF EVIDENCE, AND WHY BOTH.
 *
 * The corpus holds the seven fixture models and the expectations EnergyPlus itself produced for
 * them. They are not committed here: they belong to the corpus, where the cross-language claim is
 * made, and copying them would give the same bytes two homes. So the corpus assertions run when a
 * corpus checkout is reachable and are skipped when it is not, following `exampleFilesDir` in
 * `packages/core/tests/helpers.ts`.
 *
 * The constructed assertions run always. They are what makes this a guard rather than a courtesy:
 * `npm test` on a bare checkout still fails an extractor that mutates the document, drops a
 * surface, or normalises a starting vertex.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { IdfDocument, getIdfVersion, parseIdf, writeIdf } from '@idfkit/core';
import type { ExtensibleGroup, IdfObject } from '@idfkit/core';
import { schemaFor } from '@idfkit/core/node';
import { localBundle } from '@idfkit/schemas/node';
import type { Schema } from '@idfkit/schemas';
import { describe, expect, it } from 'vitest';

import { Polygon3D, Vector3D, getScene } from '../src/index.js';
import type { Scene } from '../src/index.js';
import { READ, UNREAD } from '../src/scene.js';

/**
 * Half the last place the engine's report prints, per coordinate.
 *
 * See the derivation in `runners/geometry_check.py`: it is a claim about one number, so the
 * comparison is per coordinate and not a distance between points.
 */
const TOLERANCE_M = 0.005;

/**
 * The five fixtures whose resolution this file asserts.
 *
 * The other two are the corpus's business: `lower-left-start` is about the comparison rather than
 * the rule, and `simplified-only-unread` resolves nothing and is asserted on its own terms below.
 *
 * `clockwise-entry` is the only one of the seven that declares clockwise entry, which is one fewer
 * than SC-004 states the set holds. The counterfactual below measures the clause on the model that
 * is actually committed rather than on the two the criterion assumes.
 */
const FIXTURES = [
  'relative-zone-origin',
  'relative-zone-rotation',
  'north-axis-multizone',
  'world-nonzero-zone-origin',
  'clockwise-entry',
] as const;

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The corpus checkout, or `undefined` when there is not one at hand. */
function corpusDir(): string | undefined {
  for (const candidate of [
    process.env['IDFKIT_CONFORMANCE_DIR'],
    join(REPO, 'conformance'),
    resolve(REPO, '..', 'idfkit-conformance'),
  ]) {
    if (candidate === undefined) continue;
    const path = join(candidate, 'checks', 'geometry-vertices');
    if (existsSync(join(path, 'fixtures')) && existsSync(join(path, 'expected'))) return path;
  }
  return undefined;
}

const CORPUS = corpusDir();

function modelText(name: string): string {
  return gunzipSync(readFileSync(join(CORPUS as string, 'fixtures', `${name}.idf.gz`))).toString(
    'latin1'
  );
}

/** One expectation row: the base surface the engine names, and the vertices it reports. */
interface Reported {
  readonly baseSurface: string;
  readonly vertices: readonly (readonly [number, number, number])[];
}

/** The engine's rows for one fixture, keyed by upper-cased surface name. */
function expectationFor(name: string): Map<string, Reported> {
  const rows = new Map<string, Reported>();
  for (const line of readFileSync(join(CORPUS as string, 'expected', `${name}.csv`), 'utf8').split(
    '\n'
  )) {
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split(',');
    if (fields[0] === 'kind') continue;
    const count = Number.parseInt(fields[4] as string, 10);
    const flat = fields.slice(5, 5 + count * 3).map(Number);
    const vertices: [number, number, number][] = [];
    for (let at = 0; at < flat.length; at += 3) {
      vertices.push([flat[at] as number, flat[at + 1] as number, flat[at + 2] as number]);
    }
    rows.set((fields[1] as string).toUpperCase(), { baseSurface: fields[3] as string, vertices });
  }
  return rows;
}

/**
 * Smallest worst-coordinate error over the cyclic rotations, orientation preserved.
 *
 * The corpus runner's function, restated here rather than imported, because this file must work on
 * a checkout with no corpus beside it.
 */
function ringError(
  resolved: readonly Vector3D[],
  reported: readonly (readonly [number, number, number])[]
): number {
  if (resolved.length !== reported.length) return Number.POSITIVE_INFINITY;
  const count = resolved.length;
  let best = Number.POSITIVE_INFINITY;
  for (let shift = 0; shift < count; shift += 1) {
    let worst = 0;
    for (let at = 0; at < count; at += 1) {
      const one = (resolved[(at + shift) % count] as Vector3D).asTuple();
      const other = reported[at] as readonly [number, number, number];
      for (let axis = 0; axis < 3; axis += 1) {
        worst = Math.max(worst, Math.abs((one[axis] as number) - (other[axis] as number)));
      }
    }
    best = Math.min(best, worst);
  }
  return best;
}

/** The document as the preserving writer renders it, which is the byte-level comparison. */
function written(document: IdfDocument): string {
  return writeIdf(document, { preserveFormatting: true });
}

/** One fixture, parsed as the library's own reader would parse it. */
async function fixtureDocument(name: string): Promise<IdfDocument> {
  const text = modelText(name);
  return parseIdf(text, await schemaFor(getIdfVersion(text))).document;
}

// ---------------------------------------------------------------------------
// Constructed: these run on a bare checkout
// ---------------------------------------------------------------------------

const bundle = localBundle();
let schemaPromise: Promise<Schema> | undefined;
function schema(): Promise<Schema> {
  schemaPromise ??= bundle.load('26.1.0');
  return schemaPromise;
}

/** A single-zone model with one wall, built so each clause can be switched on alone. */
async function oneWall(rules: Record<string, string> = {}): Promise<IdfDocument> {
  const document = new IdfDocument(await schema());
  document.addRaw('Version', null, { version_identifier: '26.1' });
  // One rules object, edited rather than joined by a second, so a clause is switched by changing
  // the declaration exactly as an author would.
  document.addRaw('GlobalGeometryRules', null, {
    starting_vertex_position: 'UpperLeftCorner',
    vertex_entry_direction: 'Counterclockwise',
    coordinate_system: 'Relative',
    ...rules,
  });
  document.addRaw('Zone', 'Z1', { x_origin: 10, y_origin: 20, z_origin: 0 });
  document.addRaw('BuildingSurface:Detailed', 'W1', {
    surface_type: 'WALL',
    construction_name: '',
    zone_name: 'Z1',
    outside_boundary_condition: 'Outdoors',
    number_of_vertices: 4,
    vertices: [
      { vertex_x_coordinate: 0, vertex_y_coordinate: 0, vertex_z_coordinate: 3 },
      { vertex_x_coordinate: 0, vertex_y_coordinate: 0, vertex_z_coordinate: 0 },
      { vertex_x_coordinate: 4, vertex_y_coordinate: 0, vertex_z_coordinate: 0 },
      { vertex_x_coordinate: 4, vertex_y_coordinate: 0, vertex_z_coordinate: 3 },
    ],
  });
  return document;
}

/**
 * The same wall, its ring traversed the other way from the same corner.
 *
 * The head is held and the tail reversed, which is what an author winding the other way writes.
 * Reversing the whole list would move the starting vertex too, and the model would then differ in
 * two respects rather than one.
 */
function theOtherWay(document: IdfDocument): IdfDocument {
  const wall = document.all('BuildingSurface:Detailed').first as IdfObject;
  const [head, ...tail] = wall.extensible.map((group) => ({ ...group }) as ExtensibleGroup);
  wall.set('vertices', [head as ExtensibleGroup, ...tail.reverse()]);
  return document;
}

/**
 * The one-wall model with a second wall six metres away in y.
 *
 * One wall lies in a plane, so its extent is flat in y and a defect in that coordinate cannot show.
 * Two walls give the extent a non-zero size on all three axes. They share their x and z, so each of
 * the six faces of the extent is touched by a vertex.
 *
 * W2 is wound the opposite way round from W1, so that the two outward normals point away from each
 * other as the outward normals of the two long walls of a building do.
 */
async function twoWalls(rules: Record<string, string> = {}): Promise<IdfDocument> {
  const document = await oneWall(rules);
  document.addRaw('BuildingSurface:Detailed', 'W2', {
    surface_type: 'WALL',
    construction_name: '',
    zone_name: 'Z1',
    outside_boundary_condition: 'Outdoors',
    number_of_vertices: 4,
    vertices: [
      { vertex_x_coordinate: 4, vertex_y_coordinate: 6, vertex_z_coordinate: 3 },
      { vertex_x_coordinate: 4, vertex_y_coordinate: 6, vertex_z_coordinate: 0 },
      { vertex_x_coordinate: 0, vertex_y_coordinate: 6, vertex_z_coordinate: 0 },
      { vertex_x_coordinate: 0, vertex_y_coordinate: 6, vertex_z_coordinate: 3 },
    ],
  });
  return document;
}

/** One orphan window, a kilometre away or next door, as the test needs. */
function addOrphanWindow(document: IdfDocument, x: number, vertices = 4): void {
  const values: Record<string, string | number> = {
    surface_type: 'Window',
    construction_name: '',
    building_surface_name: 'NoSuchWall',
    number_of_vertices: vertices,
    vertex_1_x_coordinate: x,
    vertex_1_y_coordinate: 0,
    vertex_1_z_coordinate: 2,
    vertex_2_x_coordinate: x,
    vertex_2_y_coordinate: 0,
    vertex_2_z_coordinate: 1,
    vertex_3_x_coordinate: x + 1,
    vertex_3_y_coordinate: 0,
    vertex_3_z_coordinate: 1,
  };
  if (vertices === 4) {
    values['vertex_4_x_coordinate'] = x + 1;
    values['vertex_4_y_coordinate'] = 0;
    values['vertex_4_z_coordinate'] = 2;
  }
  document.addRaw('FenestrationSurface:Detailed', 'Orphan', values);
}

describe('the clauses are conditional', () => {
  it('applies the zone origin under Relative', async () => {
    const scene = getScene(await oneWall({ coordinate_system: 'Relative' }));
    expect(
      (scene.surfaces[0] as never as { polygon: Polygon3D }).polygon.vertices[0]?.asTuple()
    ).toEqual([10, 20, 3]);
  });

  it('does not apply the zone origin under World', async () => {
    // The negative case, and the one the first language's shipped private path gets wrong. Twelve
    // of the example models declare World and carry a non-zero zone origin anyway; applying it
    // displaces every surface in them.
    const scene = getScene(await oneWall({ coordinate_system: 'World' }));
    expect(scene.surfaces[0]?.polygon.vertices[0]?.asTuple()).toEqual([0, 0, 3]);
    expect(scene.applied.coordinateSystem).toBe('World');
  });

  it('reverses the ring for clockwise entry and keeps its start', async () => {
    // Orientation is normalised; the starting vertex is not. Reversing a ring in place leaves the
    // first vertex where the author put it, which is the distinction the corpus guards with
    // `lower-left-start`.
    const counter = getScene(await oneWall({ vertex_entry_direction: 'Counterclockwise' }))
      .surfaces[0]?.polygon as Polygon3D;
    const clock = getScene(await oneWall({ vertex_entry_direction: 'Clockwise' })).surfaces[0]
      ?.polygon as Polygon3D;
    expect(clock.vertices[0]?.asTuple()).toEqual(counter.vertices[0]?.asTuple());
    expect(clock.vertices.slice(1).map((v) => v.asTuple())).toEqual(
      [...counter.vertices.slice(1)].reverse().map((v) => v.asTuple())
    );
  });

  it("reports the schema's spelling of a classification", async () => {
    // `WALL` is authored, `Wall` is reported: the schema defines the value, not the file.
    expect(getScene(await oneWall()).surfaces[0]?.surfaceType).toBe('Wall');
  });

  it('holds site shading fixed in space while building shading turns', async () => {
    // Clause two's one exception, which no fixture in the corpus carries. The schema separates the
    // two detached forms on one sentence: site shading items "are fixed in space and would not move
    // with relative geometry", building shading items "are relative to the current building and
    // would move with relative geometry". They carry identical fields, so the object type is the
    // whole of the difference, and a rule that turned both would make the two objects one object.
    //
    // Measured rather than read: at a north axis of 158.434 EnergyPlus 26.1.0 reports the same
    // square where it was authored under the first type and turned under the second, and labels
    // them `Detached Shading:Fixed` and `Detached Shading:Building` in its own report.
    const document = await oneWall();
    document.addRaw('Building', 'B', { north_axis: 90 });
    for (const objectType of ['Shading:Site:Detailed', 'Shading:Building:Detailed']) {
      document.addRaw(objectType, `S-${objectType}`, {
        number_of_vertices: 3,
        vertices: [
          { vertex_x_coordinate: 2, vertex_y_coordinate: 0, vertex_z_coordinate: 3 },
          { vertex_x_coordinate: 2, vertex_y_coordinate: 0, vertex_z_coordinate: 0 },
          { vertex_x_coordinate: 0, vertex_y_coordinate: 0, vertex_z_coordinate: 0 },
        ],
      });
    }
    const placed = new Map(
      getScene(document).surfaces.map((s) => [s.objectType, s.polygon.vertices[0] as Vector3D])
    );
    expect(placed.get('Shading:Site:Detailed')?.asTuple()).toEqual([2, 0, 3]);
    // Ninety degrees clockwise seen from above sends +x to -y.
    const turned = placed.get('Shading:Building:Detailed') as Vector3D;
    const round9 = (value: number) => Math.round(value * 1e9) / 1e9;
    expect([round9(turned.x), round9(turned.y), turned.z]).toEqual([0, -2, 3]);
  });

  it('records a Building that states no axis as defaulted', async () => {
    // A stated zero is a declaration; a blank field is not, and is assumed exactly as an absent
    // object is. FR-016 asks for each governing field as declared or defaulted, and a consumer
    // warning on assumed values would otherwise stay silent on the one that moves a building most.
    const text = 'Version,26.1;\n\nBuilding,B,,City;\n\nZone,Z1;\n';
    const scene = getScene(parseIdf(text, await schema()).document);
    expect(scene.applied.northAxis).toBe(0);
    expect(scene.applied.defaulted).toContain('north_axis');
  });

  it('records an absent rules object as defaulted', async () => {
    // A model stating neither object is read under the engine's assumptions, and says so. Parsed
    // from text rather than built: the point is a document that genuinely lacks them.
    const text = 'Version,26.1;\n\nZone,Z1;\n';
    const scene = getScene(parseIdf(text, await schema()).document);
    expect(scene.applied.defaulted).toContain('coordinate_system');
    expect(scene.applied.defaulted).toContain('north_axis');
    expect(scene.applied.coordinateSystem).toBe('Relative');
  });
});

describe('a surface faces the way the model says it faces', () => {
  // User story 4. The normal's sign comes from the declaration, not from the file's order.
  //
  // The corpus settles the clause against the engine on `clockwise-entry`, the only committed model
  // that declares it. What the corpus cannot settle is the invariance: that needs two models
  // differing in exactly one declared field, and no example file ships with a twin. So the pair is
  // constructed here, and it runs on a bare checkout.

  it('gives the same building wound either way the same normal', async () => {
    const counter = await oneWall({ vertex_entry_direction: 'Counterclockwise' });
    const clock = theOtherWay(await oneWall({ vertex_entry_direction: 'Clockwise' }));

    const statedCounter = (
      counter.all('BuildingSurface:Detailed').first as IdfObject
    ).extensible.map((group) => ({ ...group }));
    const statedClock = (clock.all('BuildingSurface:Detailed').first as IdfObject).extensible.map(
      (group) => ({ ...group })
    );
    expect(statedCounter).not.toEqual(statedClock);

    const one = getScene(counter).surfaces[0];
    const other = getScene(clock).surfaces[0];
    expect(one?.normal.asTuple()).toEqual(other?.normal.asTuple());
    expect(one?.polygon.asTupleList()).toEqual(other?.polygon.asTupleList());
    expect(one?.normal.asTuple()).toEqual([0, -1, 0]);
  });

  it('takes the sign from the declaration alone', async () => {
    const one = getScene(await oneWall({ vertex_entry_direction: 'Counterclockwise' })).surfaces[0];
    const other = getScene(await oneWall({ vertex_entry_direction: 'Clockwise' })).surfaces[0];
    expect(one?.normal.asTuple()).toEqual([0, -1, 0]);
    expect(other?.normal.asTuple()).toEqual([0, 1, 0]);
  });

  it('returns a unit normal in every reading', async () => {
    for (const direction of ['Counterclockwise', 'Clockwise']) {
      const normal = getScene(await oneWall({ vertex_entry_direction: direction })).surfaces[0]
        ?.normal as Vector3D;
      expect(Math.abs(normal.length() - 1)).toBeLessThan(1e-12);
    }
  });
});

describe('the scene carries its extent', () => {
  // User story 5. The extent encloses every resolved vertex and no more. These run on a bare
  // checkout, on models of known dimensions, so the extent is asserted as an exact pair of corners
  // rather than as a property of itself.

  it('is the corners of a known building', async () => {
    const bounds = getScene(await twoWalls({ coordinate_system: 'World' })).bounds;
    expect(bounds?.min.asTuple()).toEqual([0, 0, 0]);
    expect(bounds?.max.asTuple()).toEqual([4, 6, 3]);
  });

  it('is of the resolved geometry and not of the stated vertices', async () => {
    // The same two walls under Relative, where the zone origin moves them by (10, 20, 0). An extent
    // taken from the vertices as written would be the World answer above for both models.
    const bounds = getScene(await twoWalls({ coordinate_system: 'Relative' })).bounds;
    expect(bounds?.min.asTuple()).toEqual([10, 20, 0]);
    expect(bounds?.max.asTuple()).toEqual([14, 26, 3]);
  });

  it('touches a vertex on every face', async () => {
    // "and no more" is the half a padded box would satisfy on enclosure alone.
    const scene = getScene(await twoWalls({ coordinate_system: 'World' }));
    const vertices = scene.surfaces.flatMap((surface) => [...surface.polygon.vertices]);
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(scene.bounds?.min[axis]).toBe(Math.min(...vertices.map((v) => v[axis])));
      expect(scene.bounds?.max[axis]).toBe(Math.max(...vertices.map((v) => v[axis])));
    }
  });

  it('is not enlarged by an object that did not resolve', async () => {
    // The orphan window here is a kilometre away. An extent taken over every geometry object the
    // model states, rather than over the ones that were placed, would frame empty space.
    const document = await twoWalls({ coordinate_system: 'World' });
    addOrphanWindow(document, 1000);
    const scene = getScene(document);
    expect(scene.unresolved.map((entry) => entry.name)).toEqual(['Orphan']);
    expect(scene.bounds?.min.asTuple()).toEqual([0, 0, 0]);
    expect(scene.bounds?.max.asTuple()).toEqual([4, 6, 3]);
  });

  it('is absent rather than a point when all the geometry failed', async () => {
    // The third way a scene can hold no surfaces, and the one where an extent folded to a point at
    // the origin would be most plausible, because vertices were read before the surface was refused.
    const document = await twoWalls({ coordinate_system: 'World' });
    for (const wall of document.all('BuildingSurface:Detailed'))
      wall.set('zone_name', 'NoSuchZone');
    const scene = getScene(document);
    expect(scene.surfaces).toEqual([]);
    expect(scene.unresolved).toHaveLength(2);
    expect(scene.bounds).toBeUndefined();
  });
});

describe('nothing is dropped silently', () => {
  it('answers differently for an empty model and an unread model', async () => {
    const empty = getScene(new IdfDocument(await schema()));
    expect(empty.surfaces).toEqual([]);
    expect(empty.unattempted).toEqual([]);
    expect(empty.bounds).toBeUndefined();

    const simplified = new IdfDocument(await schema());
    simplified.addRaw('Zone', 'Z1', {});
    simplified.addRaw('Wall:Exterior', 'W1', {
      construction_name: '',
      zone_name: 'Z1',
      azimuth_angle: 180,
      tilt_angle: 90,
      starting_x_coordinate: 0,
      starting_y_coordinate: 0,
      starting_z_coordinate: 0,
      length: 4,
      height: 3,
    });
    const scene = getScene(simplified);
    expect(scene.surfaces).toEqual([]);
    expect(scene.unattempted).toHaveLength(1);
    expect(scene.unattempted[0]?.objectType).toBe('Wall:Exterior');
    expect(scene.unattempted[0]?.count).toBe(1);
    expect(scene.bounds).toBeUndefined();
  });

  it('reports a fenestration whose parent is absent rather than dropping it', async () => {
    // It never appears in `surfaces`, because a window on no wall is not placed.
    const document = await oneWall();
    addOrphanWindow(document, 1);
    const scene = getScene(document);
    expect(scene.surfaces.map((surface) => surface.name)).toEqual(['W1']);
    expect(scene.unresolved).toHaveLength(1);
    expect(scene.unresolved[0]?.name).toBe('Orphan');
    expect(scene.unresolved[0]?.reason).toBe('parent-surface-not-found');
    // The missing parent by name. The reason says how to group the failure; the name says which
    // wall to go and find, without a second search through the document.
    expect(scene.unresolved[0]?.missingReference).toBe('NoSuchWall');
  });

  it('names the zone a surface wanted and the model does not hold', async () => {
    const document = await oneWall();
    (document.all('BuildingSurface:Detailed').first as IdfObject).set('zone_name', 'NoSuchZone');
    const scene = getScene(document);
    expect(scene.surfaces).toEqual([]);
    expect(scene.unresolved).toHaveLength(1);
    expect(scene.unresolved[0]?.reason).toBe('zone-not-found');
    expect(scene.unresolved[0]?.missingReference).toBe('NoSuchZone');
  });

  it('counts the vertices an object states when it names the reason', async () => {
    // The two reasons about an object's own vertex list, told apart by the count. A window stating
    // two vertices is short of vertices, not without them. Reading the extensible wrapper to decide
    // instead calls it `no-vertices`, because fenestration states its vertices in flat fields and
    // carries no wrapper at all, which is how the first language read it until this was written.
    const document = await oneWall();
    document.addRaw('FenestrationSurface:Detailed', 'TwoVertices', {
      surface_type: 'Window',
      construction_name: '',
      building_surface_name: 'W1',
      number_of_vertices: 2,
      vertex_1_x_coordinate: 1,
      vertex_1_y_coordinate: 0,
      vertex_1_z_coordinate: 2,
      vertex_2_x_coordinate: 1,
      vertex_2_y_coordinate: 0,
      vertex_2_z_coordinate: 1,
    });
    const scene = getScene(document);
    expect(scene.unresolved.map((entry) => entry.reason)).toEqual(['too-few-vertices']);
  });

  it('tells an object stating nothing from one stating too little', async () => {
    // `no-vertices` is the model saying nothing, and is the reason with no test until now.
    const document = await oneWall();
    (document.all('BuildingSurface:Detailed').first as IdfObject).set('vertices', []);
    const scene = getScene(document);
    expect(scene.unresolved.map((entry) => entry.reason)).toEqual(['no-vertices']);
    expect(scene.unresolved[0]?.missingReference).toBeUndefined();
  });

  it('names nothing when there was no reference to miss', async () => {
    const document = await oneWall();
    const wall = document.all('BuildingSurface:Detailed').first as IdfObject;
    wall.set('vertices', [
      { vertex_x_coordinate: 0, vertex_y_coordinate: 0, vertex_z_coordinate: 0 },
      { vertex_x_coordinate: 4, vertex_y_coordinate: 0, vertex_z_coordinate: 0 },
    ]);
    const scene = getScene(document);
    expect(scene.unresolved).toHaveLength(1);
    expect(scene.unresolved[0]?.reason).toBe('too-few-vertices');
    expect(scene.unresolved[0]?.missingReference).toBeUndefined();
  });
});

describe('every geometry object is accounted for', () => {
  // Nothing in the model may vanish from the scene without a word.

  /**
   * The members of the schema's surfaces group that are not geometry objects, listed so that the
   * sweep below can be exhaustive over the rest.
   *
   * A type is here because it states no surface: a zone or space is a container, a property object
   * modifies a surface stated elsewhere, InternalMass states an area and a construction and no
   * vertices, GlobalGeometryRules states the rules themselves, and GeometryTransform scales what is
   * stated elsewhere.
   */
  const NOT_GEOMETRY = new Set([
    'GeometryTransform',
    'GlobalGeometryRules',
    'InternalMass',
    'ShadingProperty:Reflectance',
    'Space',
    'SpaceList',
    'WindowProperty:AirflowControl',
    'WindowProperty:FrameAndDivider',
    'WindowProperty:StormWindow',
    'WindowShadingControl',
    'Zone',
    'ZoneGroup',
    'ZoneList',
  ]);

  it('has every surface type the schema knows in one list or the other', async () => {
    // The guard that catches a geometry type belonging to neither list. Counting the model against
    // the two lists cannot catch a type absent from both: such a type is invisible to the count as
    // it is to the scene, and the model reports as empty. So the question is asked of the schema,
    // which knows every surface type EnergyPlus has, rather than of the lists being checked.
    //
    // This is not hypothetical. It is how `Wall:Detailed`, `Floor:Detailed` and
    // `RoofCeiling:Detailed` were found: three detailed forms carrying explicit vertices, in
    // neither list, and in no fixture, so nothing else would have said a word.
    const loaded = await schema();
    const group = loaded.get('BuildingSurface:Detailed')?.g;
    expect(group).toBeTruthy();
    const unaccounted = loaded.typeNames
      .filter((name) => loaded.get(name)?.g === group && !NOT_GEOMETRY.has(name))
      .filter((name) => !READ.includes(name) && !UNREAD.includes(name))
      .sort();
    expect(unaccounted).toEqual([]);
  });

  it('adds up', async () => {
    // Resolved plus unresolved plus unattempted equals what the model holds.
    const document = await oneWall();
    document.addRaw('Wall:Exterior', 'Simple', { construction_name: '', zone_name: 'Z1' });
    addOrphanWindow(document, 1, 3);
    const scene = getScene(document);

    const held = [...READ, ...UNREAD].reduce(
      (total, objectType) => total + document.all(objectType).size,
      0
    );
    const reported =
      scene.surfaces.length +
      scene.unresolved.length +
      scene.unattempted.reduce((total, entry) => total + entry.count, 0);
    expect(reported).toBe(held);
    expect(held).toBe(3);
  });
});

describe('both lists come back in document order', () => {
  // The corpus compares both as sets, so only a direct assertion can catch a drift.

  it('reports unresolved objects in the file order and not the type order', async () => {
    // The fenestration is stated first and must be reported first. Grouping by type would put the
    // `BuildingSurface:Detailed` first, since it leads `READ`. The file says otherwise, and the
    // file is what a reader is holding.
    const text =
      'Version, 26.1;\n' +
      'GlobalGeometryRules, UpperLeftCorner, Counterclockwise, Relative;\n' +
      'FenestrationSurface:Detailed, FirstStated, Window, , NoSuchWall, , , , , 3,\n' +
      '  1,0,2, 1,0,1, 2,0,1;\n' +
      'BuildingSurface:Detailed, SecondStated, Wall, , NoSuchZone, , Outdoors, , , , , 3,\n' +
      '  0,0,3, 0,0,0, 4,0,0;\n';
    const scene = getScene(parseIdf(text, await schema()).document);
    expect(scene.unresolved.map((entry) => entry.name)).toEqual(['FirstStated', 'SecondStated']);
  });

  it('reports unattempted types by first occurrence and not by the list order', async () => {
    // `Window` is stated before `Wall:Exterior` and must be named first. `UNREAD` lists the walls
    // before the windows, so a producer iterating that constant would report them the other way
    // round and no corpus comparison would notice.
    const text =
      'Version, 26.1;\n' +
      'Window, StatedFirst, , SomeWall, , 1, 0, 1, 1.5, 1.2;\n' +
      'Wall:Exterior, StatedSecond, , Z1, , 180, 90, 0, 0, 0, 4, 3;\n';
    const scene = getScene(parseIdf(text, await schema()).document);
    expect(scene.unattempted.map((entry) => entry.objectType)).toEqual(['Window', 'Wall:Exterior']);
    expect(scene.unattempted.map((entry) => entry.count)).toEqual([1, 1]);
  });
});

describe('the document is unchanged', () => {
  it('does not touch a constructed model', async () => {
    const document = await oneWall();
    const before = written(document);
    getScene(document);
    expect(written(document)).toBe(before);
  });

  it('does not touch a document that retained its source', async () => {
    // The case the constructed assertion above cannot reach. A document built through `addRaw`
    // retains no source text, so `preserveFormatting` degrades to an ordinary write and a mutation
    // that only shows on a retained-source document passes unseen. The corpus fixtures exercise the
    // retained path and are skipped wherever a corpus checkout is not beside this one, which is
    // every CI run, so the guarantee this module rests on had nothing holding it there.
    //
    // Both halves are compared: the bytes a preserving write emits, and the document's own value.
    const text =
      'Version, 26.1;\n' +
      'GlobalGeometryRules, UpperLeftCorner, Counterclockwise, Relative;\n' +
      'Zone, Z1, , 10, 20, 0;\n' +
      'BuildingSurface:Detailed, W1, Wall, , Z1, , Outdoors, , , , , 3,\n' +
      '  0,0,3, 0,0,0, 4,0,0;\n' +
      'FenestrationSurface:Detailed, F1, Window, , W1, , , , , 3,\n' +
      '  1,0,2, 1,0,1, 2,0,1;\n' +
      'Wall:Exterior, Simple, , Z1, , 180, 90, 0, 0, 0, 4, 3;\n';
    const document = parseIdf(text, await schema(), { preserveFormatting: true }).document;

    const bytes = written(document);
    const value = JSON.stringify(document.toJSON());

    const scene = getScene(document);
    expect(scene.surfaces).toHaveLength(2);
    expect(scene.unattempted.map((entry) => entry.objectType)).toEqual(['Wall:Exterior']);

    expect(written(document)).toBe(bytes);
    expect(JSON.stringify(document.toJSON())).toBe(value);
  });
});

// ---------------------------------------------------------------------------
// Corpus: the engine's own answer, when a checkout is reachable
// ---------------------------------------------------------------------------

describe.skipIf(CORPUS === undefined)('against the engine', () => {
  it.each(FIXTURES)('leaves %s unchanged', async (fixture) => {
    // The guarantee the whole read-only view rests on. Not "unchanged in the fields extraction
    // reads": unchanged. A preserving write before and after yields identical bytes.
    const document = await fixtureDocument(fixture);
    const before = written(document);
    getScene(document);
    expect(written(document)).toBe(before);
  });

  it.each(FIXTURES)('agrees with the engine on every surface of %s', async (fixture) => {
    const scene = getScene(await fixtureDocument(fixture));
    const expected = expectationFor(fixture);

    expect(scene.surfaces.length).toBeGreaterThan(0);
    for (const surface of scene.surfaces) {
      const row = expected.get(surface.name.toUpperCase());
      expect(row, `${fixture}: ${surface.name} is not in the engine's report`).toBeDefined();
      const error = ringError(surface.polygon.vertices, (row as Reported).vertices);
      expect(error, `${fixture}: ${surface.name} is ${error.toFixed(4)} m out`).toBeLessThanOrEqual(
        TOLERANCE_M
      );
    }
  });

  it.each(FIXTURES)('points every normal of %s where the engine’s ring points', async (fixture) => {
    // Against the oracle rather than against this library's own arithmetic. The engine reports
    // vertices and not normals, so the direction compared against is the one its own reported ring
    // computes. That is not circular: the ring comparison is insensitive to where a ring starts, and
    // a surface could agree with the engine as a set of corners while being traversed the other way.
    const scene = getScene(await fixtureDocument(fixture));
    const expected = expectationFor(fixture);

    for (const surface of scene.surfaces) {
      const row = expected.get(surface.name.toUpperCase()) as Reported;
      const reported = Polygon3D.fromTuples(row.vertices);
      const agreement = surface.normal.dot(reported.normal);
      expect(
        agreement,
        `${fixture}: ${surface.name} faces ${agreement.toFixed(4)}`
      ).toBeGreaterThan(0.999);
    }
  });

  it('measures what the clockwise model needs the clause it declares to be worth', async () => {
    // That `clockwise-entry` passes says the clause does no harm. What says the clause is
    // load-bearing is what happens without it, and the way to ask without keeping a second
    // implementation around is to undo it on the output: reverse each ring back, holding its head,
    // which is exactly what a library that never wrote the clause would have returned.
    //
    // The criterion says two such models are in the set and one is, which is recorded beside
    // `FIXTURES` above rather than worked around here.
    const scene = getScene(await fixtureDocument('clockwise-entry'));
    const expected = expectationFor('clockwise-entry');

    expect(scene.applied.isClockwise, 'the fixture no longer declares clockwise entry').toBe(true);
    expect(scene.surfaces).toHaveLength(8);

    let worst = 0;
    for (const surface of scene.surfaces) {
      const reported = (expected.get(surface.name.toUpperCase()) as Reported).vertices;
      const [head, ...tail] = surface.polygon.vertices;
      const withoutTheClause = [head as Vector3D, ...[...tail].reverse()];
      const error = ringError(withoutTheClause, reported);
      expect(error, `${surface.name} agrees with the engine either way round`).toBeGreaterThan(
        TOLERANCE_M
      );
      worst = Math.max(worst, error);
    }
    expect(worst, `the clause is worth ${worst.toFixed(4)} m`).toBeGreaterThanOrEqual(4);
  });

  it.each(FIXTURES)('names the parent the engine names on every window of %s', async (fixture) => {
    const scene = getScene(await fixtureDocument(fixture));
    const expected = expectationFor(fixture);

    const windows = scene.surfaces.filter((surface) => surface.parentSurface !== undefined);
    for (const surface of windows) {
      const base = (expected.get(surface.name.toUpperCase()) as Reported).baseSurface;
      expect((surface.parentSurface as string).toUpperCase()).toBe(base.toUpperCase());
    }
    if (fixture === 'world-nonzero-zone-origin') expect(windows).toHaveLength(24);
  });

  it.each(FIXTURES)('carries a parent exactly on fenestration in %s', async (fixture) => {
    // The engine names a base surface for zone-attached shading too: 21 of the 99 rows in
    // `world-nonzero-zone-origin` carry one. The scene deliberately does not, because
    // `parentSurface` means the surface a fenestration sits on and nothing else. Without this
    // assertion a reader comparing the two reports would have no way to tell the choice from an
    // oversight, and a consumer grouping windows by that field would silently collect shading.
    const scene = getScene(await fixtureDocument(fixture));

    for (const surface of scene.surfaces) {
      expect(
        surface.parentSurface !== undefined,
        `${fixture}: ${surface.objectType} ${surface.name}`
      ).toBe(surface.objectType === 'FenestrationSurface:Detailed');
    }

    if (fixture === 'world-nonzero-zone-origin') {
      const shading = scene.surfaces.filter((surface) => surface.isShading);
      expect(shading).toHaveLength(21);
      expect(shading.every((surface) => surface.parentSurface === undefined)).toBe(true);
    }
  });

  it.each([...FIXTURES, 'lower-left-start', 'simplified-only-unread'])(
    'accounts for everything in %s',
    async (fixture) => {
      // Every geometry object is resolved, refused, or counted. The constructed version runs on a
      // bare checkout; this one runs over real models, where the counts are large enough that a
      // surface dropped in one branch would not stand out in a total anyone eyeballed.
      const document = await fixtureDocument(fixture);
      const scene = getScene(document);

      const held = [...READ, ...UNREAD].reduce(
        (total, objectType) => total + document.all(objectType).size,
        0
      );
      const unattempted = scene.unattempted.reduce((total, entry) => total + entry.count, 0);
      expect(
        scene.surfaces.length + scene.unresolved.length + unattempted,
        `${fixture}: model holds ${held} geometry objects`
      ).toBe(held);
    }
  );

  it.each([
    ['world-nonzero-zone-origin', 21],
    ['relative-zone-origin', 3],
  ] as const)('resolves the shading in %s and marks it', async (fixture, count) => {
    // Over both fixtures that carry shading. All 24 are `Shading:Zone:Detailed`, the zone-attached
    // form, which resolves against its zone's frame rather than against the building's.
    //
    // Marked, not merely present: a consumer draws shading differently from a wall, and a shading
    // surface that arrived looking like a heat transfer surface would be drawn as part of the
    // building. It carries no zone, and its `surfaceType` is its own object type, because the schema
    // gives a shading surface no surface-type field to read one from.
    const scene = getScene(await fixtureDocument(fixture));
    const expected = expectationFor(fixture);

    const shading = scene.surfaces.filter((surface) => surface.isShading);
    expect(shading).toHaveLength(count);
    for (const surface of shading) {
      expect([
        'Shading:Site:Detailed',
        'Shading:Building:Detailed',
        'Shading:Zone:Detailed',
      ]).toContain(surface.objectType);
      expect(surface.surfaceType).toBe(surface.objectType);
      expect(surface.zone).toBe('');
      expect(expected.get(surface.name.toUpperCase())?.vertices.length).toBeGreaterThan(0);
    }

    expect(
      scene.surfaces
        .filter((surface) => surface.objectType === 'BuildingSurface:Detailed')
        .every((surface) => !surface.isShading)
    ).toBe(true);
  });

  it('resolves nothing for the unread model and says what it saw', async () => {
    const scene = getScene(await fixtureDocument('simplified-only-unread'));
    expect(scene.surfaces).toEqual([]);
    expect(scene.bounds).toBeUndefined();
    expect(scene.unattempted.reduce((total, entry) => total + entry.count, 0)).toBeGreaterThan(0);
    expect(scene.unattempted.map((entry) => entry.objectType)).toContain('Wall:Exterior');
  });

  it.each([...FIXTURES, 'lower-left-start'])(
    'takes the extent of %s from the vertices the engine reports',
    async (fixture) => {
      // Against the oracle rather than against this library's own vertices. The constructed
      // assertions above take the extent over what this library resolved, so an extent and a
      // resolution that are wrong in the same way agree with each other.
      //
      // The oracle is restricted to the surfaces the scene resolved, so a surface dropped from the
      // scene altogether is dropped from both sides of this comparison and passes. That case is the
      // accounting test above; what this catches is an extent computed over anything other than the
      // geometry that was resolved.
      const scene = getScene(await fixtureDocument(fixture));
      const expected = expectationFor(fixture);
      expect(scene.bounds).toBeDefined();

      const absent = scene.surfaces
        .filter((surface) => !expected.has(surface.name.toUpperCase()))
        .map((surface) => surface.name);
      expect(absent, `${fixture}: not in the engine's report`).toEqual([]);

      const reported = scene.surfaces.flatMap(
        (surface) => (expected.get(surface.name.toUpperCase()) as Reported).vertices
      );
      (['x', 'y', 'z'] as const).forEach((axis, at) => {
        const low = Math.min(...reported.map((vertex) => vertex[at] as number));
        const high = Math.max(...reported.map((vertex) => vertex[at] as number));
        expect(Math.abs((scene.bounds?.min[axis] as number) - low)).toBeLessThanOrEqual(
          TOLERANCE_M
        );
        expect(Math.abs((scene.bounds?.max[axis] as number) - high)).toBeLessThanOrEqual(
          TOLERANCE_M
        );
      });
    }
  );

  it('is stable across runs', async () => {
    // Two runs of the same input agree, so a diff of two scenes is readable.
    const first: Scene = getScene(await fixtureDocument('relative-zone-origin'));
    const second: Scene = getScene(await fixtureDocument('relative-zone-origin'));
    expect(first.surfaces.map((surface) => surface.name)).toEqual(
      second.surfaces.map((surface) => surface.name)
    );
    expect(first.bounds?.min.asTuple()).toEqual(second.bounds?.min.asTuple());
    expect(first.bounds?.max.asTuple()).toEqual(second.bounds?.max.asTuple());
  });
});
