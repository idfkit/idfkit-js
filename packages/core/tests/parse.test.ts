import { beforeAll, describe, expect, it } from 'vitest';

import {
  getEpJsonVersion,
  getIdfVersion,
  IdfParseError,
  parseEpJson,
  parseIdf,
  type ParseDiagnostic,
} from '@idfkit/core';
import type { Schema } from '@idfkit/schemas';

import { schema } from './helpers.js';

let v26: Schema;
beforeAll(async () => {
  v26 = await schema('26.1.0');
});

const MINIMAL = `
Version, 26.1;

Zone,
  Zone One,     !- Name
  0,            !- Direction of Relative North
  1.0,          !- X Origin
  2.0,          !- Y Origin
  0.0;          !- Z Origin
`;

describe('getIdfVersion', () => {
  it('reads a two-part version and pads the patch', () => {
    expect(getIdfVersion('Version, 26.1;')).toBe('26.1.0');
  });

  it('reads a three-part version', () => {
    expect(getIdfVersion('Version,9.0.1;')).toBe('9.0.1');
  });

  it('is case-insensitive and tolerates a field comment', () => {
    expect(getIdfVersion('VERSION,\n  24.2;  !- Version Identifier')).toBe('24.2.0');
  });

  it('returns undefined when there is no version object', () => {
    expect(getIdfVersion('Zone, Z1;')).toBeUndefined();
  });
});

describe('parseIdf', () => {
  it('maps positional values onto schema field names', () => {
    const { document } = parseIdf(MINIMAL, v26);
    const zone = document.require('Zone', 'Zone One');

    expect(zone.name).toBe('Zone One');
    expect(zone.get('x_origin')).toBe(1);
    expect(zone.get('y_origin')).toBe(2);
    expect(zone.get('direction_of_relative_north')).toBe(0);
  });

  it('coerces numbers but leaves Autosize alone', () => {
    const text = `
Version, 26.1;
Sizing:Parameters, 1.2, 1.2;
DesignSpecification:OutdoorAir,
  DSOA1, Flow/Person, 0.00944, 0.0, 0.0, 0.0, Autosize;
`;
    const { document } = parseIdf(text, v26, { strict: false });
    const dsoa = document.require('DesignSpecification:OutdoorAir', 'DSOA1');
    expect(dsoa.get('outdoor_air_flow_per_person')).toBe(0.00944);
  });

  it('resolves mis-cased type names', () => {
    const { document } = parseIdf('Version, 26.1;\nZONE, Z1;', v26);
    expect(document.all('Zone').has('Z1')).toBe(true);
  });

  it('reads extensible groups as typed repeats', () => {
    const text = `
Version, 26.1;
BuildingSurface:Detailed,
  Wall1, Wall, C1, Z1, , Outdoors, , SunExposed, WindExposed, 0.5, 4,
  0.0, 0.0, 3.0,
  0.0, 0.0, 0.0,
  5.0, 0.0, 0.0,
  5.0, 0.0, 3.0;
`;
    const { document } = parseIdf(text, v26, { strict: false });
    const surface = document.require('BuildingSurface:Detailed', 'Wall1');

    expect(surface.extensible).toHaveLength(4);
    expect(surface.extensible[0]).toEqual({
      vertex_x_coordinate: 0,
      vertex_y_coordinate: 0,
      vertex_z_coordinate: 3,
    });
    // Numbers, not strings: the writer needs the distinction to format them.
    expect(typeof surface.extensible[2]?.['vertex_x_coordinate']).toBe('number');
  });

  it('throws on an unknown object type in strict mode', () => {
    expect(() => parseIdf('Version, 26.1;\nNotAThing, X;', v26)).toThrow(IdfParseError);
  });

  it('collects diagnostics instead of throwing when strict is false', () => {
    const diagnostics: ParseDiagnostic[] = [];
    const { document } = parseIdf('Version, 26.1;\nNotAThing, X;\nZone, Z1;', v26, {
      strict: false,
      onDiagnostic: (d) => diagnostics.push(d),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.typeName).toBe('NotAThing');
    // Parsing continues past the bad object.
    expect(document.all('Zone').has('Z1')).toBe(true);
  });

  it('reports the line number of a bad object', () => {
    const diagnostics: ParseDiagnostic[] = [];
    parseIdf('Version, 26.1;\n\n\nNotAThing, X;', v26, {
      strict: false,
      onDiagnostic: (d) => diagnostics.push(d),
    });
    expect(diagnostics[0]?.line).toBe(4);
  });

  it('treats anonymous types as unnamed', () => {
    const { document } = parseIdf('Version, 26.1;\nTimestep, 6;', v26);
    const timestep = document.all('Timestep').first;
    expect(timestep?.isNamed).toBe(false);
    expect(timestep?.get('number_of_timesteps_per_hour')).toBe(6);
  });
});

describe('parseEpJson', () => {
  it('round-trips through epJSON', () => {
    const { document } = parseIdf(MINIMAL, v26);
    const json = JSON.stringify(document.toJSON());
    const reparsed = parseEpJson(json, v26).document;

    expect(reparsed.require('Zone', 'Zone One').get('x_origin')).toBe(1);
    expect(reparsed.size).toBe(document.size);
  });

  it('detects the version from epJSON', () => {
    const json = '{"Version":{"Version 1":{"version_identifier":"26.1"}}}';
    expect(getEpJsonVersion(json)).toBe('26.1.0');
  });

  it('rejects unknown fields in strict mode', () => {
    const json = '{"Zone":{"Z1":{"not_a_field":1}}}';
    expect(() => parseEpJson(json, v26)).toThrow(/Unknown field/);
  });

  it('throws a useful error on malformed JSON', () => {
    expect(() => parseEpJson('{not json', v26)).toThrow(/Invalid JSON/);
  });
});

/**
 * Feature 002, US3: what a fatal parse carries, and what it must keep carrying.
 *
 * The record described this gap as one-sided, "Python raises and TypeScript returns". Neither
 * library ever did that: `parseIdf` defaults to `strict: true` and throws, `parse_idf` defaults to
 * `strict_parsing=True` and raises. What actually differed is that this error carried one finding
 * flattened into two fields while Python's carried the whole collection.
 */
describe('feature 002, a fatal parse carries its findings', () => {
  it('throws by default, which it always did', async () => {
    const s = await schema('26.1.0');

    expect(() => parseIdf('Version, 26.1;\nNotARealType, x;\n', s)).toThrow(IdfParseError);
  });

  it('carries the findings as a collection', async () => {
    const s = await schema('26.1.0');

    let error: IdfParseError | undefined;
    try {
      parseIdf('Version, 26.1;\nNotARealType, x;\n', s);
    } catch (caught) {
      error = caught as IdfParseError;
    }

    expect(error).toBeInstanceOf(IdfParseError);
    expect(error?.diagnostics).toHaveLength(1);
    expect(error?.diagnostics[0]?.code).toBe('UnknownObjectType');
    expect(error?.diagnostics[0]?.typeName).toBe('NotARealType');
  });

  it('keeps the flattened accessors resolving to the first finding', async () => {
    const s = await schema('26.1.0');

    let error: IdfParseError | undefined;
    try {
      parseIdf('Version, 26.1;\nNotARealType, x;\n', s);
    } catch (caught) {
      error = caught as IdfParseError;
    }

    // FR-014: `.line` and `.typeName` are what existing callers read, and they still return what
    // they returned before. They are a convenience over `diagnostics[0]`, not a second truth.
    expect(error?.line).toBe(error?.diagnostics[0]?.line);
    expect(error?.typeName).toBe(error?.diagnostics[0]?.typeName);
    expect(error?.message).toContain('NotARealType');
  });

  it('gives every returned finding a code from the shared vocabulary', async () => {
    const s = await schema('26.1.0');

    const result = parseIdf('Version, 26.1;\nNotARealType, x;\nAlsoNotReal, y;\n', s, {
      strict: false,
    });

    // One finding per skip, not one per distinct type name, and each carries a code the corpus
    // can compare. Message text is deliberately not asserted: it is a presentation choice.
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      'UnknownObjectType',
      'UnknownObjectType',
    ]);
    expect(result.diagnostics.map((d) => d.typeName)).toEqual(['NotARealType', 'AlsoNotReal']);
    expect(result.document.has('Version')).toBe(true);
  });
});

/**
 * idfkit-js#36: a value of the wrong kind is reported rather than stored in silence.
 *
 * The shape this catches is a missing semicolon swallowing the object below, which slides that
 * object's type name into a numeric field. The field count still fits, so nothing overflows and no
 * parser notices by counting.
 */
describe('InvalidField diagnostics', () => {
  const SWALLOWED =
    'Version,\n  26.1;\n\nBuilding,\n  Conformance,\n  0,\n  ,\n  ,\n  ,\n  ,\nTimestep,\n  4;\n';

  it('reports the wrong kind of value, at the field rather than the object', async () => {
    const s = await schema('26.1.0');

    const result = parseIdf(SWALLOWED, s, { strict: false });
    const invalid = result.diagnostics.filter((d) => d.code === 'InvalidField');

    // Line 11 is the swallowed `Timestep,`. Line 4 is where Building starts, which would be true
    // and useless: the damage is seven lines further down.
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.line).toBe(11);
    expect(invalid[0]?.typeName).toBe('Building');
  });

  it('does not stop a strict parse', async () => {
    // FR-014. A value of the wrong KIND still leaves a complete document, unlike an unknown type,
    // so this finding is recorded rather than thrown even under `strict`.
    const s = await schema('26.1.0');

    expect(() => parseIdf(SWALLOWED, s)).not.toThrow();
    expect(parseIdf(SWALLOWED, s).diagnostics.some((d) => d.code === 'InvalidField')).toBe(true);
  });

  it('accepts a sizing sentinel in any numeric field', async () => {
    // The check that keeps this diagnostic worth reading. Reading each field's own string branch
    // literally produced 3,775 findings across the 760 EnergyPlus example files of one release,
    // every one against a model EnergyPlus accepts: the schema is narrower than the engine.
    const s = await schema('26.1.0');
    const text =
      'Version,\n  26.1;\n\nPlantLoop,\n  Loop,\n  Water,\n  ,\n  ,\n  ,\n  ,\n  ,\n  ,\n  Autosize;\n';

    const result = parseIdf(text, s, { strict: false });

    expect(result.diagnostics.filter((d) => d.code === 'InvalidField')).toEqual([]);
  });

  it('accepts a sentinel whatever its case', async () => {
    const s = await schema('26.1.0');
    const text =
      'Version,\n  26.1;\n\nPeople,\n  P,\n  Z,\n  Sched,\n  People,\n  1,\n  ,\n  ,\n  AUTOCALCULATE;\n';

    const result = parseIdf(text, s, { strict: false });

    expect(result.diagnostics.filter((d) => d.code === 'InvalidField')).toEqual([]);
  });
});
