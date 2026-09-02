import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { IdfDocument, IdfObject, parseIdf } from '@idfkit/core';
import type { Schema } from '@idfkit/schemas';

import { DATA } from '../src/internal.js';
import { Severity, validateDocument, validateObject } from '../src/validate/index.js';
import type { ValidationError } from '../src/validate/index.js';

import { schema } from './helpers.js';

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

  it('reports a number in an alpha field, alongside the enum finding', () => {
    const zone = doc.add('Zone', 'Z1');
    zone.set('part_of_total_floor_area', 3);
    expect(codes(validateObject(zone, v26))).toEqual(['E003', 'E004']);
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

describe('auto-sizable fields', () => {
  it('accepts the Autocalculate keyword in a numeric field', () => {
    const zone = doc.add('Zone', 'Z1', { ceiling_height: 'Autocalculate' });
    expect(validateObject(zone, v26)).toEqual([]);
  });

  it('accepts a number in the same field', () => {
    const zone = doc.add('Zone', 'Z1', { ceiling_height: 2.7 });
    expect(validateObject(zone, v26)).toEqual([]);
  });

  // The Python original decides the string branch of the epJSON `anyOf` on the
  // type alone, so any string passes. Reproduced rather than tightened, so the
  // two libraries agree about the same file.
  it('accepts any string, matching the Python original', () => {
    const zone = doc.add('Zone', 'Z1', { ceiling_height: 'Bogus' });
    expect(validateObject(zone, v26)).toEqual([]);
  });

  // The bundle hoists the bounds out of the `anyOf` and the Python original
  // never reads them, so neither does this port. Documented divergence from
  // the epJSON schema, shared by both libraries.
  it('does not range check, because the bounds live inside the anyOf', () => {
    const surface = doc.add('BuildingSurface:Detailed', 'S1', {
      surface_type: 'Wall',
      construction_name: 'C1',
      zone_name: 'Z1',
      outside_boundary_condition: 'Outdoors',
      view_factor_to_ground: 5,
    });
    expect(validateObject(surface, v26)).toEqual([]);
  });

  it('reports a value that matches no branch (E002)', () => {
    const zone = doc.add('Zone', 'Z1');
    zone.set('ceiling_height', [{ vertex_x_coordinate: 1 }]);

    const findings = validateObject(zone, v26);
    expect(codes(findings)).toEqual(['E002']);
    expect(findings[0]?.message).toContain('does not match any valid type');
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
