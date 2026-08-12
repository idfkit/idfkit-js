import { beforeAll, describe, expect, it } from 'vitest';

import { IDFDocument, parseIdf, writeIdf } from '@idfkit/core';
import type { Schema } from '@idfkit/schemas';

import { schema } from './helpers.js';

let v26: Schema;
let v94: Schema;
beforeAll(async () => {
  v26 = await schema('26.1.0');
  v94 = await schema('9.4.0');
});

/**
 * Each of these was found by round-tripping the EnergyPlus example set, not by
 * writing a test first. They are the cases hand-written fixtures do not reach.
 */
describe('regressions', () => {
  it('keeps positional alignment when unset fields precede an extensible group', () => {
    // Branch has an optional pressure_drop_curve_name between the name and the
    // component list. Trimming it as a trailing empty shifted every component
    // field one slot left, silently corrupting the HVAC topology.
    const text = `
Version, 26.1;
Branch,
  Main Branch,
  ,
  AirLoopHVAC:OutdoorAirSystem, OA System, Supply Inlet, Fan Inlet,
  Fan:ConstantVolume, Supply Fan, Fan Inlet, Supply Outlet;
`;
    const { document } = parseIdf(text, v26, { strict: false });
    const branch = document.require('Branch', 'Main Branch');

    expect(branch.extensible[0]).toEqual({
      component_object_type: 'AirLoopHVAC:OutdoorAirSystem',
      component_name: 'OA System',
      component_inlet_node_name: 'Supply Inlet',
      component_outlet_node_name: 'Fan Inlet',
    });

    const reparsed = parseIdf(writeIdf(document), v26, { strict: false }).document;
    expect(reparsed.toJSON()).toEqual(document.toJSON());
    expect(
      reparsed.require('Branch', 'Main Branch').get('pressure_drop_curve_name')
    ).toBeUndefined();
  });

  it('accepts a blank name where the schema allows one', () => {
    // WeatherProperty:SkyTemperature omits its name to mean "all run periods".
    // A blank name is not the same as having no name field: the slot still has
    // to be written back out.
    const text = `
Version, 26.1;
WeatherProperty:SkyTemperature,
  ,                  !- Name
  ScheduleValue,     !- Calculation Type
  ConstantSchedule5; !- Schedule Name
`;
    const { document, diagnostics } = parseIdf(text, v26, { strict: false });
    expect(diagnostics).toEqual([]);

    const obj = document.all('WeatherProperty:SkyTemperature').first;
    expect(obj?.name).toBe('');
    expect(obj?.get('calculation_type')).toBe('ScheduleValue');

    const out = writeIdf(document);
    expect(out).toMatch(/, +!- Name/);
    expect(parseIdf(out, v26, { strict: false }).document.toJSON()).toEqual(document.toJSON());
  });

  it('still rejects a blank name where the schema requires one', () => {
    expect(() => parseIdf('Version, 26.1;\nZone, , 0;', v26)).toThrow(/requires a name/);
  });

  it('allows several blank-named objects of the same type', () => {
    const doc = new IDFDocument(v26);
    doc.add('WeatherProperty:SkyTemperature', '', { calculation_type: 'ScheduleValue' });
    doc.add('WeatherProperty:SkyTemperature', '', { calculation_type: 'ScheduleValue' });
    expect(doc.all('WeatherProperty:SkyTemperature').size).toBe(2);
  });

  it('normalizes negative zero', () => {
    // Real files contain `-0`. JavaScript preserves the sign, so without
    // normalization a value round-trips to a different-but-equal number and
    // every strict comparison downstream reports a phantom diff.
    const { document } = parseIdf('Version, 26.1;\nZone, Z1, -0, -0.0;', v26);
    const zone = document.require('Zone', 'Z1');

    expect(Object.is(zone.get('direction_of_relative_north'), 0)).toBe(true);
    expect(Object.is(zone.get('x_origin'), 0)).toBe(true);
  });

  it('coerces integer fields declared as "type": "integer"', () => {
    // The schema spells integers two ways. Handling only `data_type: integer`
    // left Timestep and friends holding strings.
    const { document } = parseIdf('Version, 26.1;\nTimestep, 6;', v26);
    expect(document.all('Timestep').first?.get('number_of_timesteps_per_hour')).toBe(6);
  });

  it('coerces extensible group values to numbers', () => {
    // The inner field types live on the array's `items` and were dropped by an
    // early version of the schema bundle, leaving every vertex as a string.
    const doc = new IDFDocument(v26);
    const { document } = parseIdf(
      'Version, 26.1;\nBuildingSurface:Detailed, S1, Wall, C1, Z1, , Outdoors, , , , 0.5, 1, 1.5, 2.5, 3.5;',
      v26,
      { strict: false }
    );
    expect(document.require('BuildingSurface:Detailed', 'S1').extensible[0]).toEqual({
      vertex_x_coordinate: 1.5,
      vertex_y_coordinate: 2.5,
      vertex_z_coordinate: 3.5,
    });
    expect(doc.version).toBe('26.1.0');
  });

  it('rewrites references held inside extensible groups on rename', () => {
    // ZoneList, Branch, and the supply/return paths keep every reference in
    // their extensible section. Deriving the reference fields from the fixed
    // field list alone left those edges out of the graph entirely, so a rename
    // rewrote the surfaces and left the lists pointing at a name that no longer
    // existed — a broken model with no diagnostic.
    const { document } = parseIdf(
      'Version, 26.1;\nZone, Z1;\nZoneList, ZL1, Z1;\nZoneList, ZL2, Z1;',
      v26,
      { strict: false }
    );
    const zone = document.require('Zone', 'Z1');

    expect(document.references.referencingObjects('Z1')).toHaveLength(2);
    expect(document.danglingReferences()).toEqual([]);

    document.rename(zone, 'Z9');

    expect(document.require('ZoneList', 'ZL1').extensible[0]).toEqual({ zone_name: 'Z9' });
    expect(document.require('ZoneList', 'ZL2').extensible[0]).toEqual({ zone_name: 'Z9' });
    expect(document.danglingReferences()).toEqual([]);
    expect(writeIdf(document)).not.toMatch(/\bZ1\b/);
  });

  it('keeps a blank extensible repeat in the middle of the section', () => {
    // The section is positional, so dropping an all-blank vertex pulls every
    // later one down a slot: the surface silently loses a vertex and stops
    // matching its own number_of_vertices.
    const { document } = parseIdf(
      'Version, 26.1;\nBuildingSurface:Detailed, S1, Wall, C1, Z1, , Outdoors, , , , 0.5, 4,' +
        ' 0, 0, 3, , , , 10, 0, 0, 10, 0, 3;',
      v26,
      { strict: false }
    );
    const surface = document.require('BuildingSurface:Detailed', 'S1');

    expect(surface.extensible).toHaveLength(4);
    expect(surface.extensible[1]).toEqual({});
    expect(surface.extensible[3]).toEqual({
      vertex_x_coordinate: 10,
      vertex_y_coordinate: 0,
      vertex_z_coordinate: 3,
    });

    // Trailing blanks are padding, not data, and are still dropped.
    const { document: padded } = parseIdf(
      'Version, 26.1;\nBuildingSurface:Detailed, S2, Wall, C1, Z1, , Outdoors, , , , 0.5, 1,' +
        ' 0, 0, 3, , , ;',
      v26,
      { strict: false }
    );
    expect(padded.require('BuildingSurface:Detailed', 'S2').extensible).toHaveLength(1);
  });

  it('does not let an anonymous key collide with a real name in epJSON', () => {
    // epJSON has no blank key, so blank-named objects get "<Type> N" — the same
    // name a real object is allowed to have. Minting it blind overwrote the
    // real object and dropped it from the saved model.
    const doc = new IDFDocument(v26);
    doc.add('WeatherProperty:SkyTemperature', 'WeatherProperty:SkyTemperature 1', {
      calculation_type: 'ScheduleValue',
      schedule_name: 'S1',
    });
    doc.add('WeatherProperty:SkyTemperature', '', {
      calculation_type: 'ScheduleValue',
      schedule_name: 'S2',
    });

    const body = doc.toJSON()['WeatherProperty:SkyTemperature']!;
    expect(Object.keys(body)).toHaveLength(2);
    expect(body['WeatherProperty:SkyTemperature 1']?.['schedule_name']).toBe('S1');
    expect(body['WeatherProperty:SkyTemperature 2']?.['schedule_name']).toBe('S2');
  });

  it('does not report field-declared names as dangling', () => {
    // FluidProperties:Name is anonymous: the name others reference lives in a
    // field, not in the object's name slot. Building the valid-name set from
    // names alone flagged every glycol plant loop as broken.
    const { document } = parseIdf(
      'Version, 26.1;\nFluidProperties:Name, MyGlycol, Glycol;\n' +
        'FluidProperties:Temperatures, MyTemps, 0, 10, 20;\n' +
        'FluidProperties:Concentration, MyGlycol, Density, MyTemps, 0.0, 1000, 1000, 1000;',
      v26,
      { strict: false }
    );
    expect(document.danglingReferences()).toEqual([]);
  });

  it('canonicalizes the type name when removing a mis-cased object', () => {
    // IDF type names are case-insensitive and files in the wild use ZONE. The
    // object is filed under the schema's spelling, so looking it up by the raw
    // name reported it absent and left it in the saved file.
    const doc = new IDFDocument(v26);
    const zone = doc.addRaw('ZONE', 'Z1');

    expect(doc.size).toBe(1);
    expect(doc.remove(zone)).toBe(true);
    expect(doc.size).toBe(0);
  });

  it('keeps name and key together when a detached object is renamed', () => {
    const doc = new IDFDocument(v26);
    const zone = doc.add('Zone', 'Z1');

    doc.remove(zone);
    zone.name = 'Z2';
    doc.attach(zone);

    expect(doc.get('Zone', 'Z2')).toBe(zone);
    expect(doc.get('Zone', 'Z1')).toBeUndefined();
  });

  it('refuses renames that would corrupt another document or destroy references', () => {
    const doc = new IDFDocument(v26);
    const other = new IDFDocument(v26);
    const zone = doc.add('Zone', 'Z1');
    doc.add('Lights', 'L1', { zone_or_zonelist_or_space_or_spacelist_name: 'Z1' });

    expect(() => other.rename(zone, 'Z2')).toThrow(/does not belong to this document/);
    expect(() => doc.rename(zone, '')).toThrow(/Cannot blank the name/);

    expect(doc.get('Zone', 'Z1')).toBe(zone);
    expect(doc.require('Lights', 'L1').get('zone_or_zonelist_or_space_or_spacelist_name')).toBe(
      'Z1'
    );
  });

  it('applies the singleton and version guards to attach(), not just add()', () => {
    const doc = new IDFDocument(v26);
    const building = doc.add('Building', 'B1');

    expect(() => doc.attach(building.clone('B2'))).toThrow(/singleton/);
    expect(doc.all('Building').size).toBe(1);
  });

  it('refuses to attach a clone whose field layout belongs to another version', () => {
    // An object carries its own definition, so writing one built against 9.4
    // into a 26.1 document emits 9.4's field order under a `Version, 26.1;`
    // header: every field mis-maps on reload rather than failing. Types whose
    // definition is unchanged between the two versions are the same frozen
    // object and stay attachable, which is the point of content addressing.
    const older = new IDFDocument(v94);
    const layoutChanged = v26
      .changedFrom(v94)
      .changed.find(
        (type) => JSON.stringify(v26.require(type).f) !== JSON.stringify(v94.require(type).f)
      );
    expect(layoutChanged).toBeDefined();

    const stale = older.addRaw(layoutChanged!, 'X1').clone('X2');
    expect(() => new IDFDocument(v26).attach(stale)).toThrow(/different schema/);

    // Same type name, identical definition across versions: allowed.
    const zone = new IDFDocument(v94).add('Zone', 'Z1');
    expect(() => new IDFDocument(v26).attach(zone.clone('Z2'))).not.toThrow();
  });
});
