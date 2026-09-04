import { beforeAll, describe, expect, it } from 'vitest';

import { parseIdf } from '@idfkit/core';
import type { IdfDocument, Schema } from '@idfkit/core';

import { schema, syntaxFixture } from '../../core/tests/helpers.js';
// Through the public surface rather than through the modules, because "every answer returns" is a
// claim about what a consumer can reach: a function that degraded well and was never exported would
// satisfy every other file in this suite and none of SC-009.
import { completionsAt, contextAt, declarationAt, explainAt, findingsIn } from '../src/index.js';

let v26: Schema;
beforeAll(async () => {
  v26 = await schema('26.1.0');
});

/** One file that violates something, named by what it violates. */
interface Malformed {
  readonly name: string;
  readonly text: string;
}

/**
 * Text that breaks one of the rules an answer would like to rely on.
 *
 * Taken from the syntax fixture corpus, which exists for exactly this and holds the bytes as they
 * are on disk, so a fixture added there for one case is held to these invariants too.
 */
const malformed: readonly Malformed[] = [
  { name: 'empty text', text: syntaxFixture('empty') },
  { name: 'a file of nothing but comments', text: syntaxFixture('comments-only') },
  { name: 'a single unterminated word', text: syntaxFixture('single-unterminated-word') },
  { name: 'no version statement', text: syntaxFixture('no-version-declared') },
  { name: 'a version no schema is shipped for', text: syntaxFixture('unsupported-version') },
  { name: 'an unknown object type', text: syntaxFixture('unknown-object-type') },
  { name: 'an unterminated final statement', text: syntaxFixture('unterminated-final-statement') },
  {
    name: 'a terminator that swallowed the statement below it',
    text: syntaxFixture('missing-terminator-swallows-next'),
  },
];

/** The five statuses the three discriminated results are allowed to carry. */
const STATUSES = new Set(['ok', 'unconstrained', 'noSchema', 'unknownType', 'notApplicable']);

/**
 * Offsets worth asking about in a file this small, the impossible ones included.
 *
 * FR-032: an offset outside `[0, text.length]` is clamped rather than refused, because a cursor
 * arrives from an editor that may be a keystroke ahead of the text it was measured against. `NaN`
 * and a fraction are here for the same reason: they are what an arithmetic slip upstream produces,
 * and answering about the nearest character beats throwing at a consumer who cannot fix it.
 */
function probeOffsets(text: string): readonly number[] {
  return [
    -1e9,
    -1,
    0,
    1,
    Math.floor(text.length / 2),
    4.7,
    Number.NaN,
    text.length,
    text.length + 1,
    text.length + 1000,
  ];
}

/** The document a consumer holds, read from the same text without a strict run refusing it. */
function documentOf(text: string, against: Schema): IdfDocument {
  return parseIdf(text, against, { strict: false }).document;
}

describe('every answer returns rather than failing', () => {
  it.each(malformed)('answers with a schema, over $name', ({ text }) => {
    const document = documentOf(text, v26);

    for (const offset of probeOffsets(text)) {
      const context = contextAt(text, offset, v26);
      expect(context.statement).toBeDefined();
      expect(['typeName', 'field', 'comment', 'betweenStatements']).toContain(context.at);
      // Whatever the text says, the region it reports is inside the text it was given.
      expect(context.statement.region.start).toBeGreaterThanOrEqual(0);
      expect(context.statement.region.end).toBeLessThanOrEqual(text.length);

      for (const result of [
        completionsAt(text, offset, v26, { document }),
        explainAt(text, offset, v26),
        declarationAt(text, offset, v26, document),
      ]) {
        expect(STATUSES.has(result.status)).toBe(true);
      }
    }
  });

  it.each(malformed)('answers with no schema at all, over $name', ({ text }) => {
    // FR-031: "I could not consult a schema" is a state of its own, and never an empty `'ok'`. A
    // consumer that showed an empty list here would tell the reader the model permits nothing,
    // where the truth is that nothing was consulted.
    const document = documentOf(text, v26);

    for (const offset of probeOffsets(text)) {
      const context = contextAt(text, offset);
      expect(context.typeName).toBeUndefined();
      expect(context.fieldName).toBeUndefined();

      for (const result of [
        completionsAt(text, offset, undefined, { document }),
        explainAt(text, offset, undefined),
        declarationAt(text, offset, undefined, document),
      ]) {
        expect(['noSchema', 'notApplicable']).toContain(result.status);
      }
    }
  });

  it.each(malformed)('positions every finding over $name', ({ text }) => {
    // `findingsIn` has no schemaless state to test: its signature requires one, because findings
    // are what a parse and a validation produced and neither runs without a schema. What it owes
    // here is the rest of SC-009: malformed text produces positioned findings rather than a throw.
    const positioned = findingsIn(text, v26);

    expect(Array.isArray(positioned)).toBe(true);
    for (const finding of positioned) {
      expect(finding.region.start).toBeGreaterThanOrEqual(0);
      expect(finding.region.end).toBeLessThanOrEqual(text.length);
      expect(finding.region.start).toBeLessThanOrEqual(finding.region.end);
    }
  });
});

/**
 * The statements above every malformation, which the answers must read exactly as if it were not
 * there.
 *
 * Terminated, schema-resolvable, and carrying a reference so that every one of the four answers has
 * something real to say about it: type names to complete, fields to explain, and a name whose
 * declaration is a region further up. Its density is deliberately unreadable, so that there are
 * findings above the malformation too and the positions they carry can be held to the same
 * equality as everything else.
 */
const head = [
  'Version, 26.1;',
  '',
  'Material,',
  '  Insulation Board,        !- Name',
  '  VeryRough,               !- Roughness',
  '  0.1,                     !- Thickness {m}',
  '  0.5,                     !- Conductivity {W/m-K}',
  '  NotANumber,              !- Density {kg/m3}',
  '  900;                     !- Specific Heat {J/kg-K}',
  '',
  'Construction,',
  '  Exterior Wall,           !- Name',
  '  Insulation Board;        !- Outside Layer',
  '',
  '',
].join('\n');

/** One malformation, and the same file with that malformation repaired and nothing else changed. */
interface Repair {
  readonly name: string;
  /** What the malformed tail says. */
  readonly broken: string;
  /** What the repaired tail says instead. */
  readonly fixed: string;
}

/**
 * The tails, written in pairs so that the repair is visible rather than described.
 *
 * Each pair differs only below `head`, which is what makes "above the malformation" a position
 * rather than a judgement: the two files are byte-identical up to `head.length`, asserted before
 * anything is compared.
 */
const repairs: readonly Repair[] = [
  {
    name: 'an unterminated final statement',
    broken: ['Zone,', '  Office Zone 1,', '  0.0,', '  0.0', ''].join('\n'),
    fixed: ['Zone,', '  Office Zone 1,', '  0.0,', '  0.0;', ''].join('\n'),
  },
  {
    name: 'a missing terminator that swallows the statement below it',
    broken: ['Zone,', '  Office Zone 1,', '  0.0', '', 'Timestep, 6;', ''].join('\n'),
    fixed: ['Zone,', '  Office Zone 1,', '  0.0;', '', 'Timestep, 6;', ''].join('\n'),
  },
  {
    name: 'an object of a type the schema does not define',
    broken: ['NotAnObject:AtAll,', '  Whatever,', '  1.0;', ''].join('\n'),
    fixed: ['Building,', '  Whatever,', '  1.0;', ''].join('\n'),
  },
  {
    name: 'a single unterminated word',
    broken: 'Zone',
    fixed: 'Zone,\n  Office Zone 1;\n',
  },
];

describe('answers above a malformation match answers over the repair', () => {
  /**
   * SC-009 as a property rather than a wish.
   *
   * "Degrades gracefully" is easy to satisfy by returning nothing everywhere and hard to satisfy
   * honestly, so the claim is stated as an equality: for every offset above the malformation, all
   * four answers are the ones the same file gives once the malformation is repaired. A reader
   * editing the bottom of a file loses nothing at the top, which is the thing a reader actually
   * notices, and no assertion here can be satisfied by a service that has stopped answering.
   */
  it.each(repairs)('reads the statements above $name unchanged', ({ broken, fixed }) => {
    const malformedText = head + broken;
    const repairedText = head + fixed;

    expect(malformedText.slice(0, head.length)).toBe(repairedText.slice(0, head.length));
    expect(malformedText).not.toBe(repairedText);

    const malformedDocument = documentOf(malformedText, v26);
    const repairedDocument = documentOf(repairedText, v26);

    let completed = 0;
    let explained = 0;
    let declared = 0;

    for (let offset = 0; offset < head.length; offset += 1) {
      expect(contextAt(malformedText, offset, v26)).toEqual(contextAt(repairedText, offset, v26));

      const completion = completionsAt(malformedText, offset, v26, {
        document: malformedDocument,
      });
      expect(completion).toEqual(
        completionsAt(repairedText, offset, v26, { document: repairedDocument })
      );
      if (completion.status === 'ok') completed += 1;

      const explanation = explainAt(malformedText, offset, v26);
      expect(explanation).toEqual(explainAt(repairedText, offset, v26));
      if (explanation.status === 'ok') explained += 1;

      const declaration = declarationAt(malformedText, offset, v26, malformedDocument);
      expect(declaration).toEqual(declarationAt(repairedText, offset, v26, repairedDocument));
      if (declaration.status === 'ok' && declaration.declarations.length > 0) declared += 1;
    }

    // Equal answers are only worth having if some of them said something. Each of the three counts
    // is over the head above, which offers type names, explains a field, and follows a layer name
    // to the material that declares it.
    expect(completed).toBeGreaterThan(0);
    expect(explained).toBeGreaterThan(0);
    expect(declared).toBeGreaterThan(0);
  });

  it.each(repairs)('positions the findings above $name in the same places', ({ broken, fixed }) => {
    // Keyed by code and region rather than compared as objects, so a failure reads as a finding
    // that moved rather than as two large records that differ somewhere.
    const above = (text: string): string[] =>
      findingsIn(text, v26)
        .filter((finding) => finding.region.end <= head.length)
        .map((finding) => `${finding.code}@${finding.region.start}:${finding.region.end}`);

    const unrepaired = above(head + broken);

    // The head's own unreadable density, found in both files and in the same place in each. An
    // empty list on both sides would satisfy the equality and prove nothing.
    expect(unrepaired.length).toBeGreaterThan(0);
    expect(unrepaired).toEqual(above(head + fixed));
    // The malformation below is genuinely a malformation, so the equality above is about a file
    // that really is broken.
    expect(findingsIn(head + broken, v26).length).toBeGreaterThan(unrepaired.length);
  });
});
