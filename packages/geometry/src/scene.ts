/**
 * Resolve a model's geometry into one frame, without changing the model.
 *
 * `getScene(document)` reads a document and returns a {@link Scene}: every surface it could place,
 * in world coordinates with the building rotation applied, plus what it could not place and what it
 * did not attempt. It modifies nothing.
 *
 * The counterpart of `idfkit/src/idfkit/scene.py`, and a transcription rather than a second design:
 * the rule below was established against the engine's own vertex report before either language
 * implemented it, and `checks/geometry-vertices` in the corpus holds both languages to it.
 *
 * THE RULE, WHICH WAS MEASURED RATHER THAN REASONED
 *
 * Three clauses, in this order, against the engine's own vertex report over 17 models and 532
 * surfaces:
 *
 * 1. **Only when the model declares the relative system**, rotate each surface by its zone's
 *    `direction_of_relative_north` and then translate it by the zone's origin. The condition is not
 *    a nicety: twelve of the example models declare `World` and carry a non-zero zone origin
 *    anyway, and applying it displaces every surface in them.
 * 2. **Rotate the whole resolved building** by `Building.north_axis`, about the world origin, in
 *    the engine's sense. That sense is clockwise seen from above, so it is the negation of a
 *    counter-clockwise rotation. Applying it per surface inside its own zone frame instead leaves
 *    the zone layout unrotated: every surface correctly oriented and every zone in the wrong place,
 *    a drawing that passes an eyeball test at up to 201.98 m of error.
 * 3. **Reverse the vertex order** when the model declares clockwise entry, so that the right-hand
 *    rule gives the outward normal in every model.
 *
 * WHAT IS NOT DONE, AND IS NOT AN OVERSIGHT
 *
 * The **starting vertex is not renormalised**. The engine's report begins every surface at its
 * upper-left corner, and matching that would mean discarding the author's ordering to reproduce a
 * reporting convention. The corpus check carries a fixture whose whole purpose is to fail if
 * someone adds it.
 *
 * The **simplified surface family** (`Wall:Exterior`, `Window`, `Roof` and their siblings) is not
 * read. Those types are keyed on origin, width, height and tilt rather than on vertices and need
 * their own rule. They are reported in {@link Scene.unattempted} so that a model made of them looks
 * different from a model with no geometry at all.
 *
 * The **zone multiplier is not expanded**. It is a simulation instruction, and the engine's own
 * report does not repeat those surfaces either.
 */

import type { AnyTypeMap, IdfDocument, IdfObject, StoredValue } from '@idfkit/core';

import { Polygon3D } from './polygon.js';
import { Vector3D } from './vector.js';

// ---------------------------------------------------------------------------
// What this slice reads, and what it declines to
// ---------------------------------------------------------------------------

/** The detailed heat transfer surface. Every type read here states explicit vertices. */
const HEAT_TRANSFER = 'BuildingSurface:Detailed';
/** The detailed fenestration surface, stated in its parent surface's frame. */
const FENESTRATION = 'FenestrationSurface:Detailed';
/**
 * Detached shading fixed to the site, and the one place clause two is conditional: the engine turns
 * every surface by the building's north axis except this one.
 *
 * MEASURED, not read. EnergyPlus's schema says of this type that these items "are fixed in space and
 * would not move with relative geometry", against the building form's "are relative to the current
 * building and would move with relative geometry", and the two carry identical fields. That is a
 * memo rather than an oracle, so it was put to the engine: one square from (50, 0) to (60, 0)
 * entered twice, once under each type, in a model declaring a north axis of 158.434. EnergyPlus
 * 26.1.0 reports the site form where it was authored and the building form at (-46.50, -18.38) to
 * (-55.80, -22.05), turned, and labels the two `Detached Shading:Fixed` and
 * `Detached Shading:Building` in its own report.
 *
 * NO FIXTURE CAN CARRY THIS YET. Each fixture in `checks/geometry-vertices` is a byte-for-byte copy
 * of a shipped example model, and of the twenty such models holding detached shading not one
 * declares a north axis, which is why the corpus reported this rule green while both libraries had
 * it wrong. The check's coverage note records the gap.
 */
const SITE_SHADING = 'Shading:Site:Detailed';
/** The three detailed shading forms. */
const SHADING = [SITE_SHADING, 'Shading:Building:Detailed', 'Shading:Zone:Detailed'] as const;
/** @internal Exported for the tests that hold the read and unread lists to the schema. */
export const READ: readonly string[] = [HEAT_TRANSFER, FENESTRATION, ...SHADING];

/**
 * The types a `building_surface_name` or a `base_surface_name` may name. The schema declares the
 * `SurfaceNames` reference list on the heat transfer surfaces and on nothing else, so a shading
 * surface is never anyone's parent. Keeping it out of the lookup is what stops a name shared across
 * the two families from answering a parent lookup with a shading object.
 */
const PARENTS: readonly string[] = [HEAT_TRANSFER];

/**
 * Geometry types this slice does not read, reported rather than skipped.
 *
 * Two families, deferred for different reasons and reported the same way, because FR-018 is
 * unconditional: every geometry type the model states and this slice does not read is named with
 * its count.
 *
 * The simplified family states a surface as an origin, a width, a height and a tilt, which is a
 * second rule set and a second oracle.
 *
 * The three per-class detailed forms state explicit vertices and would resolve by the rule already
 * written here. They are listed rather than read because no model in the check set holds one, so
 * reading them would be an unproven claim. They are the first candidates for promotion once a
 * fixture carries them.
 *
 * @internal Exported for the tests that hold this list to the schema.
 */
export const UNREAD: readonly string[] = [
  'Wall:Detailed',
  'Floor:Detailed',
  'RoofCeiling:Detailed',
  'Wall:Exterior',
  'Wall:Adiabatic',
  'Wall:Interzone',
  'Wall:Underground',
  'Roof',
  'Ceiling:Adiabatic',
  'Ceiling:Interzone',
  'Floor:Adiabatic',
  'Floor:Interzone',
  'Floor:GroundContact',
  'Window',
  'Door',
  'GlazedDoor',
  'Window:Interzone',
  'Door:Interzone',
  'GlazedDoor:Interzone',
  'Shading:Site',
  'Shading:Building',
  'Shading:Overhang',
  'Shading:Overhang:Projection',
  'Shading:Fin',
  'Shading:Fin:Projection',
];

/**
 * What EnergyPlus assumes when `GlobalGeometryRules` does not say.
 *
 * The object is required in practice, so these are what a partial model is read as rather than a
 * documented default, and every one of them is recorded in {@link AppliedRules.defaulted} when it
 * is used.
 *
 * One row per rule, carrying the member, the field the model spells it under, and the fallback.
 * Two parallel tables keyed by the member would let a typo in either one read as a missing key and
 * default the rule silently, which is the failure a reader of this file could not see.
 */
const DEFAULT_RULES = [
  {
    member: 'startingVertexPosition',
    field: 'starting_vertex_position',
    fallback: 'UpperLeftCorner',
  },
  { member: 'vertexEntryDirection', field: 'vertex_entry_direction', fallback: 'Counterclockwise' },
  { member: 'coordinateSystem', field: 'coordinate_system', fallback: 'Relative' },
] as const;

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

/** What resolution read from the model, and what it had to assume. */
export interface AppliedRules {
  /** As declared, or the engine's default. */
  readonly coordinateSystem: string;
  /** As declared, or the engine's default. */
  readonly vertexEntryDirection: string;
  /** Recorded and deliberately not acted on: the author's starting vertex is preserved. */
  readonly startingVertexPosition: string;
  /**
   * Degrees, as applied to the resolved building.
   *
   * Recorded although it has already been applied to the vertices. That is what makes the choice
   * reversible: a consumer wanting to draw the building unrotated under a compass can undo it
   * exactly rather than reimplementing the clause most easily got wrong.
   */
  readonly northAxis: number;
  /** Which of the above were absent from the model and defaulted. */
  readonly defaulted: readonly string[];
  /**
   * Whether zone origins and zone rotations apply, which is clause one's condition.
   *
   * Derived from `coordinateSystem` rather than declared separately, and carried because the first
   * language carries it: a reader following the one documentation page should not find a fact
   * available in one language and absent in the other.
   */
  readonly isRelative: boolean;
  /** Whether the author entered vertices clockwise, which clause three reverses. */
  readonly isClockwise: boolean;
}

/** The box enclosing every resolved vertex, and no more. */
export interface SceneBounds {
  readonly min: Vector3D;
  readonly max: Vector3D;
}

/**
 * One surface, placed.
 *
 * `objectType` together with `name` is the address. A name alone is not unique across types, and a
 * consumer that must search the document by name to find what its user selected has been handed a
 * picture rather than a view of the model.
 */
export interface ResolvedSurface {
  readonly objectType: string;
  readonly name: string;
  /** The vertices in the resolved frame, in the author's ring order. */
  readonly polygon: Polygon3D;
  /** The outward normal, signed by the declared entry direction. */
  readonly normal: Vector3D;
  /** The area of the resolved polygon. */
  readonly area: number;
  /** The parent zone, empty for site and building shading. */
  readonly zone: string;
  /** In the schema's spelling, or the canonical object type on a shading surface. */
  readonly surfaceType: string;
  /** The outside boundary condition in the schema's spelling, empty where the type has none. */
  readonly boundary: string;
  /** The construction name, empty where the type has none. */
  readonly construction: string;
  /** The surface a fenestration sits on, and `undefined` for anything else. */
  readonly parentSurface: string | undefined;
  /** Shading surfaces are drawable and are not heat transfer surfaces. */
  readonly isShading: boolean;
}

/**
 * A geometry object that could not be placed, and why.
 *
 * The reason is an enumeration rather than a message, so that a consumer can group on it and a
 * reworded string does not change behaviour.
 *
 * `missingReference` names what the object pointed at and the model does not hold, for the two
 * reasons that are a dangling reference. The reason says how to group the failure; it does not say
 * which wall to go and find, and a reader fixing the model needs the name rather than a second
 * search through the document. Absent when nothing was referenced, as for an object whose vertex
 * list is too short.
 */
export interface UnresolvedObject {
  readonly objectType: string;
  readonly name: string;
  readonly reason:
    'too-few-vertices' | 'zone-not-found' | 'parent-surface-not-found' | 'no-vertices';
  readonly missingReference: string | undefined;
}

/** A geometry type present in the model that this slice does not read. */
export interface UnattemptedType {
  readonly objectType: string;
  readonly count: number;
}

/**
 * A model's geometry, resolved into one frame.
 *
 * All three lists are in document order. The corpus compares `unresolved` and `unattempted` as
 * sets, because neither carries a semantically meaningful order; that is a statement about what
 * counts as equal and not permission for the producer to vary. A list that reorders between runs is
 * a flickering interface and an unreadable diff, and ordering costs nothing here because resolution
 * already walks the document in order.
 */
export interface Scene {
  readonly surfaces: readonly ResolvedSurface[];
  /** Absent when nothing resolved, never a degenerate box at the origin. */
  readonly bounds: SceneBounds | undefined;
  readonly applied: AppliedRules;
  readonly unresolved: readonly UnresolvedObject[];
  readonly unattempted: readonly UnattemptedType[];
}

// ---------------------------------------------------------------------------
// Reading what the model declares
// ---------------------------------------------------------------------------

/** One numeric field, treating absent, blank and unreadable alike as zero. */
function numberField(obj: IdfObject | undefined, field: string): number {
  if (obj === undefined) return 0;
  const held = obj.get(field);
  if (held === undefined || held === '' || Array.isArray(held)) return 0;
  const value = Number(held);
  return Number.isFinite(value) ? value : 0;
}

/** One string field, absent and blank alike as the empty string. */
function textField(obj: IdfObject | undefined, field: string): string {
  if (obj === undefined) return '';
  const held = obj.get(field);
  if (held === undefined || Array.isArray(held)) return '';
  return String(held);
}

/** Every object of one type, in the order the document holds them. */
function objectsOf(document: IdfDocument<AnyTypeMap>, objectType: string): IdfObject[] {
  // `all` rather than the internal `collection`: it is the one public name for this, and it takes
  // a runtime type name and hands back untyped objects, which is exactly this reader's case.
  return document.all(objectType).toArray();
}

/** The first object of a type, or none. Singletons here, so first is the one. */
function firstOf(document: IdfDocument<AnyTypeMap>, objectType: string): IdfObject | undefined {
  return objectsOf(document, objectType)[0];
}

/**
 * One enumerated field in the schema's spelling.
 *
 * EnergyPlus matches these without regard to case, so the example set holds `Wall`, `WALL` and
 * `wall` for one type. Reporting the schema's spelling is not a claim about the document: the
 * schema defines the value, and reporting the author's would hand every consumer the same case fold
 * to write and show three kinds of wall in three colours.
 *
 * A value outside the enumeration passes through as itself, because a category invented for it
 * would say something the model does not.
 */
function canonical(
  obj: IdfObject | undefined,
  field: string,
  value: StoredValue | undefined
): string {
  const text = value === undefined || Array.isArray(value) ? '' : String(value).trim();
  if (text === '' || obj === undefined) return text;
  const permitted = obj.fieldSchema(field)?.e;
  if (permitted === undefined) return text;
  for (const candidate of permitted) {
    if (String(candidate).toLowerCase() === text.toLowerCase()) return String(candidate);
  }
  return text;
}

/** Read `GlobalGeometryRules` and `Building`, recording what had to be assumed. */
function readRules(document: IdfDocument<AnyTypeMap>): AppliedRules {
  const rules = firstOf(document, 'GlobalGeometryRules');
  const building = firstOf(document, 'Building');

  const declared: Record<string, string> = {};
  const defaulted: string[] = [];
  for (const { member, field, fallback } of DEFAULT_RULES) {
    let value = canonical(rules, field, rules?.get(field));
    if (value === '') {
      value = fallback;
      defaulted.push(field);
    }
    declared[member] = value;
  }
  // A `Building` that states no axis is assumed to be unrotated exactly as an absent one is, so both
  // are recorded. A stated zero is a declaration and is not.
  const statedAxis = building?.get('north_axis');
  if (
    building === undefined ||
    statedAxis === undefined ||
    statedAxis === null ||
    statedAxis === ''
  ) {
    defaulted.push('north_axis');
  }

  const coordinateSystem = declared['coordinateSystem'] as string;
  const vertexEntryDirection = declared['vertexEntryDirection'] as string;
  return {
    coordinateSystem,
    vertexEntryDirection,
    startingVertexPosition: declared['startingVertexPosition'] as string,
    northAxis: numberField(building, 'north_axis'),
    defaulted,
    isRelative: coordinateSystem.toLowerCase() === 'relative',
    isClockwise: vertexEntryDirection.toLowerCase().startsWith('clockwise'),
  };
}

// ---------------------------------------------------------------------------
// The three clauses
// ---------------------------------------------------------------------------

/**
 * Apply clause one and clause two to one polygon.
 *
 * Clause one is conditional on the declared coordinate system, which is the whole reason the twelve
 * world models with a non-zero zone origin come out right. Clause two is applied about the world
 * origin, so that the building turns as one body.
 *
 * `fixedToSite` is clause two's one exception, and it is the engine's own. Site shading is fixed in
 * space and does not turn with the building, which is the whole difference between
 * `Shading:Site:Detailed` and `Shading:Building:Detailed`: the two carry identical fields, and at a
 * north axis of 158.434 the engine reports the same square where it was authored under the first
 * type and turned by 158.434 degrees under the second. Every other surface turns.
 *
 * The north axis is negated because EnergyPlus measures it clockwise from true north, while
 * `rotateZ` turns counter-clockwise.
 */
function place(
  polygon: Polygon3D,
  zone: IdfObject | undefined,
  rules: AppliedRules,
  fixedToSite = false
): Polygon3D {
  let placed = polygon;
  if (rules.isRelative && zone !== undefined) {
    const relativeNorth = numberField(zone, 'direction_of_relative_north');
    if (relativeNorth !== 0) placed = placed.rotateZ(-relativeNorth, Vector3D.origin());
    const origin = new Vector3D(
      numberField(zone, 'x_origin'),
      numberField(zone, 'y_origin'),
      numberField(zone, 'z_origin')
    );
    if (!origin.equals(Vector3D.origin())) placed = placed.translate(origin);
  }
  if (rules.northAxis !== 0 && !fixedToSite) {
    placed = placed.rotateZ(-rules.northAxis, Vector3D.origin());
  }
  return placed;
}

/**
 * Apply clause three: the author's ring, reversed when the model declares clockwise entry.
 *
 * THE FIRST VERTEX STAYS WHERE THE AUTHOR PUT IT.
 *
 * Reversing the whole list would send the last vertex to the front, which renormalises the starting
 * vertex as a side effect of normalising the orientation. That is forbidden, and the corpus cannot
 * catch it: the ring comparison is rotation-insensitive by design, so both forms pass. So the head
 * is held and the tail reversed, which is the same ring traversed the other way from the same
 * corner.
 */
function wind(polygon: Polygon3D, rules: AppliedRules): Polygon3D {
  if (!rules.isClockwise) return polygon;
  const [head, ...tail] = polygon.vertices;
  if (head === undefined) return polygon;
  return new Polygon3D([head, ...tail.reverse()]);
}

// ---------------------------------------------------------------------------
// Walking the document
// ---------------------------------------------------------------------------

/**
 * Each object type's position in the document, by where the file first states it.
 *
 * A document's collections are keyed by type in the order the parse first met each type, so this is
 * the file's own order at type granularity and it is available for every document, however it was
 * read.
 */
function typeRank(document: IdfDocument<AnyTypeMap>): Map<string, number> {
  const rank = new Map<string, number>();
  document.types().forEach((objectType, at) => rank.set(objectType, at));
  return rank;
}

/**
 * Every object of the given types, as close to the order the document states them as is known.
 *
 * Two sources, and the difference between them is worth stating because the better one is not
 * always there. `regionOf` gives an object's byte offset, which is document order exactly, but only
 * for a document read with `preserveFormatting`: for every other document it answers nothing. So
 * the fallback is not the rare case, it is the common one, and it had better be the file's order
 * too as far as it goes.
 *
 * The fallback ranks an object by where the file first states its TYPE, then by its position within
 * that type. That groups the types rather than interleaving them, which per-object offsets would
 * not, and it is the most the document can answer without its source text. What it is not is the
 * order of a hardcoded list of types, which owes nothing to the model and would make the emitted
 * order a property of the reader rather than of the file being read.
 */
function inDocumentOrder(
  document: IdfDocument<AnyTypeMap>,
  objectTypes: readonly string[],
  rank: Map<string, number>
): IdfObject[] {
  const placed: { at: number; obj: IdfObject }[] = [];
  const unplaced: { type: number; within: number; obj: IdfObject }[] = [];
  for (const objectType of objectTypes) {
    const ofType = rank.get(objectType) ?? rank.size;
    objectsOf(document, objectType).forEach((obj, within) => {
      const region = document.regionOf(obj);
      if (region === undefined) unplaced.push({ type: ofType, within, obj });
      else placed.push({ at: region.start, obj });
    });
  }
  placed.sort((one, other) => one.at - other.at);
  unplaced.sort((one, other) => one.type - other.type || one.within - other.within);
  return [...placed.map((row) => row.obj), ...unplaced.map((row) => row.obj)];
}

/**
 * The vertices a surface states, in the author's order.
 *
 * Two storage shapes, as in the first language. An extensible type holds its repeats under the
 * schema's wrapper; a type whose vertex count is fixed in the schema, `FenestrationSurface:Detailed`
 * among them, holds flat `vertex_N_x_coordinate` fields instead.
 *
 * The wrapper is read with `get` and not through the `extensible` accessor, which is a correctness
 * choice rather than a stylistic one. That accessor WRITES: it stores an empty array on an object
 * whose wrapper is absent, and on a document that retains its source it replaces the stored array
 * with a tracking wrapper. A read that modifies the document contradicts this module's one
 * guarantee. `get` hands back the stored value and touches nothing, which is what the first
 * language's `data.get("vertices")` does.
 */
function verticesOf(surface: IdfObject): Vector3D[] {
  const vertices: Vector3D[] = [];
  const held = surface.get('vertices');
  if (Array.isArray(held)) {
    for (const group of held) {
      const x = group['vertex_x_coordinate'];
      const y = group['vertex_y_coordinate'];
      const z = group['vertex_z_coordinate'];
      if (x === undefined || y === undefined || z === undefined) continue;
      if (x === '' || y === '' || z === '') continue;
      vertices.push(new Vector3D(Number(x), Number(y), Number(z)));
    }
    // Returned whether or not it yielded a vertex, as the first language returns it. A type that
    // states the wrapper does not also state flat coordinates, and falling through to them would
    // read a surface the other language does not.
    return vertices;
  }

  for (let at = 1; ; at += 1) {
    const x = surface.get(`vertex_${at}_x_coordinate`);
    const y = surface.get(`vertex_${at}_y_coordinate`);
    const z = surface.get(`vertex_${at}_z_coordinate`);
    if (x === undefined || y === undefined || z === undefined) break;
    if (x === '' || y === '' || z === '') break;
    vertices.push(new Vector3D(Number(x), Number(y), Number(z)));
  }
  return vertices;
}

/**
 * The zone a surface names, under whichever of the two field names its type uses.
 *
 * Only fields that name a ZONE. `base_surface_name` names a surface, and reading it here handed a
 * surface's name back to a caller that looks it up among the zones: a miss at best, and a
 * `zone-not-found` naming a wall at worst.
 */
function zoneOf(surface: IdfObject | undefined): string {
  if (surface === undefined) return '';
  for (const field of ['zone_name', 'zone_or_zonelist_name']) {
    const value = textField(surface, field);
    if (value !== '') return value;
  }
  return '';
}

/**
 * Place one surface, or say why it could not be placed.
 *
 * Never throws and never skips. A building with one bad wall is still a building a reader wants to
 * see, so an object that cannot be placed becomes an entry rather than an exception.
 */
function resolveOne(
  surface: IdfObject,
  zones: Map<string, IdfObject>,
  rules: AppliedRules,
  surfacesByName: Map<string, IdfObject>
): ResolvedSurface | UnresolvedObject {
  const objectType = surface.typeName;
  const name = surface.name;
  const isShading = (SHADING as readonly string[]).includes(objectType);
  const isFenestration = objectType === FENESTRATION;

  const vertices = verticesOf(surface);
  if (vertices.length < 3) {
    return {
      objectType,
      name,
      reason: vertices.length === 0 ? 'no-vertices' : 'too-few-vertices',
      missingReference: undefined,
    };
  }

  let parentSurface: string | undefined;
  let zoneName: string;
  if (isFenestration) {
    parentSurface = textField(surface, 'building_surface_name');
    const parent = surfacesByName.get(parentSurface.toUpperCase());
    if (parent === undefined) {
      return {
        objectType,
        name,
        reason: 'parent-surface-not-found',
        missingReference: parentSurface,
      };
    }
    // Fenestration is stated in its parent's frame, so it resolves against the parent's zone.
    zoneName = zoneOf(parent);
  } else if (objectType === 'Shading:Zone:Detailed') {
    // Attached to a base surface rather than to a zone, so it inherits that surface's zone.
    zoneName = zoneOf(surfacesByName.get(textField(surface, 'base_surface_name').toUpperCase()));
  } else if (isShading) {
    // Site and building shading are stated in world coordinates and belong to no zone.
    zoneName = '';
  } else {
    zoneName = zoneOf(surface);
  }

  const zone = zoneName === '' ? undefined : zones.get(zoneName.toUpperCase());
  if (zoneName !== '' && zone === undefined && !isShading) {
    return { objectType, name, reason: 'zone-not-found', missingReference: zoneName };
  }

  const polygon = wind(
    place(new Polygon3D(vertices), zone, rules, objectType === SITE_SHADING),
    rules
  );

  // The schema gives a shading surface no surface-type field, so the canonical object type goes in
  // that position. It is neither an empty string, which says nothing, nor an invented word like
  // "Shading", which is in no model a reader can open.
  const surfaceType = isShading
    ? objectType
    : canonical(surface, 'surface_type', surface.get('surface_type'));

  return {
    objectType,
    name,
    polygon,
    normal: polygon.normal,
    area: polygon.area,
    zone: isShading ? '' : zoneName,
    surfaceType,
    boundary: canonical(
      surface,
      'outside_boundary_condition',
      surface.get('outside_boundary_condition')
    ),
    construction: textField(surface, 'construction_name'),
    parentSurface,
    isShading,
  };
}

/**
 * The box enclosing every resolved vertex.
 *
 * Absent when nothing resolved, rather than a degenerate box at the origin that a consumer would
 * dutifully frame.
 */
function boundsOf(surfaces: readonly ResolvedSurface[]): SceneBounds | undefined {
  // Six numbers rather than two vectors: carrying the running extent as vectors allocates two
  // immutable objects per vertex, and a real model has tens of thousands of them.
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let seen = false;
  for (const surface of surfaces) {
    for (const vertex of surface.polygon.vertices) {
      seen = true;
      // `Math.min`/`Math.max` rather than a comparison, so that a coordinate the model states
      // unreadably propagates exactly as it did when the extent was carried as vectors, instead of
      // being quietly skipped on one axis.
      minX = Math.min(minX, vertex.x);
      minY = Math.min(minY, vertex.y);
      minZ = Math.min(minZ, vertex.z);
      maxX = Math.max(maxX, vertex.x);
      maxY = Math.max(maxY, vertex.y);
      maxZ = Math.max(maxZ, vertex.z);
    }
  }
  if (!seen) return undefined;
  return { min: new Vector3D(minX, minY, minZ), max: new Vector3D(maxX, maxY, maxZ) };
}

/**
 * Geometry types the model states that this slice does not read, in first-occurrence order.
 *
 * This is what makes a model of simplified surfaces distinguishable from a model with no geometry
 * at all. Without it, both look like an empty scene and a reader is told nothing.
 */
function unattemptedOf(
  document: IdfDocument<AnyTypeMap>,
  rank: Map<string, number>
): UnattemptedType[] {
  const found: { known: number; at: number; objectType: string; count: number }[] = [];
  for (const objectType of UNREAD) {
    const objects = objectsOf(document, objectType);
    if (objects.length === 0) continue;
    // Folded rather than spread into `Math.min`: a model may state more objects of one type than
    // the engine accepts as arguments in a single call, and a stack overflow there would fail a
    // read of a file that is merely large.
    let earliest: number | undefined;
    for (const obj of objects) {
      const start = document.regionOf(obj)?.start;
      if (start === undefined) continue;
      if (earliest === undefined || start < earliest) earliest = start;
    }
    // Sorted by byte offset when the document carries its source, and by where the file first
    // states the type otherwise. Never by the order of `UNREAD`, which is this module's.
    found.push(
      earliest !== undefined
        ? { known: 0, at: earliest, objectType, count: objects.length }
        : { known: 1, at: rank.get(objectType) ?? rank.size, objectType, count: objects.length }
    );
  }
  found.sort(
    (one, other) =>
      one.known - other.known ||
      one.at - other.at ||
      (one.objectType < other.objectType ? -1 : one.objectType > other.objectType ? 1 : 0)
  );
  return found.map(({ objectType, count }) => ({ objectType, count }));
}

/**
 * Resolve a model's geometry into one frame, leaving the model untouched.
 *
 * One argument, one return, no options. There is no `includeShading`, no `zones` filter and no
 * `colorBy`: a filter is a list operation the caller already has, and a colour is a viewing
 * decision this function has no business making.
 *
 * @param document the document to read. It is not modified, and a preserving write before and after
 *   yields identical bytes.
 * @returns a {@link Scene} in which every geometry object in the model appears exactly once, as a
 *   resolved surface, an unresolved object with a reason, or a count under an unattempted type.
 *
 * @example
 * ```ts
 * import { parseIdf } from '@idfkit/core';
 * import { getScene } from '@idfkit/geometry';
 *
 * const { document } = parseIdf(text, schema);
 * const scene = getScene(document);
 * for (const surface of scene.surfaces) {
 *   console.log(surface.name, surface.area, surface.normal.asTuple());
 * }
 * ```
 */
export function getScene(document: IdfDocument<AnyTypeMap>): Scene {
  const rules = readRules(document);
  // One walk of the document's type keys, shared by the two orderings that need it.
  const rank = typeRank(document);

  const zones = new Map<string, IdfObject>();
  for (const zone of objectsOf(document, 'Zone')) zones.set(zone.name.toUpperCase(), zone);

  const surfacesByName = new Map<string, IdfObject>();
  for (const objectType of PARENTS) {
    for (const obj of objectsOf(document, objectType))
      surfacesByName.set(obj.name.toUpperCase(), obj);
  }

  const surfaces: ResolvedSurface[] = [];
  const unresolved: UnresolvedObject[] = [];
  for (const surface of inDocumentOrder(document, READ, rank)) {
    const outcome = resolveOne(surface, zones, rules, surfacesByName);
    if ('polygon' in outcome) surfaces.push(outcome);
    else unresolved.push(outcome);
  }

  return {
    surfaces,
    bounds: boundsOf(surfaces),
    applied: rules,
    unresolved,
    unattempted: unattemptedOf(document, rank),
  };
}
