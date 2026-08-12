import { beforeAll, describe, expect, it } from 'vitest';

import {
  detectEpJsonVersion,
  detectVersion,
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

describe('detectVersion', () => {
  it('reads a two-part version and pads the patch', () => {
    expect(detectVersion('Version, 26.1;')).toBe('26.1.0');
  });

  it('reads a three-part version', () => {
    expect(detectVersion('Version,9.0.1;')).toBe('9.0.1');
  });

  it('is case-insensitive and tolerates a field comment', () => {
    expect(detectVersion('VERSION,\n  24.2;  !- Version Identifier')).toBe('24.2.0');
  });

  it('returns undefined when there is no version object', () => {
    expect(detectVersion('Zone, Z1;')).toBeUndefined();
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
    expect(detectEpJsonVersion(json)).toBe('26.1.0');
  });

  it('rejects unknown fields in strict mode', () => {
    const json = '{"Zone":{"Z1":{"not_a_field":1}}}';
    expect(() => parseEpJson(json, v26)).toThrow(/Unknown field/);
  });

  it('throws a useful error on malformed JSON', () => {
    expect(() => parseEpJson('{not json', v26)).toThrow(/Invalid JSON/);
  });
});
