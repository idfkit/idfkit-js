import { beforeAll, describe, expect, it } from 'vitest';

import { parseEpJson, parseIdf, scanIdf, writeEpJson, writeIdf, writeObject } from '@idfkit/core';
import type { Schema } from '@idfkit/schemas';

import { schema, syntaxFixture, syntaxFixtures } from './helpers.js';

let v26: Schema;
beforeAll(async () => {
  v26 = await schema('26.1.0');
});

/**
 * The first place two texts differ, as an offset with a window of each side.
 *
 * A whole-file diff of two 600 KB files is not a finding anyone can act on, and the failures this
 * suite produces are one character wide by nature: a lost trailing newline, a `3.000` come back as
 * `3`, a line ending translated. This is the same shape the conformance corpus reports, for the
 * same reason.
 */
function firstDifference(written: string, source: string): string | undefined {
  if (written === source) return undefined;
  let at = 0;
  while (at < written.length && at < source.length && written[at] === source[at]) at += 1;
  const line = source.slice(0, at).split('\n').length;
  const window = (text: string) => JSON.stringify(text.slice(at, at + 60));
  return `offset ${at} (line ${line}): written ${window(written)}, source ${window(source)}`;
}

/** Read with preservation, or `undefined` when this schema cannot read the fixture at all. */
function read(text: string) {
  try {
    return parseIdf(text, v26, { strict: false, preserveFormatting: true }).document;
  } catch {
    return undefined;
  }
}

describe('a file read and written comes back the file it was', () => {
  it('reproduces every syntax fixture byte for byte', () => {
    // The corpus is the evidence for this claim across the two languages; this is how the second
    // language develops against it. Every fixture, not a chosen one: a fixture added for some
    // other case is then held to this invariant without anybody remembering to add it here.
    let checked = 0;
    for (const fixture of syntaxFixtures()) {
      const document = read(fixture.text);
      if (document === undefined) continue;
      checked += 1;
      const written = writeIdf(document);
      expect(
        firstDifference(written, fixture.text),
        `${fixture.name}: ${firstDifference(written, fixture.text) ?? ''}`
      ).toBeUndefined();
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it('reproduces a file that is only comments, and an empty one', () => {
    // No statements at all, so the walk emits the whole text as its leading part. This is the case
    // an implementation that indexes rather than reasons gets wrong.
    for (const name of ['comments-only', 'empty']) {
      const text = syntaxFixture(name);
      const document = parseIdf(text, v26, { strict: false, preserveFormatting: true }).document;
      expect(writeIdf(document), name).toBe(text);
    }
  });

  it('reproduces a file whose lines end in carriage returns, and one that mixes both', () => {
    for (const name of ['line-endings-crlf', 'line-endings-mixed']) {
      const text = syntaxFixture(name);
      const document = read(text);
      expect(document, name).toBeDefined();
      expect(writeIdf(document!), name).toBe(text);
    }
  });

  it('adds no trailing newline to a file that had none', () => {
    const text = syntaxFixture('no-trailing-newline');
    expect(text.endsWith('\n')).toBe(false);

    const written = writeIdf(read(text)!);

    expect(written).toBe(text);
    expect(written.endsWith('\n')).toBe(false);
  });

  it('invents no terminator for an unterminated final statement', () => {
    // The layer represents it running to end of input and says so. An untouched statement is
    // copied, so nothing is invented; a touched one is formatted and gains one, which is a
    // different question and is not this one.
    const text = syntaxFixture('unterminated-final-statement');
    const document = read(text);
    expect(document).toBeDefined();

    const written = writeIdf(document!);

    expect(written).toBe(text);
    expect(written.trimEnd().endsWith(';')).toBe(false);
  });

  it('keeps the characters of a statement the read rejected', () => {
    // A duplicate name that `addRaw` refused. The read already reported a diagnostic; deleting
    // text the author wrote because of it would be worse than reproducing it.
    const text = syntaxFixture('duplicate-object-name');
    const { document, diagnostics } = parseIdf(text, v26, {
      strict: false,
      preserveFormatting: true,
    });

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(writeIdf(document)).toBe(text);
  });

  it('changes nothing for a caller who does not use it', () => {
    // FR-029, and it holds structurally rather than by care: the preserving path is reached only
    // through an option that is off by default on the read. This asserts it anyway, because the
    // cheapest way to break it would be to make the read preserve by default.
    for (const fixture of syntaxFixtures()) {
      let plain;
      try {
        plain = parseIdf(fixture.text, v26, { strict: false }).document;
      } catch {
        continue;
      }
      const kept = read(fixture.text);
      if (kept === undefined) continue;
      expect(writeIdf(kept, { preserveFormatting: false }), fixture.name).toBe(writeIdf(plain));
    }
  });

  it('writes the same text twice, and assigns nothing while writing', () => {
    // FR-030. Structural, because the walk reads the slots and never assigns them, and worth a
    // test anyway: the cheapest way to break it is an optimisation that caches formatted text on
    // the object.
    const text = syntaxFixture('line-endings-lf');
    const document = read(text)!;

    const first = writeIdf(document);
    const second = writeIdf(document);

    expect(first).toBe(second);
    expect(first).toBe(text);
    expect(document.rawText).toBe(text);
  });
});

describe('one field changes and one object looks changed', () => {
  const MODEL = [
    '! a header comment nobody edited',
    '',
    'Version, 26.1;',
    '',
    '! *** the zones ***',
    '',
    'Zone,',
    '  Zone One,     !- Name',
    '  3.000;        !- Direction of Relative North',
    '',
    'Zone,',
    '  Zone Two,     !- Name',
    '  1.0E-5;       !- Direction of Relative North',
    '',
  ].join('\n');

  const read = () => parseIdf(MODEL, v26, { strict: false, preserveFormatting: true }).document;

  it('differs inside exactly one statement and nowhere else', () => {
    const document = read();
    document.require('Zone', 'Zone One').set('direction_of_relative_north', 4.5);

    const written = writeIdf(document);

    // The other zone keeps `1.0E-5`, a notation no writer reproduces from a parsed number, so a
    // writer that reformatted the whole document fails here immediately rather than subtly.
    expect(written).toContain('1.0E-5;       !- Direction of Relative North');
    expect(written).toContain('! a header comment nobody edited');
    expect(written).toContain('! *** the zones ***');
    expect(written).toContain('4.5');
    expect(written).not.toContain('3.000');
  });

  it('reproduces an object written the value it already holds', () => {
    // FR-004. The field accessor compares before writing, so the listener never fires and the
    // object is still the characters it was read from.
    const document = read();
    const zone = document.require('Zone', 'Zone One');
    zone.set('direction_of_relative_north', zone.get('direction_of_relative_north') ?? 0);

    expect(writeIdf(document)).toBe(MODEL);
  });

  it('leaves the whitespace around a removed object alone', () => {
    const document = read();
    document.remove(document.require('Zone', 'Zone Two'));

    const written = writeIdf(document);

    expect(written).not.toContain('Zone Two');
    expect(written).toContain('! *** the zones ***');
    // The removed statement's extent goes and the gaps around it do not: the blank line that
    // separated the two zones is in a gap and belongs to no object.
    //
    // The comment on the TERMINATOR's line goes with the object (idfkit-js#47). It is the last
    // field's comment, and the field no longer exists, so leaving it behind would strand a line
    // describing something that is gone. A comment on its own line, or after a blank one, stays:
    // that is where deciding which object a comment belongs to becomes a guess.
    expect(written).toBe(
      MODEL.replace(
        'Zone,\n  Zone Two,     !- Name\n  1.0E-5;       !- Direction of Relative North',
        ''
      )
    );
    // Zone One still carries its own, on its own terminator line.
    expect(written).toContain('!- Direction of Relative North');
  });

  it("keeps the author's comments on an object it reformats", () => {
    // The values are what an edit asks to re-render. The comments are not, and rebuilding them
    // destroys whatever the schema cannot regenerate: a note to a colleague, and the field's unit,
    // which the generated label does not carry. Both are kept, in place, exactly as written.
    const text = [
      'Version, 26.1;',
      '',
      'Building,',
      '  My Building,             !- Name',
      '  0,                       !- North Axis {deg}',
      '  City;                    !- VERIFY WITH CLIENT before the Feb review',
      '',
    ].join('\n');
    const { document } = parseIdf(text, v26, { strict: false, preserveFormatting: true });
    document.require('Building', 'My Building').set('north_axis', 42);

    const written = writeIdf(document);

    expect(written).toContain('!- North Axis {deg}');
    expect(written).toContain('!- VERIFY WITH CLIENT before the Feb review');
    // Once each, not twice: the writer emits the author's comment in place of its own, so there is
    // nothing left in the gap to arrive on the line below (idfkit-js#47).
    expect(written.match(/!- North Axis/g)).toHaveLength(1);
    expect(written.match(/VERIFY WITH CLIENT/g)).toHaveLength(1);
    // The value is the one thing that did change.
    expect(written).toContain('42.0');
    expect(written).not.toContain('  0,');
  });

  it('adds no line to the file for an object it reformats', () => {
    // A statement's extent ends at its terminator, or at the comment on that same line, and never
    // includes the line break: the break is the first character of the gap. `writeObject` ends with
    // one because it also writes whole documents, so emitting it here put the break in twice and
    // grew the file by a blank line per reformatted object — compounding on every save.
    //
    // It was there before the comment work and was invisible: the misplaced terminator comment sat
    // in the gap between the two breaks, so it read as one blank line. Fixing that exposed this.
    const text = [
      'Version, 26.1;',
      '',
      'Building,',
      '  My Building,   !- Name',
      '  0;             !- North Axis {deg}',
      '',
      'Timestep, 6;',
      '',
    ].join('\n');
    const { document } = parseIdf(text, v26, { strict: false, preserveFormatting: true });
    document.require('Building', 'My Building').set('north_axis', 42);

    const written = writeIdf(document);

    expect(written.split('\n')).toHaveLength(text.split('\n').length);
    expect(written).not.toContain('\n\n\n');
    // And again, on the output, because the growth compounded rather than saturating.
    const reread = parseIdf(written, v26, { strict: false, preserveFormatting: true }).document;
    reread.require('Building', 'My Building').set('north_axis', 43);
    expect(writeIdf(reread).split('\n')).toHaveLength(text.split('\n').length);
  });

  it('generates a comment only for a field the author never wrote one for', () => {
    const text = ['Version, 26.1;', '', 'Building,', '  My Building;', ''].join('\n');
    const { document } = parseIdf(text, v26, { strict: false, preserveFormatting: true });
    document.require('Building', 'My Building').set('north_axis', 42);

    expect(writeIdf(document)).toContain('!- North Axis');
  });

  it('does not leave the old terminator comment below a reformatted object', () => {
    // idfkit-js#47. A statement's region ends at its terminator, so a comment after the semicolon
    // on the same line used to sit in the gap. Invisible while the object is copied, because the
    // gap is copied too; wrong the moment it is reformatted, because the writer emits its own
    // field comment and the author's then arrives on the line below.
    //
    // It is not even a duplicate: the ordinary writer drops the unit, so `!- North Axis {deg}`
    // reads as a stray fragment under `!- North Axis`. IDFEditor writes one of these on every
    // line of every object, so about half the statements in a typical file were affected.
    const text = [
      'Version, 26.1;',
      '',
      'Building,',
      '  My Building,             !- Name',
      '  0;                       !- North Axis {deg}',
      '',
    ].join('\n');
    const { document } = parseIdf(text, v26, { strict: false, preserveFormatting: true });
    document.require('Building', 'My Building').set('north_axis', 42);

    const written = writeIdf(document);

    // Once, in place, with the author's unit intact. It used to arrive a second time from the gap.
    expect(written.match(/!- North Axis/g)).toHaveLength(1);
    expect(written).toContain('!- North Axis {deg}');
  });

  it('leaves a comment on its own line where it is', () => {
    // The boundary of the rule above. Only the terminator's own line is absorbed; a comment on the
    // next line is about whatever follows it and is nobody's to move.
    const text = [
      'Version, 26.1;',
      '',
      'Building,',
      '  My Building,             !- Name',
      '  0;',
      '! a note about what comes next',
      '',
      'Timestep, 6;',
      '',
    ].join('\n');
    const { document } = parseIdf(text, v26, { strict: false, preserveFormatting: true });
    document.require('Building', 'My Building').set('north_axis', 42);

    expect(writeIdf(document)).toContain('! a note about what comes next');
  });

  it('appends a new object at the end, formatted', () => {
    const document = read();
    document.add('Zone', 'Zone Three');

    const written = writeIdf(document);

    expect(written.indexOf('Zone Three')).toBeGreaterThan(written.indexOf('Zone Two'));
    expect(written.startsWith(MODEL)).toBe(true);
  });

  it('does not run an appended object onto the last line of a file with no trailing newline', () => {
    const text = syntaxFixture('no-trailing-newline');
    expect(text.endsWith('\n')).toBe(false);
    const document =
      read.call(null) && parseIdf(text, v26, { strict: false, preserveFormatting: true }).document;

    document.add('Zone', 'Appended');
    const written = writeIdf(document);

    expect(written.startsWith(`${text}\n`)).toBe(true);
    expect(written).toContain('Appended');
  });

  it('keeps an extensible edit, both in place and wholesale', () => {
    // The edit the writer would otherwise discard silently, in both spellings.
    const surfaceText = [
      'Version, 26.1;',
      '',
      'BuildingSurface:Detailed,',
      '  S1,           !- Name',
      '  Wall,         !- Surface Type',
      '  C1,           !- Construction Name',
      '  Z1,           !- Zone Name',
      '  ,             !- Space Name',
      '  Outdoors,     !- Outside Boundary Condition',
      '  ,             !- Outside Boundary Condition Object',
      '  SunExposed,   !- Sun Exposure',
      '  WindExposed,  !- Wind Exposure',
      '  ,             !- View Factor to Ground',
      '  ,             !- Number of Vertices',
      '  0.0, 0.0, 0.0,',
      '  1.0, 0.0, 0.0;',
      '',
    ].join('\n');

    const inPlace = parseIdf(surfaceText, v26, {
      strict: false,
      preserveFormatting: true,
    }).document;
    const surface = inPlace.require('BuildingSurface:Detailed', 'S1');
    surface.extensible[0]!['vertex_x_coordinate'] = 9;
    expect(writeIdf(inPlace)).toContain('9');

    const wholesale = parseIdf(surfaceText, v26, {
      strict: false,
      preserveFormatting: true,
    }).document;
    wholesale
      .require('BuildingSurface:Detailed', 'S1')
      .set('vertices', [
        { vertex_x_coordinate: 7, vertex_y_coordinate: 0, vertex_z_coordinate: 0 },
      ]);
    expect(writeIdf(wholesale)).toContain('7');
  });
});

describe('a rename does not leave the old name in the file', () => {
  const REFERENCED = [
    'Version, 26.1;',
    '',
    'Material:NoMass,',
    '  Partition Material,   !- Name',
    '  Rough,                !- Roughness',
    '  1.0;                  !- Thermal Resistance',
    '',
    'Construction,',
    '  Upper Case Reference, !- Name',
    '  PARTITION MATERIAL;   !- Outside Layer',
    '',
    'Construction,',
    '  Lower Case Reference, !- Name',
    '  partition material;   !- Outside Layer',
    '',
  ].join('\n');

  it('leaves no occurrence of the old name, over the re-read output', () => {
    // Asserted over a re-read rather than over the write path, because this is the one failure in
    // this feature that is silent: the output is valid IDF, the model is broken, and nothing in
    // the write says so. Reading it back is what a consumer would do, and what catches it.
    const document = parseIdf(REFERENCED, v26, {
      strict: false,
      preserveFormatting: true,
    }).document;
    document.rename(document.require('Material:NoMass', 'Partition Material'), 'Renamed Material');

    const written = writeIdf(document);
    const reread = parseIdf(written, v26, { strict: false }).document;

    expect(written.toLowerCase()).not.toContain('partition material');
    expect(reread.require('Construction', 'Upper Case Reference').get('outside_layer')).toBe(
      'Renamed Material'
    );
    expect(reread.require('Construction', 'Lower Case Reference').get('outside_layer')).toBe(
      'Renamed Material'
    );
    expect(reread.danglingReferences()).toEqual([]);
  });

  it('leaves no occurrence of a name referenced from inside a repeat', () => {
    // The branch a top-level reference never reaches. `retarget` rewrites a reference held in an
    // extensible repeat on its own branch, so a touched mark added to only one branch passes every
    // test whose reference is a plain field and fails only here.
    const text = [
      'Version, 26.1;',
      '',
      'Zone, Zone One;',
      '',
      'ZoneList,',
      '  All Zones,    !- Name',
      '  Zone One;     !- Zone 1 Name',
      '',
    ].join('\n');
    const { document } = parseIdf(text, v26, { strict: false, preserveFormatting: true });
    const list = document.require('ZoneList', 'All Zones');
    expect(list.extensible.length).toBeGreaterThan(0);

    document.rename(document.require('Zone', 'Zone One'), 'Zone Renamed');

    const written = writeIdf(document);
    const reread = parseIdf(written, v26, { strict: false }).document;

    expect(written).not.toContain('Zone One');
    expect(reread.danglingReferences()).toEqual([]);
  });

  it('reproduces every object when a rename was refused', () => {
    // Nothing changed, so nothing may be reformatted. Both refusals: a name already taken, and a
    // blank one.
    for (const next of ['Lower Case Reference', '']) {
      const document = parseIdf(REFERENCED, v26, {
        strict: false,
        preserveFormatting: true,
      }).document;
      expect(() =>
        document.rename(document.require('Construction', 'Upper Case Reference'), next)
      ).toThrow();

      expect(writeIdf(document)).toBe(REFERENCED);
    }
  });
});

describe('asking for two contradictory things is refused', () => {
  const MODEL =
    'Version, 26.1;\n\nZone,\n  Zone One,     !- Name\n  3.000;        !- Direction of Relative North\n';
  const kept = () => parseIdf(MODEL, v26, { strict: false, preserveFormatting: true }).document;
  const plain = () => parseIdf(MODEL, v26, { strict: false }).document;

  it('refuses each reformatting control asked for alongside preservation', () => {
    // The set is a set of CONTROLS, not of values: the two languages' defaults differ and stay
    // differing, so "away from its default" means away from each language's own.
    const controls = [
      { indent: '  ' },
      { commentColumn: 40 },
      { ordering: 'sorted' as const },
      { versionFirst: false },
    ];
    for (const control of controls) {
      expect(() => writeIdf(kept(), { preserveFormatting: true, ...control })).toThrow(TypeError);
      expect(() => writeIdf(kept(), { preserveFormatting: true, ...control })).toThrow(
        /indent, commentColumn, ordering or versionFirst/
      );
    }
  });

  it('names the class of controls rather than the one the caller happened to set', () => {
    // A caller who set two learns about both, and a caller who set one learns what else is in the
    // set they have just left.
    try {
      writeIdf(kept(), { preserveFormatting: true, indent: '  ', versionFirst: false });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('indent');
      expect((error as Error).message).toContain('versionFirst');
      expect((error as Error).message).toContain('Pass one or the other');
    }
  });

  it('grants an output form and does not preserve, without an error', () => {
    // A different output FORM is a different artifact, which the source was never going to
    // express, so producing it is honest. Neither is refused.
    const compressed = writeIdf(kept(), { preserveFormatting: true, compressed: true });
    expect(compressed).not.toBe(MODEL);
    expect(compressed).toContain('Zone,Zone One,3.0;');

    const bare = writeIdf(kept(), { preserveFormatting: true, comments: false });
    expect(bare).not.toBe(MODEL);
    expect(bare).not.toContain('!-');
    // And it still loads. The type name is the line the field loop starts with, so a branch that
    // returns before flushing it emits it last, which parses as nothing at all.
    expect(() => parseIdf(bare, v26, { strict: false })).not.toThrow();
  });

  it('raises nothing when preservation is asked for on a document read without it', () => {
    // A quiet fallback rather than an error: there is nothing to preserve and nothing was
    // promised. Asking for a control at the same time must not turn that into an error either.
    expect(() => writeIdf(plain(), { preserveFormatting: true })).not.toThrow();
    expect(writeIdf(plain(), { preserveFormatting: true })).toBe(writeIdf(plain()));
    expect(() => writeIdf(plain(), { preserveFormatting: true, indent: '  ' })).not.toThrow();
  });

  it('reads a control set on the default path as a request to format', () => {
    // Row 7, and the one a caller notices: a control is never silently dropped in favour of the
    // source. Setting one and not mentioning preservation gets the control.
    const written = writeIdf(kept(), { indent: '\t' });

    expect(written).not.toBe(MODEL);
    expect(written).toContain('\t');
  });

  it('formats when preservation is explicitly off', () => {
    expect(writeIdf(kept(), { preserveFormatting: false })).toBe(writeIdf(plain()));
  });

  it('preserves when nothing is said at all', () => {
    expect(writeIdf(kept())).toBe(MODEL);
  });
});

describe('the object notation preserves on all-or-nothing terms', () => {
  const EPJSON = JSON.stringify(
    {
      Version: { 'Version 1': { version_identifier: '26.1' } },
      Zone: { A: { direction_of_relative_north: 0 }, B: { direction_of_relative_north: 0 } },
    },
    null,
    4
  );

  const kept = () => parseEpJson(EPJSON, v26, { strict: false, preserveFormatting: true }).document;

  it('reproduces an untouched document byte for byte', () => {
    // Including the indentation, which is four spaces here and not the writer's default of two.
    expect(writeEpJson(kept())).toBe(EPJSON);
  });

  it('falls the whole document back to ordinary output when anything at all changes', () => {
    const edited = kept();
    edited.require('Zone', 'A').set('direction_of_relative_north', 90);
    expect(writeEpJson(edited)).not.toBe(EPJSON);
    expect(writeEpJson(edited)).toBe(JSON.stringify(edited.toJSON(), null, 2));

    const added = kept();
    added.add('Zone', 'C');
    expect(writeEpJson(added)).not.toBe(EPJSON);

    // The removal clause, which asking only the survivors cannot answer: every object left is
    // still exactly its own characters, so without the count the removed object comes back.
    const removed = kept();
    removed.remove(removed.require('Zone', 'B'));
    const written = writeEpJson(removed);
    expect(written).not.toBe(EPJSON);
    expect(written).not.toContain('"B"');
    expect(written).toContain('"A"');
  });

  it('does not hand epJSON text to the IDF writer', () => {
    // The two formats preserve on different terms and cannot share a path. A document read from
    // the object notation must not come back out of writeIdf as the JSON it was read from.
    const written = writeIdf(kept());
    expect(written).not.toContain('{');
    expect(written).toContain('Zone,');
  });
});

describe('which objects a preserving write will rewrite', () => {
  // A consumer cannot derive this from its own edit log. A rename clears the record on every object
  // that referred to the renamed one, so an editor counting its own edits reports one where the
  // answer is three here and nine on a real model.
  const REFERENCED = [
    'Version, 26.1;',
    '',
    'Zone, ZONE ONE;',
    '',
    'BuildingSurface:Detailed,',
    '  S1, Wall, C1, ZONE ONE, , Outdoors, , SunExposed, WindExposed, , ,',
    '  0,0,0, 1,0,0;',
    '',
    'BuildingSurface:Detailed,',
    '  S2, Wall, C1, ZONE ONE, , Outdoors, , SunExposed, WindExposed, , ,',
    '  0,0,0, 1,0,0;',
    '',
  ].join('\n');

  const read = (preserve = true) =>
    parseIdf(REFERENCED, v26, { strict: false, preserveFormatting: preserve }).document;

  it('yields nothing for a document nobody has edited', () => {
    expect([...read().changedObjects()]).toEqual([]);
  });

  it('yields every object a rename rewrote, not just the renamed one', () => {
    const document = read();
    document.rename(document.require('Zone', 'ZONE ONE'), 'RENAMED');

    expect([...document.changedObjects()].map((o) => o.typeName).sort()).toEqual([
      'BuildingSurface:Detailed',
      'BuildingSurface:Detailed',
      'Zone',
    ]);
  });

  it('yields nothing after a write of the value already held', () => {
    const document = read();
    const zone = document.require('Zone', 'ZONE ONE');
    zone.set('multiplier', zone.get('multiplier') ?? undefined);

    expect([...document.changedObjects()]).toEqual([]);
  });

  it('yields every object for a document read without preservation', () => {
    // There is nothing to reproduce, so a write rewrites the file entirely.
    const document = read(false);

    expect([...document.changedObjects()]).toHaveLength(document.size);
  });

  it('agrees with what the writer actually reproduces', () => {
    // The claim is only worth making if the writer honours it. After the rename, the three objects
    // it touched are named and the Version is not, so the Version must come back from its own
    // characters and the other three must not.
    const document = read();
    document.rename(document.require('Zone', 'ZONE ONE'), 'RENAMED');
    const written = writeIdf(document);
    const changed = [...document.changedObjects()];

    expect(changed.map((o) => o.typeName)).not.toContain('Version');
    expect(written).toContain('Version, 26.1;');
    // And every object it DID name was rewritten: none of them survives as its original text.
    expect(written).not.toContain('Zone, ZONE ONE;');
    expect(changed).toHaveLength(3);
  });
});

describe('what survives when the writer rewrites an object', () => {
  // An edit asks for the VALUES to be re-rendered. Everything else the author wrote is theirs, and
  // that includes the absence of a comment on a field they left bare.
  const SOURCE = [
    'Version, 26.1;',
    '',
    '! a note between objects',
    'Building,',
    '  My Building,   !- Name',
    '  ! this value came from the 2019 survey',
    '  0,             !- North Axis {deg}',
    '  Suburbs;',
    '',
    'Timestep, 6;',
    '',
  ].join('\n');

  const edited = (options = {}) => {
    const { document } = parseIdf(SOURCE, v26, { strict: false, preserveFormatting: true });
    document.require('Building', 'My Building').set('north_axis', 42);
    return writeIdf(document, options);
  };

  it('keeps a units annotation the generated label would drop', () => {
    expect(edited()).toContain('!- North Axis {deg}');
  });

  it('keeps a comment on its own line inside the object', () => {
    // The one comment nothing else carries: it is inside the object rather than between two, so
    // the gap does not reach it and reformatting destroyed it.
    expect(edited()).toContain('! this value came from the 2019 survey');
  });

  it('keeps a comment between two objects', () => {
    expect(edited()).toContain('! a note between objects');
  });

  it('leaves a field the author left bare bare', () => {
    // Absence is as much a thing the author wrote as the words are.
    const written = edited();

    expect(written).toMatch(/Suburbs;\s*$/m);
    expect(written).not.toContain('!- Terrain');
  });

  it('labels a bare field on request, and still costs no comment line', () => {
    const written = edited({ fieldComments: 'generate' });

    expect(written).toContain('!- Terrain');
    expect(written).toContain('! this value came from the 2019 survey');
    expect(written).toContain('! a note between objects');
    expect(written).toContain('!- North Axis {deg}');
  });

  it('changes the value and nothing else', () => {
    const written = edited();

    expect(written).toContain('42.0');
    expect(written).not.toContain('  0,');
  });

  it('attaches a comment by its delimiter, not by counting lines', () => {
    // Several fields share a line in real files: a surface's vertices are routinely written three
    // to a line with one comment for the triple. Counting lines mis-attaches every comment after
    // the first such line.
    const text = [
      'Version, 26.1;',
      '',
      'Building,',
      '  Packed, City, 0.04,   !- three fields, one comment',
      '  0.4;                  !- and another',
      '',
    ].join('\n');
    const { document } = parseIdf(text, v26, { strict: false, preserveFormatting: true });
    document.require('Building', 'Packed').set('terrain', 'Suburbs');

    const written = writeIdf(document);

    expect(written).toContain('!- three fields, one comment');
    expect(written).toContain('!- and another');
  });
});

describe('the line the author put a value on', () => {
  // 21.5% of the statements in the 693 EnergyPlus example files write several values to a line,
  // and 690 of those files contain at least one. Writing one value per line regardless turns a
  // four-line surface into twelve, which is the most visible thing a reformat does to geometry.
  const GROUPED = [
    'Version, 26.1;',
    '',
    'BuildingSurface:Detailed,',
    '  S1, Wall, C1, Z1, , Outdoors, , SunExposed, WindExposed, , ,',
    '  0, 0, 4.572,   !- X,Y,Z ==> Vertex 1 {m}',
    '  0, 0, 0;       !- X,Y,Z ==> Vertex 2 {m}',
    '',
  ].join('\n');

  it('keeps values the author grouped onto one line', () => {
    const { document } = parseIdf(GROUPED, v26, { strict: false, preserveFormatting: true });
    document.require('BuildingSurface:Detailed', 'S1').set('sun_exposure', 'NoSun');

    const written = writeIdf(document);

    expect(written.split('\n')).toHaveLength(GROUPED.split('\n').length);
    expect(written).toMatch(/0\.0, 0\.0, 4\.572,\s+!- X,Y,Z ==> Vertex 1 \{m\}/);
    expect(written).toMatch(/0\.0, 0\.0, 0\.0;\s+!- X,Y,Z ==> Vertex 2 \{m\}/);
  });

  it('keeps a whole object the author wrote on one line', () => {
    // The cheaper case, and the one that surprises on a file with no geometry in it: 11.3% of
    // statements are written this way, and nobody thinks of `Timestep,4;` as formatting they chose.
    const text = 'Version, 26.1;\n\nTimestep,4;\n';
    const { document } = parseIdf(text, v26, { strict: false, preserveFormatting: true });
    [...document.all('Timestep')][0]!.set('number_of_timesteps_per_hour', 6);

    const written = writeIdf(document);

    expect(written).toContain('Timestep,');
    expect(written.split('\n')).toHaveLength(text.split('\n').length);
  });

  it('gives a field the author never wrote a line of its own', () => {
    // No author to be faithful to, so the writer's own habit applies.
    const text = 'Version, 26.1;\n\nBuilding,\n  My Building;\n';
    const { document } = parseIdf(text, v26, { strict: false, preserveFormatting: true });
    document.require('Building', 'My Building').set('north_axis', 42);

    expect(writeIdf(document)).toMatch(/\n\s+42\.0;\s+!- North Axis/);
  });
});

describe('the fields the author wrote out as blanks', () => {
  // The writer stops at the last field that is SET, so a run of explicit commas the author wrote
  // is dropped and their field-name comments go with them. A single-field edit took one
  // Sizing:System from 38 lines to 22; across the 693 example files it is 20,571 lines, more than
  // any other difference a rewrite makes. A field written out as a blank is as much a thing the
  // author wrote as a field left bare of its comment, which is the rule this path already follows.
  const BLANKS = [
    'Version, 26.1;',
    '',
    'Building,',
    '  My Building,             !- Name',
    '  0.0,                     !- North Axis {deg}',
    '  ,                        !- Terrain',
    '  ,                        !- Loads Convergence Tolerance Value',
    '  ,                        !- Temperature Convergence Tolerance Value',
    '  ;                        !- Solar Distribution',
    '',
  ].join('\n');

  it('keeps them, and their comments, through an edit', () => {
    const { document } = parseIdf(BLANKS, v26, { strict: false, preserveFormatting: true });
    document.require('Building', 'My Building').set('north_axis', 42);

    const written = writeIdf(document);

    expect(written.split('\n')).toHaveLength(BLANKS.split('\n').length);
    expect(written).toContain('!- Terrain');
    expect(written).toContain('!- Solar Distribution');
  });

  it('still trims them where there is no author to be faithful to', () => {
    // A document read without preservation has nothing to reproduce, so the ordinary writer's
    // habit applies and a run of bare commas stays out of the output.
    const { document } = parseIdf(BLANKS, v26, { strict: false });

    expect(writeIdf(document)).not.toContain('!- Solar Distribution');
  });
});

describe('the column the comment goes in', () => {
  it('puts the marker where EnergyPlus puts it, so a rewrite leaves no seam', () => {
    // `1ZoneUncontrolled.idf` writes `!-` at index 29 on 223 of its 231 commented lines. The
    // option is a COLUMN, counted from 1, and was being applied as an index.
    const text = 'Version, 26.1;\n\nBuilding,\n  My Building,\n  0.0;\n';
    const { document } = parseIdf(text, v26, { strict: false, preserveFormatting: true });
    document.require('Building', 'My Building').set('north_axis', 42);

    for (const line of writeIdf(document).split('\n')) {
      const marker = line.indexOf('!-');
      if (marker > 0) expect(marker).toBe(29);
    }
  });
});

describe('where an object\'s characters were', () => {
  // `changedObjects()` says WHICH objects a write will rewrite. Without saying WHERE the old ones
  // are, a consumer building the smallest possible change has to write the whole file and diff it,
  // which is the work that method exists to avoid. Found by the language server team reading the
  // branch before it merged.
  const TEXT = [
    'Version, 26.1;',
    '',
    'Building,',
    '  My Building,   !- Name',
    '  0.0;           !- North Axis {deg}',
    '',
    'Timestep, 4;',
    '',
  ].join('\n');

  const read = () => parseIdf(TEXT, v26, { strict: false, preserveFormatting: true }).document;

  it('locates an object that has not changed', () => {
    const document = read();
    const at = document.regionOf(document.require('Building', 'My Building'))!;

    expect(document.rawText!.slice(at.start, at.end)).toBe(
      'Building,\n  My Building,   !- Name\n  0.0;           !- North Axis {deg}'
    );
  });

  it('still locates it after it changes, which is the case it is for', () => {
    // The objects worth locating are the ones being rewritten, and `SOURCE` is cleared the moment
    // one is touched because its absence is what marks it. A second record answers this.
    const document = read();
    const building = document.require('Building', 'My Building');
    const before = document.regionOf(building);
    building.set('north_axis', 42);

    expect(document.regionOf(building)).toEqual(before);
    expect([...document.changedObjects()]).toContain(building);
  });

  it('reaches past the semicolon to the comment the writer replaces', () => {
    // Not `statement.region`, which stops at the terminator. A comment on the terminator's own line
    // is that statement's last field's comment and a preserving write rewrites it; a consumer
    // replacing the shorter range would leave it behind describing a field that had just moved.
    const document = read();
    const at = document.regionOf(document.require('Building', 'My Building'))!;

    expect(document.rawText!.slice(at.start, at.end)).toContain('!- North Axis {deg}');
  });

  it('answers nothing for an object added since the read', () => {
    const document = read();
    const added = document.addRaw('Zone', 'Late Arrival', {});

    expect(document.regionOf(added)).toBeUndefined();
  });

  it('answers nothing for a document read without preservation', () => {
    const document = parseIdf(TEXT, v26, { strict: false }).document;

    expect(document.regionOf(document.require('Building', 'My Building'))).toBeUndefined();
  });

  it('locates each object separately, in source order', () => {
    const document = read();
    const regions = [...document.objects()]
      .map((obj) => document.regionOf(obj))
      .filter((region) => region !== undefined);

    expect(regions).toHaveLength(3);
    for (let i = 1; i < regions.length; i += 1) {
      expect(regions[i]!.start).toBeGreaterThanOrEqual(regions[i - 1]!.end);
    }
  });
});

describe('the text that belongs in that range', () => {
  // The third leg. Knowing WHICH objects change and WHERE the old text is buys a consumer nothing
  // while producing the new text for ONE object has no correct form: `writeObject` called with
  // options built by hand comes back with the author's units as generated labels, because the
  // annotations a preserving write hands it are internal.
  const TEXT = [
    'Version, 26.1;',
    '',
    'Building,',
    '  My Building,   !- Name',
    '  0.0;           !- North Axis {deg}',
    '',
    'Timestep, 4;',
    '',
  ].join('\n');

  const read = () => parseIdf(TEXT, v26, { strict: false, preserveFormatting: true }).document;

  it('keeps the unit that the ordinary per-object writer drops', () => {
    const document = read();
    const building = document.require('Building', 'My Building');
    building.set('north_axis', 42);

    expect(document.renderObject(building)).toContain('!- North Axis {deg}');
    // What a consumer would have had to reach for, and what it costs.
    expect(writeObject(building, { comments: true, commentColumn: 30, indent: '    ' })).not.toContain(
      '{deg}'
    );
  });

  it('splices into its own range to give back exactly what a whole write gives back', () => {
    // The claim the three names make together, pinned as one assertion. If this ever fails, an
    // editor built on them is silently writing a different file from the one `writeIdf` writes.
    const document = read();
    document.require('Building', 'My Building').set('north_axis', 42);
    [...document.all('Timestep')][0]!.set('number_of_timesteps_per_hour', 6);

    let spliced = document.rawText!;
    // Back to front, so an earlier edit does not move a later range.
    const changed = [...document.changedObjects()]
      .map((obj) => ({ at: document.regionOf(obj)!, text: document.renderObject(obj)! }))
      .sort((a, b) => b.at.start - a.at.start);
    expect(changed).toHaveLength(2);
    for (const { at, text } of changed) {
      spliced = spliced.slice(0, at.start) + text + spliced.slice(at.end);
    }

    expect(spliced).toBe(writeIdf(document));
  });

  it('takes the one option a preserving write honours, and no others', () => {
    // `indent`, `commentColumn`, `ordering` and `versionFirst` are refused by `writeIdf` alongside
    // `preserveFormatting`; `comments: false` and `compressed` defeat preservation entirely and
    // send the document down the formatting path. Accepting any of them here would render one
    // object on terms the surrounding file was not written on.
    // A source with a field the author wrote BARE, which is what the option is about.
    const bare = 'Version, 26.1;\n\nBuilding,\n  My Building,   !- Name\n  0.0,           !- North Axis {deg}\n  City;\n';
    const { document } = parseIdf(bare, v26, { strict: false, preserveFormatting: true });
    const building = document.require('Building', 'My Building');
    building.set('north_axis', 42);

    // Bare stays bare, and asking for labels is the one thing that changes.
    expect(document.renderObject(building)).not.toContain('!- Terrain');
    expect(document.renderObject(building, { fieldComments: 'generate' })).toContain('!- Terrain');
  });

  it('ends where the range ends, with no line break of its own', () => {
    const document = read();

    expect(document.renderObject(document.require('Building', 'My Building'))).not.toMatch(/\n$/);
  });

  it('answers nothing for an object the retained source does not hold', () => {
    const document = read();

    expect(document.renderObject(document.addRaw('Zone', 'Late Arrival', {}))).toBeUndefined();
    expect(parseIdf(TEXT, v26, { strict: false }).document.renderObject(
      parseIdf(TEXT, v26, { strict: false }).document.require('Building', 'My Building')
    )).toBeUndefined();
  });
});
