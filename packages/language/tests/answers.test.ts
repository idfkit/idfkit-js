import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { describeObjectType, docsUrlForObject, parseIdf } from '@idfkit/core';
import type { IdfDocument, ProsePool, Schema } from '@idfkit/core';

import { prose as loadProse, schema } from '../../core/tests/helpers.js';
import { completionsAt } from '../src/complete.js';
import { declarationAt } from '../src/declaration.js';
import { explainAt } from '../src/explain.js';

let v26: Schema;
beforeAll(async () => {
  v26 = await schema('26.1.0');
});

/**
 * One model carrying every shape the three answers have to distinguish.
 *
 * Written out here rather than taken from the syntax fixtures because those exist to carry
 * malformations, and these tests are about what the schema says when the text is ordinary. It
 * carries, deliberately: a choice field, a reference field pointing into a list two types declare
 * into, a value the model declares nowhere, a type name containing a colon, values containing
 * spaces, and a free-text field holding a string that is a declared name somewhere else.
 */
const model = [
  'Version, 26.1;',
  '',
  'Material,',
  '  Insulation Board,        !- Name',
  '  VeryRough,               !- Roughness',
  '  0.1,                     !- Thickness {m}',
  '  0.5,                     !- Conductivity {W/m-K}',
  '  100,                     !- Density {kg/m3}',
  '  900;                     !- Specific Heat {J/kg-K}',
  '',
  'Material:NoMass,',
  '  Air Gap,                 !- Name',
  '  Smooth,                  !- Roughness',
  '  0.15;                    !- Thermal Resistance {m2-K/W}',
  '',
  'Construction,',
  '  Exterior Wall,           !- Name',
  '  Insulation Board,        !- Outside Layer',
  '  Air Gap;                 !- Layer 2',
  '',
  'Construction,',
  '  Ghost Wall,              !- Name',
  '  No Such Material;        !- Outside Layer',
  '',
  'Zone,',
  '  Office Zone 1,           !- Name',
  '  0.0,                     !- Direction of Relative North',
  '  0.0,                     !- X Origin',
  '  0.0,                     !- Y Origin',
  '  0.0;                     !- Z Origin',
  '',
  'BuildingSurface:Detailed,',
  '  South Wall,              !- Name',
  '  Wall,                    !- Surface Type',
  '  Exterior Wall,           !- Construction Name',
  '  Office Zone 1,           !- Zone Name',
  '  ,                        !- Space Name',
  '  Outdoors,                !- Outside Boundary Condition',
  '  ,                        !- Outside Boundary Condition Object',
  '  SunExposed,              !- Sun Exposure',
  '  WindExposed,             !- Wind Exposure',
  '  0.5,                     !- View Factor to Ground',
  '  4,                       !- Number of Vertices',
  '  0.0, 0.0, 3.0,           !- Vertex 1',
  '  4.0, 0.0, 3.0,           !- Vertex 2',
  '  4.0, 0.0, 0.0,           !- Vertex 3',
  '  0.0, 0.0, 0.0;           !- Vertex 4',
  '',
  'Output:Variable,',
  '  Exterior Wall,           !- Key Value',
  '  Zone Mean Air Temperature,  !- Variable Name',
  '  Hourly;                  !- Reporting Frequency',
  '',
].join('\n');

let document: IdfDocument;
beforeAll(() => {
  document = parseIdf(model, v26, { strict: false }).document;
});

/**
 * Offset of the first character of the value written on the line carrying `comment`.
 *
 * Every test here is about a position, and `text.indexOf('0.1') + 1` hides which field was meant.
 * Naming the line by its trailing comment is how a reader of the fixture finds the same place.
 */
function valueOn(text: string, comment: string, from = 0): number {
  const marker = text.indexOf(comment, from);
  if (marker < 0) throw new Error(`no line carries the comment ${JSON.stringify(comment)}`);
  const lineStart = text.lastIndexOf('\n', marker) + 1;
  const value = /\S/.exec(text.slice(lineStart, marker));
  if (value === null) throw new Error(`nothing is written on the ${comment} line`);
  return lineStart + value.index;
}

/** Offset one character into the type name of the statement that opens with `written`. */
function typeNameIn(text: string, written: string, from = 0): number {
  const found = text.indexOf(written, from);
  if (found < 0) throw new Error(`fixture does not contain ${JSON.stringify(written)}`);
  return found + 1;
}

/** What the text says between two offsets, which is what a region is asserted through. */
function sliced(text: string, region: { readonly start: number; readonly end: number }): string {
  return text.slice(region.start, region.end);
}

// ---------------------------------------------------------------------------
// completionsAt
// ---------------------------------------------------------------------------

describe('completionsAt, on a choice field', () => {
  it('offers exactly the schema list for that field, and nothing else', () => {
    // SC-006, and the reason the expectation is read out of the schema rather than written here: a
    // hand-written list is a second copy of schema knowledge, and it would keep passing while the
    // code offered the neighbouring field's values or a stale set from an older version.
    const roughness = v26.get('Material')?.p['roughness'];
    expect(roughness?.e).toBeDefined();
    // No blank branch on this field, so the schema's list is `e` exactly. A field carrying `eb`
    // declares a blank the bundle filtered out, and the comparison would then need it back.
    expect(roughness?.eb).toBeUndefined();

    const result = completionsAt(model, valueOn(model, '!- Roughness'), v26);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.offers.map((offer) => offer.value)).toEqual([...roughness!.e!]);
    for (const offer of result.offers) {
      expect(offer.kind).toBe('enumValue');
      expect(offer.required).toBe((v26.get('Material')?.r ?? []).includes('roughness'));
      // No pool was supplied, so no prose is hydrated. FR-028, asserted in full below.
      expect(offer.prose).toBeUndefined();
    }
  });
});

describe('completionsAt, on a reference field', () => {
  it('offers the names declared into the lists the field points into', () => {
    // The list comes from the schema, and the names come from the caller's document: two types
    // declare into `MaterialName` here, and both are offered, because a `Material:NoMass` is as
    // good a layer as a `Material`.
    expect(v26.get('Construction')?.p['outside_layer']?.ol).toEqual(['MaterialName']);

    const result = completionsAt(model, valueOn(model, '!- Outside Layer'), v26, { document });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.offers.map((offer) => offer.value)).toEqual(['Insulation Board', 'Air Gap']);
    expect(result.offers.every((offer) => offer.kind === 'referenceTarget')).toBe(true);
  });

  it('offers the zone names for a zone field, and not every name in the model', () => {
    const result = completionsAt(model, valueOn(model, '!- Zone Name'), v26, { document });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.offers.map((offer) => offer.value)).toEqual(['Office Zone 1']);
  });

  it('offers none and says so when no document was supplied, rather than parsing one', () => {
    // Research R9: a service that quietly parsed a document when the argument was omitted would
    // make one function on the keystroke path eighty milliseconds slower depending on an argument
    // nobody passed. `'notApplicable'` says the answer is unavailable; an empty `'ok'` list would
    // say the model has declared nothing, which is false here and is the state below.
    const result = completionsAt(model, valueOn(model, '!- Outside Layer'), v26);

    expect(result).toEqual({ status: 'notApplicable' });
  });

  it('reports an empty offer list when the document really declares nothing', () => {
    const empty = parseIdf('Version, 26.1;\n', v26, { strict: false }).document;
    const result = completionsAt(model, valueOn(model, '!- Outside Layer'), v26, {
      document: empty,
    });

    expect(result).toEqual({ status: 'ok', offers: [] });
  });
});

describe('completionsAt, where the schema constrains nothing', () => {
  it('returns unconstrained for a numeric field rather than an empty list', () => {
    // FR-020 and FR-031: "the schema permits anything here" is a different answer from "there is
    // nothing to offer", and an editor that rendered an empty list for both would teach the reader
    // that the tool is broken.
    const result = completionsAt(model, valueOn(model, '!- Thickness'), v26);

    expect(result).toEqual({ status: 'unconstrained' });
  });

  it('returns unconstrained for a free-text name field', () => {
    const result = completionsAt(model, valueOn(model, '!- Name'), v26);

    expect(result).toEqual({ status: 'unconstrained' });
  });
});

/**
 * SC-018 and FR-048: every offer carries the region it stands in for.
 *
 * Checked against the two shapes an editor's own word rules get wrong, because those are the ones a
 * consumer would get wrong if it derived the span itself: a type name is split at its colon, and a
 * value is split at its spaces. The region is sliced out of the text and compared to the characters
 * it should select, so a failure reads as the wrong word rather than as two numbers.
 */
describe('every offer carries the region it replaces', () => {
  it('replaces a whole type name, colon included', () => {
    const result = completionsAt(model, typeNameIn(model, 'Material:NoMass,'), v26);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.offers.length).toBeGreaterThan(0);
    for (const offer of result.offers) {
      expect(sliced(model, offer.replaces)).toBe('Material:NoMass');
      expect(offer.kind).toBe('objectType');
    }
    // The shape being guarded against is really in the list, so this cannot pass on a schema of
    // single-word names.
    expect(result.offers.some((offer) => offer.value.includes(':'))).toBe(true);
  });

  it('replaces a whole value, spaces included', () => {
    const result = completionsAt(model, valueOn(model, '!- Zone Name'), v26, { document });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.offers.length).toBeGreaterThan(0);
    for (const offer of result.offers) {
      expect(sliced(model, offer.replaces)).toBe('Office Zone 1');
    }
  });

  it('replaces a whole choice value, from a cursor part way through it', () => {
    const written = valueOn(model, '!- Roughness');
    const result = completionsAt(model, written + 4, v26);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    for (const offer of result.offers) {
      expect(sliced(model, offer.replaces)).toBe('VeryRough');
    }
  });

  it('replaces nothing where a statement has not been written yet', () => {
    // An insertion rather than a replacement, and an empty region at the cursor is how that is
    // said. A consumer applying an offer here inserts at the caret and disturbs no text.
    const text = `${model}\n`;
    const result = completionsAt(text, text.length, v26);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    for (const offer of result.offers) {
      expect(offer.replaces).toEqual({ start: text.length, end: text.length });
    }
  });
});

// ---------------------------------------------------------------------------
// explainAt
// ---------------------------------------------------------------------------

describe('explainAt, on a field', () => {
  it("reports the schema's own facts for the field, and not a paraphrase of them", () => {
    const result = explainAt(model, valueOn(model, '!- Thickness'), v26);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const { explanation } = result;

    expect(explanation.of).toBe('field');
    expect(explanation.typeName).toBe('Material');
    expect(explanation.fieldName).toBe('thickness');
    expect(sliced(model, explanation.region)).toBe('0.1');
    // FR-029: exactly what `describeObjectType` produces, member for member, rather than a second
    // reading of the same bundle that could drift from the reference page.
    expect(explanation.field).toEqual(
      describeObjectType(v26, 'Material').fields.find((field) => field.name === 'thickness')
    );
    // Named individually as well, so the comparison above cannot pass by both sides being empty.
    expect(explanation.field?.fieldType).toBe('number');
    expect(explanation.field?.units).toBe('m');
    expect(explanation.field?.required).toBe(true);
    expect(explanation.field?.exclusiveMinimum).toBe(0);
  });

  it('reports the permitted values of a choice field', () => {
    const result = explainAt(model, valueOn(model, '!- Roughness'), v26);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.explanation.field?.enumValues).toEqual([
      ...v26.get('Material')!.p['roughness']!.e!,
    ]);
  });

  it('reports the default a field carries', () => {
    const result = explainAt(model, valueOn(model, '!- Direction of Relative North'), v26);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.explanation.fieldName).toBe('direction_of_relative_north');
    expect(result.explanation.field?.default).toBe(0);
    expect(result.explanation.field?.units).toBe('deg');
  });

  it("reports the field's own prose when the caller supplied a pool", async () => {
    const pool = await loadProse();
    const result = explainAt(model, valueOn(model, '!- Zone Name'), v26, pool);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.explanation.prose).toBe(result.explanation.field?.note);
    expect(result.explanation.prose).toEqual(expect.any(String));
  });
});

describe('explainAt, on a type name', () => {
  it("reports the type's prose and the manual location", async () => {
    const pool = await loadProse();
    const result = explainAt(model, typeNameIn(model, 'Material,'), v26, pool);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const { explanation } = result;

    expect(explanation.of).toBe('objectType');
    expect(explanation.typeName).toBe('Material');
    expect(explanation.fieldName).toBeUndefined();
    expect(explanation.field).toBeUndefined();
    expect(sliced(model, explanation.region)).toBe('Material');
    expect(explanation.prose).toBe(describeObjectType(v26, 'Material', pool).memo);
    expect(explanation.prose).toEqual(expect.any(String));
    // FR-029 again: the manual location is `docsUrlForObject`'s answer and not a URL assembled
    // here, so a documentation move is one change rather than two.
    expect(explanation.docs).toEqual(docsUrlForObject('Material', v26.version, v26));
    expect(explanation.docs).toBeDefined();
  });
});

describe('explainAt, with no prose pool', () => {
  /** Every string the value carries, however deeply, which is what FR-022 is asserted over. */
  function stringsIn(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(stringsIn);
    if (value !== null && typeof value === 'object') {
      return Object.values(value).flatMap(stringsIn);
    }
    return [];
  }

  it('reports the structural facts and no prose at all', () => {
    const result = explainAt(model, valueOn(model, '!- Thickness'), v26);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.explanation.prose).toBeUndefined();
    expect(result.explanation.field?.note).toBeUndefined();
    // The facts are still there. An explanation that reported nothing would satisfy the assertion
    // above and would be useless.
    expect(result.explanation.field?.units).toBe('m');
  });

  it('never derives a sentence from the field name', () => {
    // FR-022 forbids this by name, which is why it is asserted by name. The only strings an
    // explanation may spell the field with are the two that ARE its name; anything else carrying
    // it is text made up from the spelling, which is the failure this exists to catch.
    const result = explainAt(model, valueOn(model, '!- Thickness'), v26);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const { explanation } = result;

    const spelled = stringsIn(explanation).filter(
      (value) => value !== explanation.fieldName && value !== explanation.field?.name
    );
    expect(spelled.length).toBeGreaterThan(0);
    for (const value of spelled) {
      expect(value.toLowerCase()).not.toContain('thickness');
    }
  });
});

describe('explainAt, where there is nothing to explain', () => {
  it('reports notApplicable on the whitespace beside a value', () => {
    // Reporting the nearest field here is the behaviour that makes a hover feel haunted (FR-049).
    const written = valueOn(model, '!- Roughness');
    const result = explainAt(model, written + 'VeryRough,'.length + 2, v26);

    expect(result).toEqual({ status: 'notApplicable' });
  });

  it('reports notApplicable on a separator', () => {
    const written = valueOn(model, '!- Roughness');
    expect(model[written + 'VeryRough'.length]).toBe(',');

    expect(explainAt(model, written + 'VeryRough'.length, v26)).toEqual({
      status: 'notApplicable',
    });
  });

  it('reports notApplicable on the blank line between two statements', () => {
    const blank = model.indexOf('\n\nMaterial:NoMass');

    expect(explainAt(model, blank + 1, v26)).toEqual({ status: 'notApplicable' });
  });

  it('reports notApplicable inside a comment', () => {
    expect(explainAt(model, model.indexOf('!- Thickness') + 3, v26)).toEqual({
      status: 'notApplicable',
    });
  });
});

/**
 * FR-028: a caller who never supplies the pool loads none of it.
 *
 * Fenced the way `check-bundle-purity.mjs` fences the schema data it is about: not by measuring how
 * much prose came back, but by establishing that the thing which loads it never enters the graph at
 * all. The pool is a plain array the caller reads for itself, through `@idfkit/schemas`'s bundle
 * source, and this package cannot reach one unless a module here imports something that reads
 * bytes. So the static half asserts that none of them does, and the behavioural half asserts that
 * nothing is hydrated when no pool arrives, with the control that makes both able to fail.
 */
describe('the prose pool stays the caller to load', () => {
  const sourceDir = fileURLToPath(new URL('../src/', import.meta.url));
  const sources = readdirSync(sourceDir)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => ({ name: entry, text: readFileSync(`${sourceDir}${entry}`, 'utf8') }));

  it('has sources to read, so the checks below are not vacuous', () => {
    expect(sources.map((source) => source.name)).toContain('explain.ts');
  });

  it.each(sources)('imports nothing that could read the pool, in $name', ({ text }) => {
    // The two ways bytes reach a module here: Node's own file reading, and either package's `/node`
    // entry point, which is where every reader in this repository lives. Neither may appear.
    expect(text).not.toMatch(/from '(node:[a-z/]+|@idfkit\/[a-z]+\/node)'/);
  });

  it.each(sources)('names ProsePool as a type alone, in $name', ({ text }) => {
    // A value import of the pool's declaring module would pull the loader in behind it. As a type
    // it is erased entirely, so the parameter can be named without anything being reachable.
    for (const statement of text.match(/import[\s\S]*?from '[^']+';/g) ?? []) {
      if (!statement.includes('ProsePool')) continue;
      expect(statement).toMatch(/\btype ProsePool\b/);
    }
  });

  it('hydrates no prose anywhere when no pool is supplied', () => {
    let explained = 0;
    for (let offset = 0; offset <= model.length; offset += 1) {
      const result = explainAt(model, offset, v26);
      if (result.status !== 'ok') continue;
      explained += 1;
      expect(result.explanation.prose).toBeUndefined();
      expect(result.explanation.field?.note).toBeUndefined();
    }
    // Several hundred of this model's offsets are on a type name or a value; the rest are on
    // padding, comments and separators. A sweep that explained none of them would be a broken
    // sweep rather than a clean one, so the count is asserted rather than assumed.
    expect(explained).toBeGreaterThan(100);

    const offers = completionsAt(model, typeNameIn(model, 'Material:NoMass,'), v26);
    expect(offers.status).toBe('ok');
    if (offers.status !== 'ok') return;
    expect(offers.offers.every((offer) => offer.prose === undefined)).toBe(true);
  });

  it('hydrates prose when a pool is supplied, so the sweep above can fail', async () => {
    const pool: ProsePool = await loadProse();

    const explained = explainAt(model, typeNameIn(model, 'Material,'), v26, pool);
    expect(explained.status).toBe('ok');
    if (explained.status !== 'ok') return;
    expect(explained.explanation.prose).toEqual(expect.any(String));

    const offers = completionsAt(model, typeNameIn(model, 'Material:NoMass,'), v26, {
      prose: pool,
    });
    expect(offers.status).toBe('ok');
    if (offers.status !== 'ok') return;
    expect(offers.offers.some((offer) => typeof offer.prose === 'string')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// declarationAt
// ---------------------------------------------------------------------------

describe('declarationAt', () => {
  it('selects the name field of the one statement that declares the name', () => {
    const result = declarationAt(model, valueOn(model, '!- Construction Name'), v26, document);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.declarations).toHaveLength(1);

    const [declaration] = result.declarations;
    expect(declaration?.typeName).toBe('Construction');
    expect(sliced(model, declaration!.region)).toBe('Exterior Wall');
    // The DECLARING statement's name field, and not the surface's own value or the free-text field
    // further down that happens to carry the same string.
    expect(declaration?.region.start).toBe(
      valueOn(model, '!- Name', model.indexOf('Construction,'))
    );
  });

  it('returns every declaration when two objects declare the name', () => {
    // Two types declaring into one list is ordinary in this format: a layer may be a `Material` or
    // a `Material:NoMass`, and a model that carries both under one name has two declaration sites.
    // Reporting the first would send a reader to whichever one the document happened to hold first.
    const text = [
      'Version, 26.1;',
      '',
      'Material,',
      '  Shared Layer,            !- Name',
      '  VeryRough,               !- Roughness',
      '  0.1,                     !- Thickness {m}',
      '  0.5,                     !- Conductivity {W/m-K}',
      '  100,                     !- Density {kg/m3}',
      '  900;                     !- Specific Heat {J/kg-K}',
      '',
      'Material:NoMass,',
      '  Shared Layer,            !- Name',
      '  Smooth,                  !- Roughness',
      '  0.15;                    !- Thermal Resistance {m2-K/W}',
      '',
      'Construction,',
      '  Wall Assembly,           !- Name',
      '  Shared Layer;            !- Outside Layer',
      '',
    ].join('\n');
    const both = parseIdf(text, v26, { strict: false }).document;

    const result = declarationAt(text, valueOn(text, '!- Outside Layer'), v26, both);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.declarations.map((declaration) => declaration.typeName)).toEqual([
      'Material',
      'Material:NoMass',
    ]);
    expect(result.declarations.map((declaration) => declaration.region.start)).toEqual([
      valueOn(text, '!- Name'),
      valueOn(text, '!- Name', text.indexOf('Material:NoMass,')),
    ]);
    for (const declaration of result.declarations) {
      expect(sliced(text, declaration.region)).toBe('Shared Layer');
    }
  });

  it('returns none, and guesses nothing, when the name is declared nowhere', () => {
    // The dangling-reference finding is what tells the reader why there is nothing here. Offering a
    // near miss would contradict it.
    const result = declarationAt(
      model,
      valueOn(model, '!- Outside Layer', model.indexOf('Ghost Wall')),
      v26,
      document
    );

    expect(result).toEqual({ status: 'ok', declarations: [] });
  });

  it('reports notApplicable for a field that points at nothing', () => {
    // `Output:Variable`'s key value is free text: it points into no reference list, and the string
    // written there is a `Construction` name in this very model. Searching the document for an
    // object that happens to be called whatever is written would find one, and would be a guess
    // dressed as an answer.
    const result = declarationAt(model, valueOn(model, '!- Key Value'), v26, document);

    expect(result).toEqual({ status: 'notApplicable' });
  });

  it('finds that same string from a field that does point at it, so the test above bites', () => {
    const result = declarationAt(model, valueOn(model, '!- Construction Name'), v26, document);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.declarations.map((declaration) => sliced(model, declaration.region))).toEqual([
      'Exterior Wall',
    ]);
  });
});
