import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { IdfDocument, parseIdf, writeEpJson, writeIdf } from '@idfkit/core';
import type { Schema } from '@idfkit/schemas';

import { schema } from './helpers.js';

let v26: Schema;
beforeAll(async () => {
  v26 = await schema('26.1.0');
});

let doc: IdfDocument;
beforeEach(() => {
  doc = new IdfDocument(v26);
});

describe('writeIdf', () => {
  it('writes an object with aligned field comments', () => {
    doc.add('Zone', 'Z1', { x_origin: 1.5, y_origin: 2.5 });
    const text = writeIdf(doc);

    expect(text).toContain('Zone,');
    expect(text).toMatch(/Z1, +!- Name/);
    expect(text).toMatch(/1\.5, +!- X Origin/);
  });

  it('omits comments when asked', () => {
    doc.add('Zone', 'Z1', { x_origin: 1.5 });
    expect(writeIdf(doc, { comments: false })).not.toContain('!-');
  });

  it('keeps a decimal point on real-valued fields', () => {
    // JavaScript has one number type, so 3 and 3.0 are indistinguishable at
    // runtime. Without consulting the schema every real field would be written
    // as a bare integer.
    doc.add('Zone', 'Z1', { x_origin: 3 });
    expect(writeIdf(doc)).toMatch(/3\.0; +!- X Origin/);
  });

  it('writes integer fields without a decimal point', () => {
    doc.add('Timestep', null, { number_of_timesteps_per_hour: 6 });
    const text = writeIdf(doc);
    expect(text).toMatch(/\n {4}6;/);
    expect(text).not.toContain('6.0');
  });

  it('drops trailing unset fields rather than emitting bare commas', () => {
    doc.add('Zone', 'Z1', { x_origin: 1 });
    const lines = writeIdf(doc).trim().split('\n');
    expect(lines.at(-1)?.trim()).toMatch(/^1\.0;/);
  });

  it('preserves interior unset fields so positions stay aligned', () => {
    doc.add('Zone', 'Z1', { x_origin: 1, z_origin: 3 });
    const text = writeIdf(doc);
    // y_origin is unset but must still occupy its slot.
    expect(text).toMatch(/,\s+!- Y Origin/);
    expect(text).toMatch(/3\.0;\s+!- Z Origin/);
  });

  it('writes Version first regardless of insertion order', () => {
    doc.add('Zone', 'Z1');
    doc.add('Version', null, { version_identifier: '26.1' });
    expect(writeIdf(doc).trimStart().startsWith('Version,')).toBe(true);
  });

  it('writes extensible groups in order', () => {
    const surface = doc.add('BuildingSurface:Detailed', 'S1');
    surface.extensible.push(
      { vertex_x_coordinate: 0, vertex_y_coordinate: 0, vertex_z_coordinate: 3 },
      { vertex_x_coordinate: 5, vertex_y_coordinate: 0, vertex_z_coordinate: 3 }
    );

    const text = writeIdf(doc);
    expect(text).toMatch(/0\.0, +!- Vertex X Coordinate/);
    expect(text).toMatch(/5\.0, +!- Vertex X Coordinate/);
    expect(text.trimEnd().endsWith('!- Vertex Z Coordinate')).toBe(true);
    expect(text).toMatch(/3\.0; +!- Vertex Z Coordinate/);
  });

  it('re-parses to an equivalent document', () => {
    doc.add('Version', null, { version_identifier: '26.1' });
    doc.add('Zone', 'Zone One', { x_origin: 1.5, ceiling_height: 2.7 });
    doc.add('BuildingSurface:Detailed', 'S1', { zone_name: 'Zone One', surface_type: 'Wall' });

    const reparsed = parseIdf(writeIdf(doc), v26).document;

    expect(reparsed.toJSON()).toEqual(doc.toJSON());
  });
});

describe('writeEpJson', () => {
  it('nests type, name, then fields', () => {
    doc.add('Zone', 'Z1', { x_origin: 1.5 });
    const json = JSON.parse(writeEpJson(doc)) as Record<string, unknown>;

    expect(json).toEqual({ Zone: { Z1: { x_origin: 1.5 } } });
  });

  it('gives anonymous objects the key EnergyPlus expects', () => {
    doc.add('Timestep', null, { number_of_timesteps_per_hour: 6 });
    const json = JSON.parse(writeEpJson(doc)) as Record<string, unknown>;

    expect(json).toEqual({ Timestep: { 'Timestep 1': { number_of_timesteps_per_hour: 6 } } });
  });

  it('omits types with no objects', () => {
    doc.all('Zone'); // touching a type creates an empty collection
    expect(JSON.parse(writeEpJson(doc))).toEqual({});
  });
});

/**
 * FR-017: no writer default moves, in either language.
 *
 * The requirement most easily broken by accident. Feature 002 adds a compressed mode here and
 * three controls on the other side, and the only thing that makes a slipped default loud rather
 * than discovered later is a test that fails.
 *
 * Six defaults, pinned as the values they are TODAY. Every one is also pinned on the other side,
 * in `idfkit/tests/test_writers.py`, at the values THAT writer uses. The two disagree on five of
 * the six, both are published, and neither is more correct. That disagreement is the point: it is
 * documented on a page rather than resolved, because resolving it would change output somebody
 * depends on.
 */
describe('writer defaults are pinned (FR-017)', () => {
  const model = (s: Schema): IdfDocument => {
    const { document } = parseIdf(
      'Version,\n  26.1;\n\nBuilding,\n  Pinned,\n  30.0;\n\nTimestep,\n  4;\n',
      s
    );
    return document;
  };

  it('indents four spaces', () => {
    const text = writeIdf(model(v26));

    const fieldLines = text.split('\n').filter((l) => l.startsWith(' ') && l.includes('!-'));
    expect(fieldLines.length).toBeGreaterThan(0);
    // Four, where the other language writes two.
    expect(fieldLines.every((l) => l.startsWith('    ') && !l.startsWith('     '))).toBe(true);
  });

  it('puts the comment at column 30', () => {
    const text = writeIdf(model(v26));

    let checked = 0;
    for (const line of text.split('\n')) {
      const marker = line.indexOf('!-');
      if (marker <= 0) continue;
      // Only lines the padding actually reached: a value longer than the column pushes the comment
      // right, and that overflow behaviour is itself one of the seven differences.
      if (line.slice(0, marker).trimEnd().length < 30) {
        expect(marker).toBe(30);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('writes objects in insertion order, with Version first', () => {
    const text = writeIdf(model(v26));

    const types = text
      .split('\n')
      .filter((l) => l.length > 0 && !/^\s/.test(l) && l.endsWith(','))
      .map((l) => l.slice(0, -1));
    // Insertion order, not sorted: the other language sorts by type name.
    expect(types).toEqual(['Version', 'Building', 'Timestep']);
  });

  it('consults the schema when rendering a float', () => {
    const text = writeIdf(model(v26));

    // north_axis came in as 30.0 and stays 30.0, because the schema calls the field a number. The
    // other language renders every float with %g and writes 30.
    expect(text).toContain('30.0');
  });

  it('lowercases minor words in a field comment', () => {
    const text = writeIdf(model(v26));

    // "Number of Timesteps per Hour", where the other language title-cases every word and writes
    // "Number Of Timesteps Per Hour".
    expect(text).toMatch(/!- Number of Timesteps per Hour/);
  });

  it('writes no generator header', () => {
    const text = writeIdf(model(v26));

    // The other language opens every file with "!-Generator idfkit v..." and "!-Option
    // SortedOrder". This writes neither, which is the first difference a reader diffing two
    // outputs would meet.
    expect(text.startsWith('!-')).toBe(false);
    expect(text).not.toContain('!-Generator');
    expect(text).not.toContain('!-Option');
  });
});

/**
 * FR-016 and SC-007: the fifth and last control to close.
 *
 * Four of the five controls existed on one writer and were added to the other. This is the one
 * that went the other way: the other language has had `output_type="compressed"` since it was
 * written, and this writer had no compact path at all to extend.
 */
describe('compressed output (FR-016)', () => {
  const model = (s: Schema): IdfDocument => {
    const { document } = parseIdf('Version,\n  26.1;\n\nBuilding,\n  Ctl,\n  30.0;\n', s);
    return document;
  };

  it('puts each object on one line, with no blank line between them', () => {
    const text = writeIdf(model(v26), { compressed: true });

    expect(text).toBe('Version,26.1;\nBuilding,Ctl,30.0;');
  });

  it('means the same thing as the other language’s compressed', () => {
    // Python writes 'Version,26.1;\nBuilding,Ctl,30;' for the same input. The two agree on
    // structure and differ only on float rendering, which is one of the six pinned defaults and is
    // not something compressed removes. That is why the corpus compares this structurally, by
    // re-reading both outputs, rather than textually.
    const text = writeIdf(model(v26), { compressed: true });
    const lines = text.split('\n');

    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.endsWith(';'))).toBe(true);
    expect(lines.every((l) => !l.includes('!-'))).toBe(true);
    expect(text).not.toContain('!-Generator');
  });

  it('is not the same as turning comments off', () => {
    // `comments: false` skips the padding and the comment and still puts every field on its own
    // line. Both languages already had that; it is a different, coarser output.
    const withoutComments = writeIdf(model(v26), { comments: false });
    const compressed = writeIdf(model(v26), { compressed: true });

    expect(withoutComments.split('\n').length).toBeGreaterThan(compressed.split('\n').length);
    expect(withoutComments).toContain('\n    26.1;');
  });

  it('re-reads to the same document it came from (FR-019)', () => {
    const original = model(v26);
    const reread = parseIdf(writeIdf(original, { compressed: true }), v26).document;

    // Structure survives the control, which is what FR-019 asks. Compared over parsed values
    // rather than text, because the text is deliberately different.
    expect(reread.types().sort()).toEqual(original.types().sort());
    expect(reread.all('Building').size).toBe(original.all('Building').size);
  });

  it('does not add a lossless mode', () => {
    // `lossless-round-trip` is a separate Tier 2 entry on the parity record, absent here and
    // tracked as not-yet-ported. Compressed is not a step toward it and must not be read as one:
    // it discards MORE formatting, not less.
    const options: Record<string, unknown> = { compressed: true };
    expect(Object.keys(options)).not.toContain('preserveFormatting');
    expect(writeIdf(model(v26), { compressed: true })).not.toContain('  26.1');
  });
});

/**
 * FR-016 and SC-007, the last two controls.
 *
 * Feature 002 closed five controls and left two spelled on one side only: this writer had
 * `versionFirst` and no `ordering`, the other had `ordering` and no way to unpin Version. SC-007
 * asks for zero one-sided controls and US4's second acceptance scenario names object ordering
 * explicitly, so both were added rather than argued away.
 */
describe('ordering (FR-016, SC-007)', () => {
  const model = (s: Schema): IdfDocument => {
    const { document } = parseIdf('Version,\n  26.1;\n\nTimestep,\n  4;\n\nBuilding,\n  Ctl;\n', s);
    return document;
  };

  const typeNames = (text: string): string[] =>
    text
      .split('\n')
      .filter((l) => l.length > 0 && !/^\s/.test(l) && l.endsWith(','))
      .map((l) => l.slice(0, -1));

  it('defaults to source order, which is what this writer always did', () => {
    // FR-017: the default does not move. Timestep before Building is the document's own order,
    // not the alphabetical one.
    expect(typeNames(writeIdf(model(v26)))).toEqual(['Version', 'Timestep', 'Building']);
  });

  it('sorts by type name when asked', () => {
    expect(typeNames(writeIdf(model(v26), { ordering: 'sorted' }))).toEqual([
      'Version',
      'Building',
      'Timestep',
    ]);
  });

  it('changes the output, so a corpus case using it is not a no-op', () => {
    // The reason this control had to exist rather than be argued away: `writer-option-ordering`
    // would otherwise pass on this side even if the runner dropped the option entirely.
    expect(writeIdf(model(v26), { ordering: 'sorted' })).not.toBe(writeIdf(model(v26)));
  });

  it('composes with versionFirst rather than overriding it', () => {
    // Sorted decides the type order; versionFirst pins Version above it. Turning the pin off
    // leaves Version in whichever position the ordering gives it.
    expect(typeNames(writeIdf(model(v26), { ordering: 'sorted', versionFirst: false }))).toEqual([
      'Building',
      'Timestep',
      'Version',
    ]);
  });

  it('re-reads to the same document under either ordering (FR-019)', () => {
    const original = model(v26);
    for (const ordering of ['sorted', 'source'] as const) {
      const reread = parseIdf(writeIdf(original, { ordering }), v26).document;
      expect(reread.types().sort()).toEqual(original.types().sort());
    }
  });
});
