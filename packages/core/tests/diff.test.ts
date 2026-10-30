import { beforeAll, describe, expect, it } from 'vitest';

import {
  diffDocuments,
  IncomparableVersionsError,
  parseIdf,
  writeIdf,
  type DocumentDelta,
  type IdfDocument,
  type ObjectDelta,
} from '@idfkit/core';
import type { Schema } from '@idfkit/schemas';

import { schema } from './helpers.js';

let v26: Schema;
let v94: Schema;
beforeAll(async () => {
  v26 = await schema('26.1.0');
  v94 = await schema('9.4.0');
});

/**
 * The model every case starts from. Each case parses it, or a variant of its text, because the
 * consumer's path is exactly that: the user applies edited IDF text, the text is parsed into a new
 * document, and the old and new documents are compared.
 */
const BASE = `
Version, 26.1;
Building, Office, 0, Suburbs, 0.04, 0.4, FullExterior, 25, 6;
Timestep, 4;
Zone, Z1, 0, 0, 0, 0, 1, , 2.7;
Zone, Z2, 0, 10, 0, 0, 1, , 2.7;
ZoneList, All Zones, Z1, Z2;
Material, Brick, Rough, 0.1, 0.9, 1900, 800;
Construction, Wall Construction, Brick;
BuildingSurface:Detailed, Wall-1, Wall, Wall Construction, Z1, , Outdoors, , SunExposed,
  WindExposed, autocalculate, 4, 0, 0, 3, 0, 0, 0, 5, 0, 0, 5, 0, 3;
ZoneHVAC:EquipmentConnections, Z1, Z1 Equipment, Z1 Inlet, , Z1 Air Node, Z1 Return;
ScheduleTypeLimits, Fraction A, 0, 1, Continuous;
ScheduleTypeLimits, Fraction B, 0, 1, Continuous;
Output:Variable, *, Zone Mean Air Temperature, Hourly;
Output:Variable, *, Site Outdoor Air Drybulb Temperature, Hourly;
`;

function parse(text: string, version: Schema = v26): IdfDocument {
  return parseIdf(text, version, { strict: false }).document;
}

/** The base text with each `[from, to]` replacement applied once, in order. */
function edit(...replacements: Array<[string, string]>): string {
  let text = BASE;
  for (const [from, to] of replacements) {
    if (!text.includes(from)) throw new Error(`fixture does not contain ${JSON.stringify(from)}`);
    text = text.replace(from, to);
  }
  return text;
}

/**
 * One line per entry, so a case states the whole delta it expects in a form a reader can check
 * against the two texts at a glance. The structured assertions below each case pin the shapes.
 */
function summary(delta: DocumentDelta): string[] {
  return delta.objects.map((entry: ObjectDelta) => {
    switch (entry.kind) {
      case 'added':
        return `added ${entry.type} ${JSON.stringify(entry.name)}`;
      case 'removed':
        return `removed ${entry.type} ${JSON.stringify(entry.name)}`;
      case 'changed':
        return `changed ${entry.type} ${JSON.stringify(entry.name)}`;
      case 'renamed':
        return `renamed ${entry.type} ${JSON.stringify(entry.from)} -> ${JSON.stringify(entry.to)}`;
    }
  });
}

describe('diffDocuments', () => {
  describe('two identical documents', () => {
    it('returns an empty delta, not an error', () => {
      const delta = diffDocuments(parse(BASE), parse(BASE));
      expect(delta).toEqual({ version: '26.1.0', objects: [] });
    });

    it('returns an empty delta for a document compared with itself', () => {
      const document = parse(BASE);
      expect(diffDocuments(document, document).objects).toEqual([]);
    });
  });

  describe('objects added and removed', () => {
    it('reports each by type and name, with the object it describes', () => {
      const before = parse(BASE);
      const after = parse(
        edit(
          ['Material, Brick, Rough, 0.1, 0.9, 1900, 800;\n', ''],
          ['Timestep, 4;\n', 'Timestep, 4;\nZone, Z3, 0, 20, 0, 0, 1, , 2.7;\n']
        )
      );
      const delta = diffDocuments(before, after);

      expect(summary(delta)).toEqual(['added Zone "Z3"', 'removed Material "Brick"']);
      const [added, removed] = delta.objects;
      expect(added).toMatchObject({ kind: 'added', type: 'Zone', name: 'Z3' });
      expect(added?.kind === 'added' && added.object).toBe(after.get('Zone', 'Z3'));
      expect(removed).toMatchObject({ kind: 'removed', type: 'Material', name: 'Brick' });
      expect(removed?.kind === 'removed' && removed.object).toBe(before.get('Material', 'Brick'));
    });
  });

  describe('fields of an object present in both', () => {
    it('reports each differing field by its epJSON name, with the old and new value', () => {
      const delta = diffDocuments(
        parse(BASE),
        parse(edit(['Zone, Z1, 0, 0, 0, 0, 1, , 2.7;', 'Zone, Z1, 15, 0, 0, 0, 1, , 3.1;']))
      );

      expect(delta.objects).toHaveLength(1);
      expect(delta.objects[0]).toMatchObject({
        kind: 'changed',
        type: 'Zone',
        name: 'Z1',
        fields: [
          { kind: 'field', field: 'direction_of_relative_north', before: 0, after: 15 },
          { kind: 'field', field: 'ceiling_height', before: 2.7, after: 3.1 },
        ],
      });
    });

    it('reports a cleared field as a change to undefined', () => {
      const delta = diffDocuments(
        parse(BASE),
        parse(edit(['Zone, Z1, 0, 0, 0, 0, 1, , 2.7;', 'Zone, Z1, 0, 0, 0, 0, 1, , ;']))
      );

      expect(delta.objects).toHaveLength(1);
      const entry = delta.objects[0];
      expect(entry?.kind === 'changed' && entry.fields).toEqual([
        { kind: 'field', field: 'ceiling_height', before: 2.7, after: undefined },
      ]);
    });

    it('reports a field written at its default as differing from the field left blank', () => {
      // Zone multiplier defaults to 1. EnergyPlus runs both models identically, but the documents
      // hold different values and the writers emit different text, and the delta describes the
      // documents rather than a simulation.
      expect(v26.require('Zone').p['multiplier']?.d).toBe(1);
      const delta = diffDocuments(
        parse(BASE),
        parse(edit(['Zone, Z1, 0, 0, 0, 0, 1, , 2.7;', 'Zone, Z1, 0, 0, 0, 0, 1, 1, 2.7;']))
      );

      const entry = delta.objects[0];
      expect(entry?.kind === 'changed' && entry.fields).toEqual([
        { kind: 'field', field: 'multiplier', before: undefined, after: 1 },
      ]);
    });

    it('compares values exactly, so a change of letter case is a change', () => {
      const delta = diffDocuments(
        parse(BASE),
        parse(edit(['Material, Brick, Rough,', 'Material, Brick, ROUGH,']))
      );

      const entry = delta.objects[0];
      expect(entry?.kind === 'changed' && entry.fields).toEqual([
        { kind: 'field', field: 'roughness', before: 'Rough', after: 'ROUGH' },
      ]);
    });
  });

  describe('an object moved to another position', () => {
    it('is not reported when its content is unchanged', () => {
      const moved = edit(
        ['Zone, Z1, 0, 0, 0, 0, 1, , 2.7;\n', ''],
        ['ZoneList, All Zones', 'Zone, Z1, 0, 0, 0, 0, 1, , 2.7;\nZoneList, All Zones'],
        ['Output:Variable, *, Zone Mean Air Temperature, Hourly;\n', '']
      ).concat('Output:Variable, *, Zone Mean Air Temperature, Hourly;\n');
      const before = parse(BASE);
      const after = parse(moved);
      expect(after.all('Zone').names()).toEqual(['Z2', 'Z1']);

      expect(diffDocuments(before, after).objects).toEqual([]);
    });
  });

  describe('renames', () => {
    it('reports an object renamed as a rename, with the references the rename rewrote', () => {
      // What `document.rename` produces, written out and read back: the zone and every reference
      // to it, in a plain field, an extensible group, and an object with no name of its own.
      const before = parse(BASE);
      const renamed = parse(BASE);
      renamed.rename(renamed.require('Zone', 'Z1'), 'Core');
      const after = parse(writeIdf(renamed));

      const delta = diffDocuments(before, after);
      expect(summary(delta)).toEqual(['renamed Zone "Z1" -> "Core"']);

      const entry = delta.objects[0];
      if (entry?.kind !== 'renamed') throw new Error('expected a rename');
      expect(entry.fields).toEqual([]);
      expect(entry.before).toBe(before.get('Zone', 'Z1'));
      expect(entry.after).toBe(after.get('Zone', 'Core'));
      expect(entry.references.map(({ type, name, change }) => ({ type, name, change }))).toEqual([
        {
          type: 'ZoneList',
          name: 'All Zones',
          change: {
            kind: 'group-field',
            key: 'zones',
            index: 0,
            field: 'zone_name',
            before: 'Z1',
            after: 'Core',
          },
        },
        {
          type: 'BuildingSurface:Detailed',
          name: 'Wall-1',
          change: { kind: 'field', field: 'zone_name', before: 'Z1', after: 'Core' },
        },
        {
          type: 'ZoneHVAC:EquipmentConnections',
          name: '',
          change: { kind: 'field', field: 'zone_name', before: 'Z1', after: 'Core' },
        },
      ]);
      expect(entry.references[1]?.object).toBe(after.get('BuildingSurface:Detailed', 'Wall-1'));
    });

    it('reports an object renamed and edited as one rename carrying the field changes', () => {
      const after = parse(
        edit(
          ['Zone, Z1, 0, 0, 0, 0, 1, , 2.7;', 'Zone, Core, 0, 0, 0, 0, 1, , 3.0;'],
          ['ZoneList, All Zones, Z1, Z2;', 'ZoneList, All Zones, Core, Z2;'],
          ['Wall Construction, Z1,', 'Wall Construction, Core,'],
          ['EquipmentConnections, Z1,', 'EquipmentConnections, Core,']
        )
      );
      const delta = diffDocuments(parse(BASE), after);

      expect(summary(delta)).toEqual(['renamed Zone "Z1" -> "Core"']);
      const entry = delta.objects[0];
      if (entry?.kind !== 'renamed') throw new Error('expected a rename');
      expect(entry.fields).toEqual([
        { kind: 'field', field: 'ceiling_height', before: 2.7, after: 3.0 },
      ]);
      expect(entry.references).toHaveLength(3);
    });

    it('reports an object renamed with identical content and no references as a rename', () => {
      const delta = diffDocuments(parse(BASE), parse(edit(['Fraction A,', 'Fraction Only,'])));
      expect(summary(delta)).toEqual([
        'renamed ScheduleTypeLimits "Fraction A" -> "Fraction Only"',
      ]);
    });

    it('reports a change of letter case in a name as a rename', () => {
      const delta = diffDocuments(
        parse(BASE),
        parse(edit(['Material, Brick,', 'Material, BRICK,']))
      );
      expect(summary(delta)).toEqual(['renamed Material "Brick" -> "BRICK"']);
    });

    it('reports a singleton whose name changed as a rename', () => {
      const delta = diffDocuments(parse(BASE), parse(edit(['Building, Office,', 'Building, HQ,'])));
      expect(summary(delta)).toEqual(['renamed Building "Office" -> "HQ"']);
    });

    it('reports an object renamed and edited that nothing refers to as a removal and an addition', () => {
      // No reference was rewritten and the content differs, so nothing distinguishes this from
      // deleting one object and creating another, and the delta does not guess.
      const delta = diffDocuments(
        parse(BASE),
        parse(edit(['Fraction A, 0, 1, Continuous;', 'Fraction Only, 0, 0.5, Continuous;']))
      );
      expect(summary(delta)).toEqual([
        'added ScheduleTypeLimits "Fraction Only"',
        'removed ScheduleTypeLimits "Fraction A"',
      ]);
    });

    it('reports an ambiguous pair as a removal and an addition: two removed, two added', () => {
      // Fraction A and Fraction B are identical, so each new name matches both old ones.
      const delta = diffDocuments(
        parse(BASE),
        parse(edit(['Fraction A,', 'Fraction C,'], ['Fraction B,', 'Fraction D,']))
      );
      expect(summary(delta)).toEqual([
        'added ScheduleTypeLimits "Fraction C"',
        'added ScheduleTypeLimits "Fraction D"',
        'removed ScheduleTypeLimits "Fraction A"',
        'removed ScheduleTypeLimits "Fraction B"',
      ]);
    });

    it('reports an ambiguous pair as a removal and an addition: two removed, one added', () => {
      const delta = diffDocuments(
        parse(BASE),
        parse(
          edit(
            ['ScheduleTypeLimits, Fraction A, 0, 1, Continuous;\n', ''],
            ['Fraction B,', 'Fraction C,']
          )
        )
      );
      expect(summary(delta)).toEqual([
        'added ScheduleTypeLimits "Fraction C"',
        'removed ScheduleTypeLimits "Fraction A"',
        'removed ScheduleTypeLimits "Fraction B"',
      ]);
    });

    it('lets a rewritten reference single out one of several identical candidates', () => {
      // Two identical materials are removed and one is added, which content alone cannot settle.
      // The construction's layer moving from Brick to Clay names the pair.
      const before = parse(BASE.concat('Material, Stone, Rough, 0.1, 0.9, 1900, 800;\n'));
      const after = parse(
        edit(
          ['Material, Brick,', 'Material, Clay,'],
          ['Construction, Wall Construction, Brick;', 'Construction, Wall Construction, Clay;']
        )
      );
      const delta = diffDocuments(before, after);
      expect(summary(delta)).toEqual([
        'renamed Material "Brick" -> "Clay"',
        'removed Material "Stone"',
      ]);
    });

    it('combines the two passes: a reference names one pair, content the other', () => {
      const before = parse(BASE.concat('Material, Stone, Smooth, 0.2, 0.9, 1900, 800;\n'));
      const after = parse(
        edit(
          ['Material, Brick,', 'Material, Clay,'],
          ['Construction, Wall Construction, Brick;', 'Construction, Wall Construction, Clay;']
        ).concat('Material, Slate, Smooth, 0.2, 0.9, 1900, 800;\n')
      );
      expect(summary(diffDocuments(before, after))).toEqual([
        'renamed Material "Brick" -> "Clay"',
        'renamed Material "Stone" -> "Slate"',
      ]);
    });

    it('does not report two objects merged into one as a rename', () => {
      // Both constructions now name Clay, so Clay has two candidates by reference, and its
      // content matches neither. The references stay ordinary field changes: no rename explains
      // them.
      const before = parse(
        BASE.concat(
          'Material, Stone, Smooth, 0.2, 0.9, 1900, 800;\nConstruction, Floor Construction, Stone;\n'
        )
      );
      const after = parse(
        edit(
          ['Material, Brick, Rough, 0.1,', 'Material, Clay, Rough, 0.3,'],
          ['Construction, Wall Construction, Brick;', 'Construction, Wall Construction, Clay;']
        ).concat('Construction, Floor Construction, Clay;\n')
      );
      const delta = diffDocuments(before, after);
      expect(summary(delta)).toEqual([
        'added Material "Clay"',
        'removed Material "Brick"',
        'removed Material "Stone"',
        'changed Construction "Wall Construction"',
        'changed Construction "Floor Construction"',
      ]);
      const wall = delta.objects[3];
      expect(wall?.kind === 'changed' && wall.fields).toEqual([
        { kind: 'field', field: 'outside_layer', before: 'Brick', after: 'Clay' },
      ]);
    });
  });

  describe('references rewritten by a rename', () => {
    it('are reported under the rename, not as field changes of the referring object', () => {
      const delta = diffDocuments(
        parse(BASE),
        parse(
          edit(
            ['Zone, Z1,', 'Zone, Core,'],
            ['ZoneList, All Zones, Z1, Z2;', 'ZoneList, All Zones, Core, Z2;'],
            ['Wall Construction, Z1,', 'Wall Construction, Core,'],
            ['EquipmentConnections, Z1,', 'EquipmentConnections, Core,']
          )
        )
      );
      expect(summary(delta)).toEqual(['renamed Zone "Z1" -> "Core"']);
    });

    it('leave the referring object reported for its other edits', () => {
      const delta = diffDocuments(
        parse(BASE),
        parse(
          edit(
            ['Zone, Z1,', 'Zone, Core,'],
            ['ZoneList, All Zones, Z1, Z2;', 'ZoneList, All Zones, Core, Z2;'],
            ['Wall Construction, Z1, , Outdoors', 'Wall Construction, Core, , Ground'],
            ['EquipmentConnections, Z1,', 'EquipmentConnections, Core,']
          )
        )
      );
      expect(summary(delta)).toEqual([
        'renamed Zone "Z1" -> "Core"',
        'changed BuildingSurface:Detailed "Wall-1"',
      ]);
      const surface = delta.objects[1];
      expect(surface?.kind === 'changed' && surface.fields).toEqual([
        { kind: 'field', field: 'outside_boundary_condition', before: 'Outdoors', after: 'Ground' },
      ]);
    });

    it('are attributed only from a field that reads the renamed type', () => {
      // The surface's construction moves from Z1 to Core, the same pair of names as the zone's
      // rename. That field reads ConstructionNames, which a zone's name does not enter, so the
      // change is an edit of the surface and not a consequence of the rename.
      const constructions = 'Construction, Z1, Brick;\nConstruction, Core, Brick;\n';
      const before = parse(edit(['Wall Construction, Z1,', 'Z1, Z1,']).concat(constructions));
      const after = parse(
        edit(
          ['Zone, Z1,', 'Zone, Core,'],
          ['ZoneList, All Zones, Z1, Z2;', 'ZoneList, All Zones, Core, Z2;'],
          ['Wall Construction, Z1,', 'Core, Core,'],
          ['EquipmentConnections, Z1,', 'EquipmentConnections, Core,']
        ).concat(constructions)
      );
      const delta = diffDocuments(before, after);
      expect(summary(delta)).toEqual([
        'renamed Zone "Z1" -> "Core"',
        'changed BuildingSurface:Detailed "Wall-1"',
      ]);
      const surface = delta.objects[1];
      expect(surface?.kind === 'changed' && surface.fields).toEqual([
        { kind: 'field', field: 'construction_name', before: 'Z1', after: 'Core' },
      ]);
      const rename = delta.objects[0];
      expect(rename?.kind === 'renamed' && rename.references.map((r) => r.type)).toEqual([
        'ZoneList',
        'BuildingSurface:Detailed',
        'ZoneHVAC:EquipmentConnections',
      ]);
    });
  });

  describe('extensible groups', () => {
    const WALL = 'autocalculate, 4, 0, 0, 3, 0, 0, 0, 5, 0, 0, 5, 0, 3;';

    function surface(vertices: string): IdfDocument {
      return parse(edit([WALL, `autocalculate, 4, ${vertices};`]));
    }

    it('reports a group appended as one group added at its index', () => {
      const delta = diffDocuments(
        parse(BASE),
        surface('0, 0, 3, 0, 0, 0, 5, 0, 0, 5, 0, 3, 2, 0, 4')
      );
      const entry = delta.objects[0];
      expect(entry?.kind === 'changed' && entry.fields).toEqual([
        {
          kind: 'group-added',
          key: 'vertices',
          index: 4,
          group: { vertex_x_coordinate: 2, vertex_y_coordinate: 0, vertex_z_coordinate: 4 },
        },
      ]);
    });

    it('reports the last group removed as one group removed at its index', () => {
      const delta = diffDocuments(parse(BASE), surface('0, 0, 3, 0, 0, 0, 5, 0, 0'));
      const entry = delta.objects[0];
      expect(entry?.kind === 'changed' && entry.fields).toEqual([
        {
          kind: 'group-removed',
          key: 'vertices',
          index: 3,
          group: { vertex_x_coordinate: 5, vertex_y_coordinate: 0, vertex_z_coordinate: 3 },
        },
      ]);
    });

    it('compares groups by position, so a group removed from the middle shifts the rest', () => {
      const delta = diffDocuments(parse(BASE), surface('0, 0, 3, 5, 0, 0, 5, 0, 3'));
      const entry = delta.objects[0];
      expect(entry?.kind === 'changed' && entry.fields).toEqual([
        {
          kind: 'group-field',
          key: 'vertices',
          index: 1,
          field: 'vertex_x_coordinate',
          before: 0,
          after: 5,
        },
        {
          kind: 'group-field',
          key: 'vertices',
          index: 2,
          field: 'vertex_z_coordinate',
          before: 0,
          after: 3,
        },
        {
          kind: 'group-removed',
          key: 'vertices',
          index: 3,
          group: { vertex_x_coordinate: 5, vertex_y_coordinate: 0, vertex_z_coordinate: 3 },
        },
      ]);
    });

    it('reports groups reordered as the field changes at each position that differs', () => {
      // Reversing a wall's vertices turns it to face the other way. Order is content here.
      const delta = diffDocuments(parse(BASE), surface('5, 0, 3, 5, 0, 0, 0, 0, 0, 0, 0, 3'));
      const entry = delta.objects[0];
      expect(entry?.kind === 'changed' && entry.fields).toEqual([
        {
          kind: 'group-field',
          key: 'vertices',
          index: 0,
          field: 'vertex_x_coordinate',
          before: 0,
          after: 5,
        },
        {
          kind: 'group-field',
          key: 'vertices',
          index: 1,
          field: 'vertex_x_coordinate',
          before: 0,
          after: 5,
        },
        {
          kind: 'group-field',
          key: 'vertices',
          index: 2,
          field: 'vertex_x_coordinate',
          before: 5,
          after: 0,
        },
        {
          kind: 'group-field',
          key: 'vertices',
          index: 3,
          field: 'vertex_x_coordinate',
          before: 5,
          after: 0,
        },
      ]);
    });

    it('reports reordered references in a group as field changes, not reference rewrites', () => {
      const delta = diffDocuments(
        parse(BASE),
        parse(edit(['ZoneList, All Zones, Z1, Z2;', 'ZoneList, All Zones, Z2, Z1;']))
      );
      const entry = delta.objects[0];
      expect(entry?.kind === 'changed' && entry.fields).toEqual([
        {
          kind: 'group-field',
          key: 'zones',
          index: 0,
          field: 'zone_name',
          before: 'Z1',
          after: 'Z2',
        },
        {
          kind: 'group-field',
          key: 'zones',
          index: 1,
          field: 'zone_name',
          before: 'Z2',
          after: 'Z1',
        },
      ]);
    });
  });

  describe('objects without a name', () => {
    it('match by content, so one added among identical others is one addition', () => {
      const after = parse(BASE.concat('Output:Variable, *, Zone Air Relative Humidity, Hourly;\n'));
      const delta = diffDocuments(parse(BASE), after);
      expect(summary(delta)).toEqual(['added Output:Variable ""']);
      const entry = delta.objects[0];
      expect(entry?.kind === 'added' && entry.object.get('variable_name')).toBe(
        'Zone Air Relative Humidity'
      );
    });

    it('report an edit as a removal and an addition, having no identity beyond their content', () => {
      const delta = diffDocuments(
        parse(BASE),
        parse(edit(['Zone Mean Air Temperature, Hourly;', 'Zone Mean Air Temperature, Timestep;']))
      );
      expect(summary(delta)).toEqual(['added Output:Variable ""', 'removed Output:Variable ""']);
    });

    it('match a singleton by its type, so an edit is a change', () => {
      const delta = diffDocuments(parse(BASE), parse(edit(['Timestep, 4;', 'Timestep, 6;'])));
      expect(delta.objects).toEqual([
        expect.objectContaining({
          kind: 'changed',
          type: 'Timestep',
          name: '',
          fields: [{ kind: 'field', field: 'number_of_timesteps_per_hour', before: 4, after: 6 }],
        }),
      ]);
    });
  });

  describe('two documents of different schema versions', () => {
    it('throws IncomparableVersionsError naming both versions', () => {
      const before = parse(BASE);
      const after = parse('Version, 9.4;\nZone, Z1;\n', v94);

      expect(() => diffDocuments(before, after)).toThrow(IncomparableVersionsError);
      try {
        diffDocuments(before, after);
      } catch (error) {
        expect(error).toBeInstanceOf(IncomparableVersionsError);
        expect(error).toBeInstanceOf(Error);
        const mismatch = error as IncomparableVersionsError;
        expect(mismatch.name).toBe('IncomparableVersionsError');
        expect(mismatch.before).toBe('26.1.0');
        expect(mismatch.after).toBe('9.4.0');
        expect(mismatch.message).toContain('26.1.0');
        expect(mismatch.message).toContain('9.4.0');
      }
    });
  });

  describe('a round trip through IDF text', () => {
    it('describes edits made through the object model once written and read back', () => {
      const before = parse(BASE);
      const edited = parse(BASE);
      edited.rename(edited.require('Material', 'Brick'), 'Clay');
      edited.require('Zone', 'Z2').set('ceiling_height', 3.4);
      edited.require('BuildingSurface:Detailed', 'Wall-1').extensible.pop();
      edited.remove(edited.require('ScheduleTypeLimits', 'Fraction B'));
      edited.add('Zone', 'Z3', { ceiling_height: 2.4 });

      const after = parse(writeIdf(edited));
      const delta = diffDocuments(before, after);

      expect(summary(delta)).toEqual([
        'changed Zone "Z2"',
        'added Zone "Z3"',
        'renamed Material "Brick" -> "Clay"',
        'changed BuildingSurface:Detailed "Wall-1"',
        'removed ScheduleTypeLimits "Fraction B"',
      ]);
      // The same delta whether the edited document is compared directly or after the round trip.
      expect(summary(diffDocuments(before, edited))).toEqual(summary(delta));
    });

    it('finds nothing between a document and its own written text', () => {
      const document = parse(BASE);
      expect(diffDocuments(document, parse(writeIdf(document))).objects).toEqual([]);
    });
  });

  it('leaves both documents as they were', () => {
    const before = parseIdf(BASE, v26, { strict: false, preserveFormatting: true }).document;
    const after = parse(edit(['Zone, Z1,', 'Zone, Core,']));
    diffDocuments(before, after);

    expect([...before.changedObjects()]).toEqual([]);
    expect(writeIdf(before)).toBe(BASE);
  });
});
