import { beforeAll, describe, expect, it } from 'vitest';

import {
  lineColumnAt,
  parseIdf,
  scanIdf,
  validateDocument,
  type ParseDiagnostic,
  type Schema,
  type ValidationError,
} from '@idfkit/core';

// The syntax fixture corpus and the schema loader live beside the core tests and are read from
// there rather than copied. Three of those fixtures differ from one another only in their line
// endings, so a second reader that normalised anything would leave these tests passing against text
// that no longer carries the case they were written for.
import { schema, syntaxFixture, syntaxFixtures } from '../../core/tests/helpers.js';
import { findingsIn, position, type PositionedFinding } from '../src/findings.js';

let v26: Schema;
beforeAll(async () => {
  v26 = await schema('26.1.0');
});

const corpus = syntaxFixtures();

/** What the two runs produce on their own, which is what positioning has to account for exactly. */
function findingCount(text: string, against: Schema): number {
  const { document, diagnostics } = parseIdf(text, against, { strict: false });
  return diagnostics.length + validateDocument(document).totalIssues;
}

/**
 * SC-004: every finding either run produces about model text carries a region, and none is dropped.
 *
 * Counted against the two runs made separately rather than against a number written here, so a
 * finding added to either library is held to this without anybody remembering to update a total.
 */
describe('every finding carries a region', () => {
  it.each(corpus)('positions all of $name', ({ text }) => {
    const positioned = findingsIn(text, v26);

    expect(positioned).toHaveLength(findingCount(text, v26));
    for (const finding of positioned) {
      expect(finding.region.start).toBeGreaterThanOrEqual(0);
      expect(finding.region.end).toBeLessThanOrEqual(text.length);
      expect(finding.region.start).toBeLessThanOrEqual(finding.region.end);
      expect(finding.precision === 'field' || finding.precision === 'statement').toBe(true);
    }
  });

  it('finds something to position, so the assertion above can fail', () => {
    const total = corpus.reduce((sum, { text }) => sum + findingsIn(text, v26).length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('gives every corpus finding a region the layer itself names', () => {
    // Three regions are the only ones a placement may produce: a statement, its type name, or one of
    // its written fields. The fallback for a finding nothing in the text answers to is an empty
    // region at offset zero, which is none of them; it exists so SC-004 cannot be satisfied by
    // dropping the hard cases, and a fixture that reaches it is a correlation failure wearing a
    // region rather than a positioned finding.
    for (const { name, text } of corpus) {
      const named = new Set<string>();
      for (const statement of scanIdf(text).statements) {
        for (const region of [statement.region, statement.typeName, ...statement.fields]) {
          named.add(`${region.start}:${region.end}`);
        }
      }

      for (const finding of findingsIn(text, v26)) {
        const key = `${finding.region.start}:${finding.region.end}`;
        expect(named.has(key), `${name}.idf placed "${finding.message}" at ${key}`).toBe(true);
      }
    }
  });
});

/**
 * SC-005 and FR-013: the region selects the offending value and nothing beside it.
 *
 * Sliced rather than compared against offsets, because a pair of offsets that is wrong by one is
 * unreadable in a failure message and a slice that is wrong by one is obvious.
 */
describe('a field region selects the value exactly', () => {
  /** The finding a caller would act on, found by its code and its field rather than by position. */
  function findingFor(text: string, code: string, field: string) {
    const found = findingsIn(text, v26).find(
      (finding) => finding.code === code && 'field' in finding && finding.field === field
    );
    if (found === undefined) throw new Error(`no ${code} finding on ${field}`);
    return found;
  }

  it('selects a fixed field written beside its comment', () => {
    const text = [
      'Version, 26.1;',
      '',
      'Material,',
      '  IN46,                    !- Name',
      '  VeryRough,               !- Roughness',
      '  NotANumber,              !- Thickness {m}',
      '  2.3,                     !- Conductivity {W/m-K}',
      '  1000,                    !- Density',
      '  900;                     !- Specific Heat',
      '',
    ].join('\n');

    const finding = findingFor(text, 'E003', 'thickness');

    expect(text.slice(finding.region.start, finding.region.end)).toBe('NotANumber');
    expect(finding.precision).toBe('field');
  });

  it('selects a field written alone on its line', () => {
    const text = ['Version, 26.1;', '', 'Zone,', '  Zone One,', '  NotANumber,', '  0.0;', ''].join(
      '\n'
    );

    const finding = findingFor(text, 'E003', 'direction_of_relative_north');

    expect(text.slice(finding.region.start, finding.region.end)).toBe('NotANumber');
    expect(finding.precision).toBe('field');
  });

  it('selects a field separated from its statement by comments', () => {
    // The comments carry a comma and a semicolon, neither of which is a delimiter here, so a region
    // computed by counting separators without stepping over comments lands on the wrong field.
    const text = [
      'Version, 26.1;',
      '',
      'Zone,',
      '  Zone One,',
      '  !- the separator above and the value below are three lines apart,',
      '  !- and these two comments sit between them;',
      '  NotANumber,',
      '  0.0;',
      '',
    ].join('\n');

    const finding = findingFor(text, 'E003', 'direction_of_relative_north');

    expect(text.slice(finding.region.start, finding.region.end)).toBe('NotANumber');
    expect(finding.precision).toBe('field');
  });

  /**
   * The case the extensible arithmetic exists for, and the one that fails quietly when it is wrong.
   *
   * `fixedCount + repeat * groupWidth + offsetWithinGroup` on a surface is `11 + 8 * 3 + 0`, so the
   * ninth vertex's x coordinate is field 35 of the statement. Getting it wrong by one group puts the
   * underline on a neighbouring vertex, which looks plausible in a screenshot and is useless in an
   * editor, so the first vertex is asserted beside the ninth: a placement that ignored the repeat
   * would satisfy one of the two and not both.
   *
   * The findings are built here rather than taken from a run, because no code path in `@idfkit/core`
   * reports a value inside an extensible group today: `validateDocument` skips the extensible key,
   * and `parseIdf` collects its unreadable-value findings from the fixed fields alone. What is under
   * test is the arithmetic that positions such a finding, which is reached the moment either
   * producer starts making one.
   */
  describe('a field late in an extensible group', () => {
    const text = syntaxFixture('surface-bad-ninth-vertex');

    /** A `ValidationError` carrying the repeat its field belongs to, which the type cannot say. */
    function vertexFinding(index: number): ValidationError & { readonly index: number } {
      return {
        severity: 'error',
        objType: 'BuildingSurface:Detailed',
        objName: 'South Wall',
        field: 'vertex_x_coordinate',
        message: 'Expected number, got string',
        code: 'E003',
        index,
      };
    }

    it('selects the ninth vertex, not the first', () => {
      const [ninth] = position([vertexFinding(8)], scanIdf(text), v26);

      expect(text.slice(ninth?.region.start, ninth?.region.end)).toBe('not-a-number');
      expect(ninth?.precision).toBe('field');
    });

    it('selects the first vertex when the finding is about the first', () => {
      const [first] = position([vertexFinding(0)], scanIdf(text), v26);

      expect(text.slice(first?.region.start, first?.region.end)).toBe('0.0');
      expect(first?.precision).toBe('field');
    });

    it('falls back to the statement when the finding cannot say which repeat', () => {
      const { index: _repeat, ...withoutRepeat } = vertexFinding(8);
      const [placed] = position([withoutRepeat], scanIdf(text), v26);

      expect(placed?.precision).toBe('statement');
      expect(text.slice(placed?.region.start, placed?.region.end)).toMatch(
        /^BuildingSurface:Detailed,/
      );
    });
  });
});

/**
 * FR-012: a finding about a statement selects the statement, and a fallback says it was taken.
 *
 * The line and column are the ones the finding already reports, which matters beyond tidiness: the
 * conformance corpus compares findings across the two libraries on `(code, line, typeName)`, so a
 * region that derived a different line would move a number a gate is watching.
 */
describe('a statement finding selects the statement', () => {
  /** Reading findings alone, which are the ones that name a place rather than an object. */
  function readingFindings(text: string): readonly PositionedFinding<ParseDiagnostic>[] {
    return findingsIn(text, v26).filter(
      (finding): finding is PositionedFinding<ParseDiagnostic> => 'line' in finding
    );
  }

  it('selects the type name of the duplicate, at the line and column already reported', () => {
    const text = syntaxFixture('duplicate-object-name');
    const layer = scanIdf(text);

    const duplicate = readingFindings(text).find((finding) => finding.code === 'ParseError');

    expect(duplicate).toBeDefined();
    expect(text.slice(duplicate?.region.start, duplicate?.region.end)).toBe('Zone');
    expect(duplicate?.precision).toBe('statement');
    // The second Zone and not the first: the finding is about the statement the parse refused,
    // while the first is the one the document kept. Correlating this one by type and name would
    // have underlined the wrong object, which is why a reading finding is never correlated.
    expect(lineColumnAt(layer, duplicate!.region.start)).toEqual({
      line: duplicate?.line,
      column: duplicate?.column,
    });
    expect(lineColumnAt(layer, duplicate!.region.start)).toEqual({ line: 7, column: 1 });
  });

  it('selects the type name of an unknown type, at the line and column already reported', () => {
    const text = syntaxFixture('unknown-object-type');
    const layer = scanIdf(text);

    const unknown = readingFindings(text).find((finding) => finding.code === 'UnknownObjectType');

    expect(unknown).toBeDefined();
    expect(text.slice(unknown?.region.start, unknown?.region.end)).toBe('NotAnObject:AtAll');
    expect(unknown?.precision).toBe('statement');
    expect(lineColumnAt(layer, unknown!.region.start)).toEqual({
      line: unknown?.line,
      column: unknown?.column,
    });
  });

  it('falls back to the whole statement for a field that was never written, and says so', () => {
    // Required fields the statement stops short of. There is no text to select, so the statement
    // stands in and `precision` records that the fallback was taken.
    const text = ['Version, 26.1;', '', 'Material,', '  IN46;', ''].join('\n');

    const missing = findingsIn(text, v26).filter((finding) => finding.code === 'E001');

    expect(missing.length).toBeGreaterThan(0);
    for (const finding of missing) {
      expect(finding.precision).toBe('statement');
      expect(text.slice(finding.region.start, finding.region.end)).toBe('Material,\n  IN46;');
    }
  });
});
