import { createHash } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { Schema } from '@idfkit/schemas';

// Imported from the module rather than the package root: `src/index.ts` does not
// re-export it yet, and this file does not own that file.
import { describeObjectType } from '../src/introspect/describe.js';
import type { FieldDescription, ObjectDescription } from '../src/introspect/describe.js';

import { schema } from './helpers.js';

let v26: Schema;
beforeAll(async () => {
  v26 = await schema('26.1.0');
});

interface PythonShape {
  /** `[name, field_type]` in the order Python emits them. */
  fields: [string, string | null][];
  requiredFields: string[];
  hasName: boolean;
  isExtensible: boolean;
  extensibleSize: number | undefined;
}

/**
 * Ground truth captured by running Python, so these assertions compare the port
 * against the library it is a port of rather than against its own assumptions.
 *
 * Regenerate from the idfkit checkout with:
 *
 * ```py
 * from idfkit import get_schema, LATEST_VERSION
 * from idfkit.introspection import describe_object_type
 * s = get_schema(LATEST_VERSION)
 * d = describe_object_type(s, "Zone")
 * print([(f.name, f.field_type) for f in d.fields], d.required_fields, d.has_name)
 * ```
 */
const PYTHON_SHAPES: Record<string, PythonShape> = {
  Zone: {
    fields: [
      ['direction_of_relative_north', 'number'],
      ['x_origin', 'number'],
      ['y_origin', 'number'],
      ['z_origin', 'number'],
      ['type', 'integer'],
      ['multiplier', 'integer'],
      ['ceiling_height', 'number|string'],
      ['volume', 'number|string'],
      ['floor_area', 'number|string'],
      ['zone_inside_convection_algorithm', 'string'],
      ['zone_outside_convection_algorithm', 'string'],
      ['part_of_total_floor_area', 'string'],
    ],
    requiredFields: [],
    hasName: true,
    isExtensible: false,
    extensibleSize: undefined,
  },
  Material: {
    fields: [
      ['roughness', 'string'],
      ['thickness', 'number'],
      ['conductivity', 'number'],
      ['density', 'number'],
      ['specific_heat', 'number'],
      ['thermal_absorptance', 'number'],
      ['solar_absorptance', 'number'],
      ['visible_absorptance', 'number'],
    ],
    requiredFields: ['roughness', 'thickness', 'conductivity', 'density', 'specific_heat'],
    hasName: true,
    isExtensible: false,
    extensibleSize: undefined,
  },
  'BuildingSurface:Detailed': {
    fields: [
      ['surface_type', 'string'],
      ['construction_name', 'string'],
      ['zone_name', 'string'],
      ['space_name', 'string'],
      ['outside_boundary_condition', 'string'],
      ['outside_boundary_condition_object', 'string'],
      ['sun_exposure', 'string'],
      ['wind_exposure', 'string'],
      ['view_factor_to_ground', 'number|string'],
      ['number_of_vertices', 'number|string'],
      ['vertex_x_coordinate', 'number'],
      ['vertex_y_coordinate', 'number'],
      ['vertex_z_coordinate', 'number'],
    ],
    requiredFields: [
      'surface_type',
      'construction_name',
      'zone_name',
      'outside_boundary_condition',
    ],
    hasName: true,
    isExtensible: true,
    extensibleSize: 3,
  },
  'Schedule:Compact': {
    fields: [
      ['schedule_type_limits_name', 'string'],
      ['field', 'number|string'],
    ],
    requiredFields: [],
    hasName: true,
    isExtensible: true,
    extensibleSize: 1,
  },
  ZoneList: {
    fields: [
      ['zones', 'array'],
      ['zone_name', 'string'],
    ],
    requiredFields: [],
    hasName: true,
    isExtensible: true,
    extensibleSize: 1,
  },
  'Site:SpectrumData': {
    fields: [
      ['spectrum_data_type', 'string'],
      ['wavelength', 'number'],
      ['spectrum', 'number'],
      ['wavelength_1', 'number'],
      ['spectrum_2', 'number'],
    ],
    requiredFields: ['spectrum_data_type'],
    hasName: true,
    isExtensible: true,
    extensibleSize: 2,
  },
  Branch: {
    fields: [
      ['pressure_drop_curve_name', 'string'],
      ['component_object_type', 'string'],
      ['component_name', 'string'],
      ['component_inlet_node_name', 'string'],
      ['component_outlet_node_name', 'string'],
    ],
    requiredFields: [],
    hasName: true,
    isExtensible: true,
    extensibleSize: 4,
  },
  'Schedule:Day:Interval': {
    fields: [
      ['schedule_type_limits_name', 'string'],
      ['interpolate_to_timestep', 'string'],
      ['time', 'string'],
      ['value_until_time', 'number'],
    ],
    requiredFields: [],
    hasName: true,
    isExtensible: true,
    extensibleSize: 2,
  },
  Construction: {
    fields: [
      ['outside_layer', 'string'],
      ['layer_2', 'string'],
      ['layer_3', 'string'],
      ['layer_4', 'string'],
      ['layer_5', 'string'],
      ['layer_6', 'string'],
      ['layer_7', 'string'],
      ['layer_8', 'string'],
      ['layer_9', 'string'],
      ['layer_10', 'string'],
    ],
    requiredFields: ['outside_layer'],
    hasName: true,
    isExtensible: false,
    extensibleSize: undefined,
  },
  Version: {
    fields: [['version_identifier', 'string']],
    requiredFields: [],
    hasName: false,
    isExtensible: false,
    extensibleSize: undefined,
  },
  Timestep: {
    fields: [['number_of_timesteps_per_hour', 'integer']],
    requiredFields: [],
    hasName: false,
    isExtensible: false,
    extensibleSize: undefined,
  },
  GlobalGeometryRules: {
    fields: [
      ['vertex_entry_direction', 'string'],
      ['coordinate_system', 'string'],
      ['daylighting_reference_point_coordinate_system', 'string'],
      ['rectangular_surface_coordinate_system', 'string'],
    ],
    requiredFields: ['starting_vertex_position', 'vertex_entry_direction', 'coordinate_system'],
    hasName: false,
    isExtensible: false,
    extensibleSize: undefined,
  },
  'Output:Variable': {
    fields: [
      ['variable_name', 'string'],
      ['reporting_frequency', 'string'],
      ['schedule_name', 'string'],
    ],
    requiredFields: ['variable_name'],
    hasName: false,
    isExtensible: false,
    extensibleSize: undefined,
  },
  AvailabilityManagerAssignmentList: {
    fields: [
      ['managers', 'array'],
      ['availability_manager_object_type', 'string'],
      ['availability_manager_name', 'string'],
    ],
    requiredFields: [],
    hasName: true,
    isExtensible: true,
    extensibleSize: 2,
  },
  'AirTerminal:SingleDuct:ConstantVolume:CooledBeam': {
    fields: [
      ['availability_schedule_name', 'string'],
      ['cooled_beam_type', 'string'],
      ['supply_air_inlet_node_name', 'string'],
      ['supply_air_outlet_node_name', 'string'],
      ['chilled_water_inlet_node_name', 'string'],
      ['chilled_water_outlet_node_name', 'string'],
      ['supply_air_volumetric_flow_rate', 'number|string'],
      ['maximum_total_chilled_water_volumetric_flow_rate', 'number|string'],
      ['number_of_beams', 'integer|string'],
      ['beam_length', 'number|string'],
      ['design_inlet_water_temperature', 'number'],
      ['design_outlet_water_temperature', 'number'],
      ['coil_surface_area_per_coil_length', 'number'],
      ['model_parameter_a', 'number'],
      ['model_parameter_n1', 'number'],
      ['model_parameter_n2', 'number'],
      ['model_parameter_n3', 'number'],
      ['model_parameter_a0', 'number'],
      ['model_parameter_k1', 'number'],
      ['model_parameter_n', 'number'],
      ['coefficient_of_induction_kin', 'number|string'],
      ['leaving_pipe_inside_diameter', 'number'],
    ],
    requiredFields: [
      'cooled_beam_type',
      'supply_air_inlet_node_name',
      'supply_air_outlet_node_name',
      'chilled_water_inlet_node_name',
      'chilled_water_outlet_node_name',
    ],
    hasName: true,
    isExtensible: false,
    extensibleSize: undefined,
  },
};

/**
 * sha256 over `type|field,field,...` for all 858 types in 26.1.0, sorted by type
 * name, less the two types listed in KNOWN_ORDER_DIVERGENCES.
 */
const PYTHON_FIELD_NAME_DIGEST = '9a62d871cc2c194a1ae1b273db7c9730195f4161202696c8058a9772f6955925';

/**
 * The only two types whose field ORDER cannot be reproduced from the bundle.
 *
 * Both take Python's fallback path — `legacy_idd.fields` is just `["name"]`, so
 * Python orders their fields by the schema's property declaration order. The
 * bundle content-addresses each definition through a serializer that sorts
 * object keys, so `SlimType.p` arrives alphabetized and declaration order is
 * gone. For 57 of the 59 fallback types in 26.1.0 that is invisible, because
 * they have at most one fixed property; these two have two.
 *
 * Deliberately not patched with an "array key sorts last" rule: it would happen
 * to fix both here, and it is wrong for `SolarCollector:UnglazedTranspired:Multisystem`
 * in 8.9.0 through 9.2.0, where the array really is declared first. Closing this
 * needs the bundle to record declaration order, which is a `@idfkit/schemas`
 * change.
 *
 * These two are the whole list for 9.4.0 through 26.1.0. 8.9.0 through 9.2.0 add
 * six more, because there the array's `items.properties` order also differs from
 * `legacy_idd.extensibles` order, and only the latter survives in the bundle.
 */
const KNOWN_ORDER_DIVERGENCES: Record<string, { python: string[]; typescript: string[] }> = {
  'ZoneProperty:UserViewFactors:BySurfaceName': {
    python: [
      'zone_or_zonelist_or_space_or_spacelist_name',
      'view_factors',
      'from_surface',
      'to_surface',
      'view_factor',
    ],
    typescript: [
      'view_factors',
      'zone_or_zonelist_or_space_or_spacelist_name',
      'from_surface',
      'to_surface',
      'view_factor',
    ],
  },
  ZoneTerminalUnitList: {
    python: ['zone_terminal_unit_list_name', 'terminal_units', 'zone_terminal_unit_name'],
    typescript: ['terminal_units', 'zone_terminal_unit_list_name', 'zone_terminal_unit_name'],
  },
};
/**
 * Aggregates over all 858 object types in 26.1.0, from the same Python run.
 *
 * A single wrong branch in the port moves one of these, which the fifteen
 * hand-checked types above would not necessarily catch.
 */
const PYTHON_TOTALS = {
  types: 858,
  fields: 12712,
  requiredFields: 2595,
  hasName: 694,
  isExtensible: 120,
  default: 3887,
  units: 4776,
  minimum: 2459,
  maximum: 1339,
  // Python reports 1113. The extra one is
  // `AirTerminal:SingleDuct:ConstantVolume:CooledBeam.number_of_beams`, the one
  // `anyOf: [{integer}, {string}]` field in the version: the bundle hoists the
  // integer branch's `exclusiveMinimum`, and without an `auto` flag there is
  // nothing here to recognise it as an anyOf field and drop it again.
  exclusiveMinimum: 1114,
  exclusiveMaximum: 145,
  isReference: 2806,
};

/** Python's `field_type` histogram over every field of every type. */
const PYTHON_FIELD_TYPES = {
  string: 5405,
  number: 6236,
  integer: 227,
  array: 37,
  'number|string': 806,
  'integer|string': 1,
};

function field(description: ObjectDescription, name: string): FieldDescription {
  const found = description.fields.find((f) => f.name === name);
  if (found === undefined) throw new Error(`no field ${name} on ${description.objType}`);
  return found;
}

/** Every description in the version, computed once and reused. */
function describeAll(s: Schema): ObjectDescription[] {
  return s.typeNames.map((name) => describeObjectType(s, name));
}

describe('describeObjectType', () => {
  it('describes Zone', () => {
    const zone = describeObjectType(v26, 'Zone');

    expect(zone.objType).toBe('Zone');
    expect(zone.hasName).toBe(true);
    expect(zone.isExtensible).toBe(false);
    expect(zone.extensibleSize).toBeUndefined();
    expect(zone.fields.map((f) => f.name)).toContain('ceiling_height');
  });

  it('canonicalizes a mis-cased type name', () => {
    // Divergence, deliberate: Python's `describe_object_type` goes straight to
    // `_properties[obj_type]` and raises on "zone". The rest of @idfkit/core is
    // uniformly case-insensitive on type names, and matching Python's
    // case-sensitivity in one function would be the surprise. For every name
    // Python accepts the two agree, including on `objType`.
    expect(describeObjectType(v26, 'zone').objType).toBe('Zone');
  });

  it('rejects an unknown object type the way the rest of the package does', () => {
    // Python raises UnknownObjectTypeError. That name has no registered
    // TypeScript counterpart, so this reuses Schema.require's error rather than
    // introducing an unregistered public error class.
    expect(() => describeObjectType(v26, 'NotAThing')).toThrow(
      /not defined in EnergyPlus 26\.1\.0/
    );
  });
});

describe('agreement with Python', () => {
  for (const [typeName, expected] of Object.entries(PYTHON_SHAPES)) {
    it(`matches Python's field order and types for ${typeName}`, () => {
      const actual = describeObjectType(v26, typeName);

      expect(actual.fields.map((f) => f.name)).toEqual(expected.fields.map(([n]) => n));
      expect(actual.requiredFields).toEqual(expected.requiredFields);
      expect(actual.hasName).toBe(expected.hasName);
      expect(actual.isExtensible).toBe(expected.isExtensible);
      expect(actual.extensibleSize).toBe(expected.extensibleSize);
    });
  }

  it('matches Python field-for-field, except for one known schema shape', () => {
    const mismatches: string[] = [];
    for (const [typeName, expected] of Object.entries(PYTHON_SHAPES)) {
      const actual = describeObjectType(v26, typeName);
      for (const [i, [name, fieldType]] of expected.fields.entries()) {
        const got = actual.fields[i];
        if (got?.name !== name || got.fieldType !== (fieldType ?? undefined)) {
          mismatches.push(`${typeName}.${name}: python=${fieldType} ts=${got?.fieldType}`);
        }
      }
    }
    // `anyOf: [{integer}, {string}]` collapses in the slim bundle to a bare
    // integer with no `auto` flag, so the union is unrecoverable. Exactly one
    // field in 26.1.0 has that shape (eight across all 17 versions).
    expect(mismatches).toEqual([
      'AirTerminal:SingleDuct:ConstantVolume:CooledBeam.number_of_beams: python=integer|string ts=integer',
    ]);
  });

  it('matches Python field name and order for every type in the version', () => {
    const lines = [...v26.typeNames]
      .filter((name) => !(name in KNOWN_ORDER_DIVERGENCES))
      .sort()
      .map(
        (name) =>
          `${name}|${describeObjectType(v26, name)
            .fields.map((f) => f.name)
            .join(',')}`
      );
    expect(lines).toHaveLength(856);

    const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
    expect(digest).toBe(PYTHON_FIELD_NAME_DIGEST);
  });

  it('matches Python across versions, not just the newest schema', async () => {
    // Field order is derived from per-version schema data, so a rule that holds
    // in 26.1.0 can still be wrong in an older release. Same digest recipe,
    // same two exclusions, 813 of 815 types.
    const v94 = await schema('9.4.0');
    const lines = [...v94.typeNames]
      .filter((name) => !(name in KNOWN_ORDER_DIVERGENCES))
      .sort()
      .map(
        (name) =>
          `${name}|${describeObjectType(v94, name)
            .fields.map((f) => f.name)
            .join(',')}`
      );
    expect(lines).toHaveLength(813);

    const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
    expect(digest).toBe('02aef807379219fa13dcf3c7df3c6592126dfca01684e1c868b3b5dae5fdeadd');
  });

  it('diverges from Python on exactly the two documented orderings', () => {
    for (const [typeName, expected] of Object.entries(KNOWN_ORDER_DIVERGENCES)) {
      const names = describeObjectType(v26, typeName).fields.map((f) => f.name);
      expect(names).toEqual(expected.typescript);
      expect(names).not.toEqual(expected.python);
      // The names are all there; only their order differs.
      expect([...names].sort()).toEqual([...expected.python].sort());
    }
  });

  it('matches Python on the whole-version totals', () => {
    const all = describeAll(v26);
    const totals = {
      types: all.length,
      fields: all.reduce((n, d) => n + d.fields.length, 0),
      requiredFields: all.reduce((n, d) => n + d.requiredFields.length, 0),
      hasName: all.filter((d) => d.hasName).length,
      isExtensible: all.filter((d) => d.isExtensible).length,
      default: 0,
      units: 0,
      minimum: 0,
      maximum: 0,
      exclusiveMinimum: 0,
      exclusiveMaximum: 0,
      isReference: 0,
    };
    for (const d of all) {
      for (const f of d.fields) {
        if (f.default !== undefined) totals.default += 1;
        if (f.units !== undefined) totals.units += 1;
        if (f.minimum !== undefined) totals.minimum += 1;
        if (f.maximum !== undefined) totals.maximum += 1;
        if (f.exclusiveMinimum !== undefined) totals.exclusiveMinimum += 1;
        if (f.exclusiveMaximum !== undefined) totals.exclusiveMaximum += 1;
        if (f.isReference) totals.isReference += 1;
      }
    }

    expect(totals).toEqual(PYTHON_TOTALS);
  });

  it('matches Python on the field-type histogram, less the one known shape', () => {
    const histogram: Record<string, number> = {};
    for (const d of describeAll(v26)) {
      for (const f of d.fields) {
        const key = f.fieldType ?? '<none>';
        histogram[key] = (histogram[key] ?? 0) + 1;
      }
    }

    const { 'integer|string': unions, ...shared } = PYTHON_FIELD_TYPES;
    expect(histogram).toEqual({
      ...shared,
      // The one `integer|string` field lands in `integer` instead.
      integer: shared.integer + unions,
    });
  });
});

describe('the extensible group', () => {
  it('appends extensible field names after the positional ones', () => {
    const surface = describeObjectType(v26, 'BuildingSurface:Detailed');

    expect(surface.isExtensible).toBe(true);
    // Derived from `x.fields.length`; Python reads `extensible_size` directly.
    expect(surface.extensibleSize).toBe(3);
    expect(surface.fields.slice(-3).map((f) => f.name)).toEqual([
      'vertex_x_coordinate',
      'vertex_y_coordinate',
      'vertex_z_coordinate',
    ]);
    // The array wrapper key itself is not a field, on either side.
    expect(surface.fields.map((f) => f.name)).not.toContain('vertices');
  });

  it('resolves an extensible field definition from the array items', () => {
    const vertex = field(
      describeObjectType(v26, 'BuildingSurface:Detailed'),
      'vertex_x_coordinate'
    );

    expect(vertex).toEqual({
      name: 'vertex_x_coordinate',
      fieldType: 'number',
      required: false,
      default: undefined,
      units: 'm',
      enumValues: undefined,
      minimum: undefined,
      maximum: undefined,
      exclusiveMinimum: undefined,
      exclusiveMaximum: undefined,
      note: undefined,
      isReference: false,
      objectList: undefined,
    });
  });

  it('falls back to property order when legacy_idd carries only the name', () => {
    // ZoneList's `legacy_idd.fields` is just `["name"]`, so Python's `fields[1:]`
    // is empty and it falls back to the merged property keys.
    const zoneList = describeObjectType(v26, 'ZoneList');

    expect(zoneList.fields.map((f) => f.name)).toEqual(['zones', 'zone_name']);
    expect(field(zoneList, 'zones').fieldType).toBe('array');
    expect(field(zoneList, 'zone_name').objectList).toEqual(['ZoneNames']);
  });

  it('does not duplicate extensible names already in the positional order', () => {
    // Site:SpectrumData lists its extensibles inline in legacy_idd.fields.
    const spectrum = describeObjectType(v26, 'Site:SpectrumData');

    expect(spectrum.fields.map((f) => f.name)).toEqual([
      'spectrum_data_type',
      'wavelength',
      'spectrum',
      'wavelength_1',
      'spectrum_2',
    ]);
  });
});

describe('Schedule:Compact, the largest known behavioural disagreement', () => {
  it("types the extensible `field` as Python's heterogeneous union", () => {
    const compact = describeObjectType(v26, 'Schedule:Compact');

    expect(compact.extensibleSize).toBe(1);
    // The slim bundle collapses `anyOf: [{number}, {string}]` to a numeric
    // storage class plus `auto`. That flag is what lets the union be
    // reconstructed exactly rather than guessed: every one of the 13052 such
    // fields across the 17 bundled versions declares number before string.
    expect(field(compact, 'field')).toEqual({
      name: 'field',
      fieldType: 'number|string',
      required: false,
      default: undefined,
      units: undefined,
      enumValues: undefined,
      minimum: undefined,
      maximum: undefined,
      exclusiveMinimum: undefined,
      exclusiveMaximum: undefined,
      note: undefined,
      isReference: false,
      objectList: undefined,
    });
  });

  it('suppresses constraints that live on the collapsed numeric branch', () => {
    // Python reads minimum/maximum/exclusive* from the top level of the field
    // schema only, and no anyOf field in any bundled version puts them there —
    // they sit on the numeric branch, which Python never reads. The bundle does
    // hoist them, so the port drops them again to stay in agreement.
    const ceiling = field(describeObjectType(v26, 'Zone'), 'ceiling_height');

    expect(ceiling.fieldType).toBe('number|string');
    expect(ceiling.default).toBe('Autocalculate');
    expect(ceiling.units).toBe('m');
    expect(ceiling.minimum).toBeUndefined();
    expect(ceiling.maximum).toBeUndefined();
    expect(ceiling.exclusiveMinimum).toBeUndefined();
    expect(ceiling.exclusiveMaximum).toBeUndefined();
  });
});

describe('ordinary field constraints', () => {
  it('reports enum, required and reference metadata', () => {
    const material = describeObjectType(v26, 'Material');

    expect(material.requiredFields).toEqual([
      'roughness',
      'thickness',
      'conductivity',
      'density',
      'specific_heat',
    ]);
    expect(field(material, 'roughness')).toEqual({
      name: 'roughness',
      fieldType: 'string',
      required: true,
      default: undefined,
      units: undefined,
      enumValues: ['MediumRough', 'MediumSmooth', 'Rough', 'Smooth', 'VeryRough', 'VerySmooth'],
      minimum: undefined,
      maximum: undefined,
      exclusiveMinimum: undefined,
      exclusiveMaximum: undefined,
      note: undefined,
      isReference: false,
      objectList: undefined,
    });
    expect(field(material, 'thickness').exclusiveMinimum).toBe(0);
    expect(field(material, 'thickness').units).toBe('m');
  });

  it('reports integer fields and their bounds', () => {
    const zone = describeObjectType(v26, 'Zone');
    const type = field(zone, 'type');

    expect(type.fieldType).toBe('integer');
    expect(type.default).toBe(1);
    expect(type.minimum).toBe(1);
    expect(type.maximum).toBe(1);
  });

  it('reports object_list as a reference', () => {
    const construction = field(
      describeObjectType(v26, 'BuildingSurface:Detailed'),
      'construction_name'
    );

    expect(construction.isReference).toBe(true);
    expect(construction.objectList).toEqual(['ConstructionNames']);
  });

  it('hands out copies, not the frozen schema arrays', () => {
    const a = field(describeObjectType(v26, 'Material'), 'roughness').enumValues;
    const b = field(describeObjectType(v26, 'Material'), 'roughness').enumValues;

    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe('metadata the slim schema does not carry', () => {
  it('reports memo and note as absent rather than inventing them', () => {
    // Python fills memo for 845 of 858 types and note for 6212 of 12712 fields,
    // both from keys the slim bundle drops on purpose (see @idfkit/schemas'
    // types.ts header). The members stay in the type — the naming register
    // requires the same field set on both sides — but nothing here fabricates a
    // value from the type or field name.
    const zone = describeObjectType(v26, 'Zone');

    expect(zone.memo).toBeUndefined();
    expect(zone.fields.every((f) => f.note === undefined)).toBe(true);
  });

  it('drops the empty-string choice that Python keeps', () => {
    // The bundle filters "" out of every enum. Python keeps it: 1378 of its
    // 2293 enum-bearing fields in 26.1.0 include "". Not recoverable here.
    const compact = field(describeObjectType(v26, 'Zone'), 'part_of_total_floor_area');

    expect(compact.enumValues).toEqual(['No', 'Yes']);
  });

  it('has no enum for an autosizable field, where Python reports the branch enum', () => {
    // Python's `enum_values` falls through to the first anyOf branch carrying an
    // enum, which for these fields is ["", "Autocalculate"] or ["", "Autosize"].
    // The bundle keeps only the numeric branch, so the choice list is gone; the
    // `auto` flag says the field is autosizable but not which literal it takes.
    expect(field(describeObjectType(v26, 'Zone'), 'ceiling_height').enumValues).toBeUndefined();
  });
});

describe('anonymous types', () => {
  it('reproduces the positional first-field drop for anonymous types', () => {
    // Python's `get_field_names` returns `legacy_idd.fields[1:]`, assuming the
    // first entry is always the name. For the 154 anonymous types in 26.1.0 it
    // is not, so a real field disappears: GlobalGeometryRules loses
    // `starting_vertex_position`, which its own `required` list still names.
    // Reproduced deliberately, so the two libraries agree; the fix belongs in
    // Python.
    const rules = describeObjectType(v26, 'GlobalGeometryRules');

    expect(rules.hasName).toBe(false);
    expect(rules.fields.map((f) => f.name)).toEqual([
      'vertex_entry_direction',
      'coordinate_system',
      'daylighting_reference_point_coordinate_system',
      'rectangular_surface_coordinate_system',
    ]);
    expect(rules.requiredFields).toContain('starting_vertex_position');
    expect(rules.fields.map((f) => f.name)).not.toContain('starting_vertex_position');
  });

  it('falls back to property order when the drop empties the list', () => {
    // Version's legacy_idd.fields is a single entry, so `[1:]` is empty and both
    // sides recover the field from the property map.
    const version = describeObjectType(v26, 'Version');

    expect(version.hasName).toBe(false);
    expect(version.fields.map((f) => f.name)).toEqual(['version_identifier']);
  });
});

describe('purity', () => {
  it('returns a fresh description each call and never mutates the schema', () => {
    const first = describeObjectType(v26, 'Zone');
    const second = describeObjectType(v26, 'Zone');

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.fields[0]).not.toBe(second.fields[0]);
  });
});
