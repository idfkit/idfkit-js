import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { IdfDocument, IdfObject, parseIdf } from '@idfkit/core';
import type { Schema } from '@idfkit/schemas';

import { DATA } from '../src/internal.js';
import { Severity, validateDocument, validateObject } from '../src/validate/index.js';
import type { ValidationError } from '../src/validate/index.js';

import { schema, syntaxFixtures } from './helpers.js';

let v26: Schema;
let v94: Schema;
beforeAll(async () => {
  [v26, v94] = await Promise.all([schema('26.1.0'), schema('9.4.0')]);
});

let doc: IdfDocument;
beforeEach(() => {
  doc = new IdfDocument(v26);
});

/** Codes only. Messages differ between the two languages; codes do not. */
const codes = (findings: readonly ValidationError[]): string[] => findings.map((f) => f.code);

/**
 * Fields of the E009 findings a document produces, in order.
 *
 * The reference tests build partial objects, so the run also reports missing
 * required fields; only the dangling-reference findings are of interest.
 */
const danglingFields = (document: IdfDocument): (string | undefined)[] =>
  validateDocument(document)
    .errors.filter((f) => f.code === 'E009')
    .map((f) => f.field);

/** A schema-valid Material, so a test can perturb one field at a time. */
const MATERIAL = {
  roughness: 'Rough',
  thickness: 0.1,
  conductivity: 0.5,
  density: 800,
  specific_heat: 900,
} as const;

describe('Severity', () => {
  it('renders the three wire strings the corpus compares on', () => {
    expect([Severity.ERROR, Severity.WARNING, Severity.INFO]).toEqual(['error', 'warning', 'info']);
  });
});

describe('required fields (E001)', () => {
  it('reports every required field that is absent', () => {
    const material = doc.add('Material', 'M1');
    const findings = validateObject(material, v26);

    expect(codes(findings)).toEqual(['E001', 'E001', 'E001', 'E001', 'E001']);
    expect(findings.map((f) => f.field)).toEqual([
      'roughness',
      'thickness',
      'conductivity',
      'density',
      'specific_heat',
    ]);
    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.objType).toBe('Material');
    expect(findings[0]?.objName).toBe('M1');
    expect(findings[0]?.message).toBe("Required field 'roughness' is missing");
  });

  it('treats a blank value as missing', () => {
    const material = doc.add('Material', 'M1', { ...MATERIAL, roughness: '' });
    expect(codes(validateObject(material, v26))).toEqual(['E001']);
  });

  it('is silent when every required field is present', () => {
    const material = doc.add('Material', 'M1', MATERIAL);
    expect(validateObject(material, v26)).toEqual([]);
  });

  it('can be switched off', () => {
    const material = doc.add('Material', 'M1');
    expect(validateObject(material, v26, { checkRequired: false })).toEqual([]);
  });
});

describe('field types (E003)', () => {
  it('reports a string in a numeric field', () => {
    const zone = doc.add('Zone', 'Z1');
    zone.set('multiplier', 'lots');

    const findings = validateObject(zone, v26);
    expect(codes(findings)).toEqual(['E003']);
    expect(findings[0]?.message).toBe('Expected integer, got string');
  });

  it('reports a fractional value in an integer field', () => {
    const zone = doc.add('Zone', 'Z1');
    zone.set('multiplier', 2.5);
    expect(codes(validateObject(zone, v26))).toEqual(['E003']);
  });

  it('accepts a whole number in an integer field', () => {
    const zone = doc.add('Zone', 'Z1', { multiplier: 3 });
    expect(validateObject(zone, v26)).toEqual([]);
  });

  it('reports a number in an alpha field once, not twice', () => {
    // One finding per field: the value is the wrong type AND outside the choice
    // list, which is one defect described two ways. Type wins, being the more
    // fundamental of the two.
    const zone = doc.add('Zone', 'Z1');
    zone.set('part_of_total_floor_area', 3);
    expect(codes(validateObject(zone, v26))).toEqual(['E003']);
  });

  it('still reports the range when the type check is switched off', () => {
    // The two switches gate two independent checks, and dropping to one finding
    // per field did not merge them: `checkTypes: false` skips type and enum, and
    // the bounds are still read.
    const zone = doc.add('Zone', 'Z1', { multiplier: 0 });
    expect(codes(validateObject(zone, v26, { checkTypes: false }))).toEqual(['E005']);
  });

  it('accepts the extensible array in its own field', () => {
    const surface = doc.add('BuildingSurface:Detailed', 'S1', {
      surface_type: 'Wall',
      construction_name: 'C1',
      zone_name: 'Z1',
      outside_boundary_condition: 'Outdoors',
      vertices: [{ vertex_x_coordinate: 0, vertex_y_coordinate: 0, vertex_z_coordinate: 0 }],
    });
    expect(validateObject(surface, v26)).toEqual([]);
  });

  it('reports a string where the extensible array belongs', () => {
    const surface = doc.add('BuildingSurface:Detailed', 'S1', {
      surface_type: 'Wall',
      construction_name: 'C1',
      zone_name: 'Z1',
      outside_boundary_condition: 'Outdoors',
    });
    surface.set('vertices', 'nope');

    const findings = validateObject(surface, v26);
    expect(codes(findings)).toEqual(['E003']);
    expect(findings[0]?.message).toBe('Expected array, got string');
  });

  it('can be switched off', () => {
    const zone = doc.add('Zone', 'Z1');
    zone.set('multiplier', 'lots');
    expect(validateObject(zone, v26, { checkTypes: false })).toEqual([]);
  });
});

describe('choice fields (E004)', () => {
  it('reports a value outside the allowed set', () => {
    const material = doc.add('Material', 'M1', { ...MATERIAL, roughness: 'Bogus' });

    const findings = validateObject(material, v26);
    expect(codes(findings)).toEqual(['E004']);
    expect(findings[0]?.message).toBe(
      "Value 'Bogus' not in allowed values: ['MediumRough', 'MediumSmooth', 'Rough', 'Smooth', 'VeryRough', 'VerySmooth']"
    );
  });

  it('accepts a differently cased choice, as EnergyPlus does', () => {
    const material = doc.add('Material', 'M1', { ...MATERIAL, roughness: 'rough' });
    expect(validateObject(material, v26)).toEqual([]);
  });
});

describe('numeric ranges (E005 to E008)', () => {
  it('reports a value below an inclusive minimum', () => {
    const zone = doc.add('Zone', 'Z1', { multiplier: 0 });

    const findings = validateObject(zone, v26);
    expect(codes(findings)).toEqual(['E005']);
    expect(findings[0]?.message).toBe('Value 0 is below minimum 1');
  });

  it('reports a value above an inclusive maximum', () => {
    const zone = doc.add('Zone', 'Z1', { type: 5 });
    expect(codes(validateObject(zone, v26))).toEqual(['E007']);
  });

  it('accepts a value sitting exactly on an inclusive bound', () => {
    const material = doc.add('Material', 'M1', { ...MATERIAL, thermal_absorptance: 0.99999 });
    expect(validateObject(material, v26)).toEqual([]);
  });

  it('reports a value on an exclusive minimum', () => {
    const material = doc.add('Material', 'M1', { ...MATERIAL, thickness: 0 });

    const findings = validateObject(material, v26);
    expect(codes(findings)).toEqual(['E006']);
    expect(findings[0]?.message).toBe('Value 0 must be greater than 0');
  });

  it('reports a value on an exclusive maximum', () => {
    const airflow = doc.add('AirflowNetwork:MultiZone:Zone', 'AZ1', {
      zone_name: 'Z1',
      indoor_and_outdoor_temperature_difference_lower_limit_for_maximum_venting_open_factor: 100,
    });

    const findings = validateObject(airflow, v26);
    expect(codes(findings)).toEqual(['E008']);
    expect(findings[0]?.message).toBe('Value 100 must be less than 100');
  });

  it('reports below-minimum and on-exclusive-maximum from the same field schema', () => {
    const airflow = doc.add('AirflowNetwork:MultiZone:Zone', 'AZ1', {
      zone_name: 'Z1',
      indoor_and_outdoor_temperature_difference_lower_limit_for_maximum_venting_open_factor: -1,
    });
    expect(codes(validateObject(airflow, v26))).toEqual(['E005']);
  });

  it('can be switched off', () => {
    const zone = doc.add('Zone', 'Z1', { multiplier: 0 });
    expect(validateObject(zone, v26, { checkRanges: false })).toEqual([]);
  });

  // 8.9.0 through 9.5.0 ship draft-04 schemas, where `exclusiveMinimum` is the
  // boolean `true` qualifying a sibling `minimum` rather than a bound of its
  // own. Reading the flag as a number would treat it as 1 and reject every
  // thickness at or below 1 m.
  it('reads the draft-04 exclusive flag on 9.4.0', () => {
    const old = new IdfDocument(v94);
    const zero = old.add('Material', 'M1', { ...MATERIAL, thickness: 0 });

    const findings = validateObject(zero, v94);
    expect(codes(findings)).toEqual(['E006']);
    expect(findings[0]?.message).toBe('Value 0 must be greater than 0');
  });

  it('does not trip on a draft-04 value above the exclusive bound', () => {
    const old = new IdfDocument(v94);
    const one = old.add('Material', 'M2', { ...MATERIAL, thickness: 1 });
    expect(validateObject(one, v94)).toEqual([]);
  });
});

// The epJSON schema declares 13060 fields across the 17 bundled versions as
// `anyOf: [{number}, {string}]`, and this is ordinary JSON Schema `anyOf`: the
// value is valid when it satisfies ONE branch completely, type and enum and
// bounds together. Both libraries used to check the type against one branch and
// the constraints against another, which accepted values EnergyPlus rejects.
// The shared rule is `validation-semantics.md`; these tests are its cases.
describe('anyOf fields: a number, or a string the branch allows', () => {
  it('accepts the sentinel this field actually declares', () => {
    const zone = doc.add('Zone', 'Z1', { ceiling_height: 'Autocalculate' });
    expect(validateObject(zone, v26)).toEqual([]);
  });

  it('rejects the other sentinel, which this field does not take (E004)', () => {
    // `Zone.ceiling_height` is one of the 1781 fields whose string branch is
    // `Autocalculate`. Accepting `Autosize` as well, which is what a validator
    // that assumes one sentinel does, passes a file EnergyPlus refuses.
    const zone = doc.add('Zone', 'Z1', { ceiling_height: 'Autosize' });

    const findings = validateObject(zone, v26);
    expect(codes(findings)).toEqual(['E004']);
    expect(findings[0]?.message).toBe(
      "Value 'Autosize' not in allowed values: ['', 'Autocalculate']"
    );
  });

  it('accepts a number in the same field', () => {
    const zone = doc.add('Zone', 'Z1', { ceiling_height: 2.7 });
    expect(validateObject(zone, v26)).toEqual([]);
  });

  it('reports a string the branch enum does not list as E004, not E002', () => {
    // The string branch matches on TYPE, so this is not "matches no branch". It
    // is a value that branch's enum refuses, and saying so is the difference
    // between a useful diagnostic and telling the user their string is not a
    // string.
    const zone = doc.add('Zone', 'Z1', { ceiling_height: 'Bogus' });
    expect(codes(validateObject(zone, v26))).toEqual(['E004']);
  });

  it('accepts any string where the string branch declares no enum', () => {
    // 646 fields put no enum on the string branch at all: the slot holds either
    // a number or the name of a tariff variable, and both are legal.
    const block = doc.add('UtilityCost:Charge:Block', 'B1', {
      block_1_cost_per_unit_value_or_variable_name: 'EnergyCharges',
    });
    expect(validateObject(block, v26, { checkRequired: false })).toEqual([]);
  });

  it('range checks the numeric branch above its maximum (E007)', () => {
    // The bounds live inside the anyOf, which is why neither library used to
    // read them. `view_factor_to_ground` is declared `maximum: 1`.
    const surface = doc.add('BuildingSurface:Detailed', 'S1', {
      surface_type: 'Wall',
      construction_name: 'C1',
      zone_name: 'Z1',
      outside_boundary_condition: 'Outdoors',
      view_factor_to_ground: 5,
    });

    const findings = validateObject(surface, v26);
    expect(codes(findings)).toEqual(['E007']);
    expect(findings[0]?.message).toBe('Value 5 is above maximum 1');
  });

  it('range checks the numeric branch below its minimum (E005)', () => {
    const sizing = doc.add('DesignSpecification:ZoneHVAC:Sizing', 'DS1', {
      cooling_design_capacity: -1,
    });
    expect(codes(validateObject(sizing, v26, { checkRequired: false }))).toEqual(['E005']);
  });

  it('reads the draft-04 exclusive flag on the numeric branch', () => {
    // 9.4.0 ships draft-04, where `exclusiveMinimum` is the boolean `true`
    // qualifying `minimum`. Comparing a value against `true` would silently
    // compare it against 1 and reject every beam shorter than a metre.
    const old = new IdfDocument(v94);
    const beam = old.add('AirTerminal:SingleDuct:ConstantVolume:CooledBeam', 'CB1', {
      beam_length: 0,
    });
    const short = old.add('AirTerminal:SingleDuct:ConstantVolume:CooledBeam', 'CB2', {
      beam_length: 0.5,
    });

    expect(codes(validateObject(beam, v94, { checkRequired: false }))).toEqual(['E006']);
    expect(validateObject(short, v94, { checkRequired: false })).toEqual([]);
  });

  it('enforces a numeric enum declared on the number branch (E004)', () => {
    // 68 fields state their choices as numbers. `4` is not one of 0, 1, 2, 3, 5.
    const screen = doc.add('WindowMaterial:Screen', 'SC1', {
      angle_of_resolution_for_screen_transmittance_output_map: 4,
    });

    const findings = validateObject(screen, v26, { checkRequired: false });
    expect(codes(findings)).toEqual(['E004']);
    expect(findings[0]?.message).toBe("Value '4' not in allowed values: ['0', '1', '2', '3', '5']");
  });

  it('accepts a member of that numeric enum', () => {
    const screen = doc.add('WindowMaterial:Screen', 'SC1', {
      angle_of_resolution_for_screen_transmittance_output_map: 5,
    });
    expect(validateObject(screen, v26, { checkRequired: false })).toEqual([]);
  });

  it('reports a value that matches no branch on type (E002)', () => {
    const zone = doc.add('Zone', 'Z1');
    zone.set('ceiling_height', [{ vertex_x_coordinate: 1 }]);

    const findings = validateObject(zone, v26);
    expect(codes(findings)).toEqual(['E002']);
    expect(findings[0]?.message).toContain('does not match any valid type');
  });

  it('emits one finding for a field, never one per branch', () => {
    // 'Autosize' fails the string branch's enum and is not a number at all. One
    // finding, from the first branch the value matched on type.
    const zone = doc.add('Zone', 'Z1', { ceiling_height: 'Autosize', volume: 'Autosize' });
    expect(codes(validateObject(zone, v26))).toEqual(['E004', 'E004']);
  });

  it('reports the enum failure under checkTypes and the bound under checkRanges', () => {
    // One evaluation answers both questions, so which switch silences a finding
    // depends on what the finding turned out to be.
    const zone = doc.add('Zone', 'Z1', { ceiling_height: 'Autosize' });
    expect(validateObject(zone, v26, { checkTypes: false })).toEqual([]);
    expect(codes(validateObject(zone, v26, { checkRanges: false }))).toEqual(['E004']);

    const surface = doc.add('BuildingSurface:Detailed', 'S1', {
      surface_type: 'Wall',
      construction_name: 'C1',
      zone_name: 'Z1',
      outside_boundary_condition: 'Outdoors',
      view_factor_to_ground: 5,
    });
    expect(validateObject(surface, v26, { checkRanges: false })).toEqual([]);
    expect(codes(validateObject(surface, v26, { checkTypes: false }))).toEqual(['E007']);
  });
});

describe('unknown type and unknown field (W002, W003)', () => {
  it('warns about an object type the schema does not define', () => {
    // Built against Zone's layout but labelled with a type name 26.1.0 has
    // never heard of, which is what a cross-version check runs into.
    const alien = IdfObject.create('NotAThing', v26.require('Zone'), 'X');

    const findings = validateObject(alien, v26);
    expect(codes(findings)).toEqual(['W002']);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.field).toBeUndefined();
    expect(findings[0]?.message).toBe("Unknown object type 'NotAThing'");
  });

  it('warns about a field the schema does not define', () => {
    const zone = doc.add('Zone', 'Z1');
    // Unreachable through the public API: `create` and `set` both reject an
    // unrecognized field name. Written straight into the backing store so the
    // branch that mirrors the Python original is actually exercised.
    zone[DATA]['bogus'] = 3;

    const findings = validateObject(zone, v26);
    expect(codes(findings)).toEqual(['W003']);
    expect(findings[0]?.message).toBe("Unknown field 'bogus'");
  });

  it('stays quiet on an extensible type, where the field may be a repeat', () => {
    const surface = doc.add('BuildingSurface:Detailed', 'S1', {
      surface_type: 'Wall',
      construction_name: 'C1',
      zone_name: 'Z1',
      outside_boundary_condition: 'Outdoors',
    });
    surface[DATA]['bogus'] = 3;
    expect(validateObject(surface, v26)).toEqual([]);
  });

  it('can be switched off', () => {
    const zone = doc.add('Zone', 'Z1');
    zone[DATA]['bogus'] = 3;
    expect(validateObject(zone, v26, { checkUnknown: false })).toEqual([]);
  });
});

describe('validateDocument', () => {
  it('passes a small well-formed model', () => {
    const { document } = parseIdf(
      `
      Version, 26.1;
      Zone, Z1, 0, 0,0,0, 1, 1, 2.7;
      Material, M1, Rough, 0.1, 0.5, 800, 900;
      Construction, C1, M1;
      BuildingSurface:Detailed, S1, Wall, C1, Z1, , Outdoors, , SunExposed, WindExposed, 0.5, 4,
        0,0,0, 1,0,0, 1,0,1, 0,0,1;
      `,
      v26
    );

    const result = validateDocument(document);
    expect(result.errors).toEqual([]);
    expect(result.isValid).toBe(true);
    expect(result.totalIssues).toBe(0);
  });

  it('reports a reference to an object that does not exist (E009)', () => {
    const { document } = parseIdf(
      `
      Version, 26.1;
      Material, M1, Rough, 0.1, 0.5, 800, 900;
      Construction, C1, M_MISSING;
      `,
      v26
    );

    const result = validateDocument(document);
    expect(codes(result.errors)).toEqual(['E009']);
    expect(result.errors[0]?.objType).toBe('Construction');
    expect(result.errors[0]?.objName).toBe('C1');
    expect(result.errors[0]?.field).toBe('outside_layer');
    expect(result.errors[0]?.message).toBe("Reference to non-existent object 'M_MISSING'");
    expect(result.isValid).toBe(false);
  });

  it('does not report a field naming an object TYPE as dangling', () => {
    // `Branch.component_object_type` points into `validBranchEquipmentTypes`,
    // one of the four lists in 26.1.0 that nothing contributes to: they hold
    // object type names, not object names. `Pipe:Adiabatic` is the correct value
    // and no object will ever declare it. `component_name` beside it is a real
    // reference and is still reported.
    const { document } = parseIdf(
      `
      Version, 26.1;
      Branch, B1, , Pipe:Adiabatic, MISSING PIPE, N1, N2;
      `,
      v26
    );

    const result = validateDocument(document);
    expect(codes(result.errors)).toEqual(['E009']);
    expect(result.errors[0]?.field).toBe('component_name');
    expect(result.errors[0]?.message).toBe("Reference to non-existent object 'MISSING PIPE'");
  });

  it('accepts a ZoneList-expanded name (E009)', () => {
    // EnergyPlus expands an object assigned to a ZoneList into one instance per
    // member, named `<member name><space><object name>`, and other objects
    // reference those. `5ZoneEndUses.idf` does exactly this.
    doc.add('Zone', 'SPACE3-1');
    doc.add('ZoneControl:Thermostat', 'AllControlledZones Thermostat');
    doc.add('ZoneControl:Thermostat:OperativeTemperature', null, {
      thermostat_name: 'SPACE3-1 AllControlledZones Thermostat',
    });

    expect(danglingFields(doc)).toEqual([]);
  });

  it('splits an expanded name at every space, not only the first', () => {
    // Zone names and object names both routinely contain spaces, so the split
    // that resolves is the third one here, not the first.
    doc.add('Zone', 'ZONE 1');
    doc.add('ZoneControl:Thermostat', 'AllZones Thermostat');
    doc.add('ZoneControl:Thermostat:OperativeTemperature', null, {
      thermostat_name: 'ZONE 1 AllZones Thermostat',
    });

    expect(danglingFields(doc)).toEqual([]);
  });

  it('accepts a Space name as the expansion prefix', () => {
    doc.add('Zone', 'Zone 5');
    doc.add('Space', 'Space 5 Office', { zone_name: 'Zone 5' });
    doc.add('ZoneControl:Thermostat', 'AllZones Thermostat');
    doc.add('ZoneControl:Thermostat:OperativeTemperature', null, {
      thermostat_name: 'Space 5 Office AllZones Thermostat',
    });

    expect(danglingFields(doc)).toEqual([]);
  });

  it('matches the two halves of an expanded name case-insensitively', () => {
    doc.add('Zone', 'SPACE3-1');
    doc.add('ZoneControl:Thermostat', 'AllControlledZones Thermostat');
    doc.add('ZoneControl:Thermostat:OperativeTemperature', null, {
      thermostat_name: 'space3-1 allcontrolledzones THERMOSTAT',
    });

    expect(danglingFields(doc)).toEqual([]);
  });

  it('still reports a name with spaces whose prefix is no zone', () => {
    doc.add('Zone', 'SPACE3-1');
    doc.add('ZoneControl:Thermostat', 'AllControlledZones Thermostat');
    doc.add('ZoneControl:Thermostat:OperativeTemperature', null, {
      thermostat_name: 'SPACE9-9 AllControlledZones Thermostat',
    });

    expect(danglingFields(doc)).toEqual(['thermostat_name']);
  });

  it('still reports a name whose prefix is a zone but whose suffix is undeclared', () => {
    doc.add('Zone', 'SPACE3-1');
    doc.add('ZoneControl:Thermostat', 'AllControlledZones Thermostat');
    doc.add('ZoneControl:Thermostat:OperativeTemperature', null, {
      thermostat_name: 'SPACE3-1 Some Other Thermostat',
    });

    expect(danglingFields(doc)).toEqual(['thermostat_name']);
  });

  it('does not treat a zone name alone as an expansion', () => {
    // No suffix to resolve: `<zone name>` on its own is still dangling.
    doc.add('Zone', 'SPACE3-1');
    doc.add('ZoneControl:Thermostat:OperativeTemperature', null, {
      thermostat_name: 'SPACE3-1 ',
    });

    expect(danglingFields(doc)).toEqual(['thermostat_name']);
  });

  it('accepts the implicit remainder space of a declared zone (E009)', () => {
    // A zone whose Spaces cover only part of it gets one more space from
    // EnergyPlus named `<Zone Name>-Remainder`, which nothing declares.
    // `5ZoneAirCooledWithSpacesHVAC.idf` references `Zone 5-Remainder` twelve
    // times.
    doc.add('Zone', 'Zone 5');
    doc.add('Space', 'Space 5 Office', { zone_name: 'Zone 5' });
    doc.add('Space', 'Space 5 Conference', { zone_name: 'Zone 5' });
    doc.add('SpaceHVAC:EquipmentConnections', null, { space_name: 'Zone 5-Remainder' });

    expect(danglingFields(doc)).toEqual([]);
  });

  it('matches a remainder name case-insensitively', () => {
    doc.add('Zone', 'Zone 5');
    doc.add('SpaceHVAC:EquipmentConnections', null, { space_name: 'ZONE 5-REMAINDER' });

    expect(danglingFields(doc)).toEqual([]);
  });

  it('still reports a remainder name whose prefix is no declared zone', () => {
    // `Space 5 Office` is a Space, not a Zone, and only a Zone gets a
    // remainder. `Zone 9` is declared nowhere at all.
    doc.add('Zone', 'Zone 5');
    doc.add('Space', 'Space 5 Office', { zone_name: 'Zone 5' });
    doc.add('SpaceHVAC:EquipmentConnections', null, {
      space_name: 'Space 5 Office-Remainder',
    });
    doc.add('SpaceHVAC:EquipmentConnections', null, { space_name: 'Zone 9-Remainder' });

    expect(danglingFields(doc)).toEqual(['space_name', 'space_name']);
  });

  it('does not treat the bare suffix as a remainder name', () => {
    doc.add('Zone', 'Zone 5');
    doc.add('SpaceHVAC:EquipmentConnections', null, { space_name: '-Remainder' });

    expect(danglingFields(doc)).toEqual(['space_name']);
  });

  it('reports a name a declared zone merely starts, without the suffix', () => {
    doc.add('Zone', 'Zone 5');
    doc.add('SpaceHVAC:EquipmentConnections', null, { space_name: 'Zone 5-Remaining' });

    expect(danglingFields(doc)).toEqual(['space_name']);
  });

  it('can skip the reference check', () => {
    const { document } = parseIdf(`Version, 26.1;\nConstruction, C1, M_MISSING;`, v26);
    expect(validateDocument(document, { checkReferences: false }).isValid).toBe(true);
  });

  it('sorts findings into errors, warnings and info', () => {
    doc.add('Material', 'M1');
    const zone = doc.add('Zone', 'Z1');
    zone[DATA]['bogus'] = 3;

    const result = validateDocument(doc);
    expect(codes(result.errors)).toEqual(['E001', 'E001', 'E001', 'E001', 'E001']);
    expect(codes(result.warnings)).toEqual(['W003']);
    expect(result.info).toEqual([]);
    expect(result.totalIssues).toBe(6);
    expect(result.isValid).toBe(false);
  });

  it('restricts the run to the requested object types', () => {
    doc.add('Material', 'M1');
    doc.add('Zone', 'Z1', { multiplier: 0 });

    expect(codes(validateDocument(doc, { objectTypes: ['Zone'] }).errors)).toEqual(['E005']);
    expect(codes(validateDocument(doc, { objectTypes: ['material'] }).errors)).toEqual(
      Array<string>(5).fill('E001')
    );
    expect(validateDocument(doc, { objectTypes: ['Construction'] }).totalIssues).toBe(0);
  });

  it('does not create empty collections for types it is asked about', () => {
    doc.add('Zone', 'Z1');
    validateDocument(doc, { objectTypes: ['Construction', 'Material'] });
    expect(doc.types()).toEqual(['Zone']);
  });

  it('reports a singleton present more than once (E010)', () => {
    doc.add('Building', 'B1');
    // The document refuses a second singleton through `add` and `attach`, which
    // is why this reaches past them: the check exists for documents assembled
    // some other way, and for parity with the Python original.
    const second = IdfObject.create('Building', v26.require('Building'), 'B2');
    doc.collection('Building').insert(second);

    const result = validateDocument(doc);
    expect(codes(result.errors)).toEqual(['E010']);
    expect(result.errors[0]?.objName).toBe('B1');
    expect(result.errors[0]?.field).toBeUndefined();
    expect(result.errors[0]?.message).toBe(
      "Singleton type 'Building' has 2 instances (maximum 1 allowed)"
    );
  });

  it('can skip the singleton check', () => {
    doc.add('Building', 'B1');
    doc.collection('Building').insert(IdfObject.create('Building', v26.require('Building'), 'B2'));
    expect(validateDocument(doc, { checkSingletons: false }).isValid).toBe(true);
  });

  it('validates against a schema other than the document own', () => {
    // `Space` arrived after 9.4.0, so an otherwise fine 26.1.0 model is not a
    // 9.4.0 model. The finding is a warning, not an error, exactly as Python
    // grades an unknown type.
    doc.add('Space', 'SP1', { zone_name: 'Z1' });

    const result = validateDocument(doc, { schema: v94, checkReferences: false });
    expect(codes(result.warnings)).toEqual(['W002']);
  });
});

/**
 * FR-014 and FR-015: validating returns what it returned before the language service existed.
 *
 * The companion of the same assertion in `parse.test.ts`, and it is here for the same reason: the
 * conformance corpus compares findings produced by this exact code path, so a finding that gained a
 * field, changed a message, or moved between severities would be a cross-language difference before
 * it was anything else. Positioning happens afterwards and elsewhere; this is what keeps that true.
 */
describe('validating is unchanged by positioning', () => {
  /** Every fixture read then validated, in name order, as text a snapshot can diff line by line. */
  function validateCorpus(): string {
    return syntaxFixtures()
      .map(({ name, text }) => {
        const { document } = parseIdf(text, v26, { strict: false });
        return `--- ${name}\n${JSON.stringify(validateDocument(document), null, 2)}`;
      })
      .join('\n\n');
  }

  it('produces the same findings for every syntax fixture', () => {
    expect(validateCorpus()).toMatchSnapshot();
  });

  it('attaches nothing to a finding, so an existing caller receives exactly what it did', () => {
    // `region` and `precision` belong to a `PositionedFinding`, which `@idfkit/language` builds from
    // this value rather than inside it. Finding either here would mean a validator had been edited.
    const declared = new Set(['severity', 'objType', 'objName', 'field', 'message', 'code']);

    for (const { name, text } of syntaxFixtures()) {
      const { document } = parseIdf(text, v26, { strict: false });
      const result = validateDocument(document);
      for (const finding of [...result.errors, ...result.warnings, ...result.info]) {
        for (const key of Object.keys(finding)) {
          expect(declared.has(key), `${name}.idf carries "${key}" on a ValidationError`).toBe(true);
        }
      }
    }
  });
});
