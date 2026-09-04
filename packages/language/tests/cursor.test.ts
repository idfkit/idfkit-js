import { beforeAll, describe, expect, it } from 'vitest';

import { scanIdf } from '@idfkit/core';
import type { Schema } from '@idfkit/schemas';

import { schema, syntaxFixture, syntaxFixtures } from '../../core/tests/helpers.js';
import { contextAt } from '../src/cursor.js';

let v26: Schema;
beforeAll(async () => {
  v26 = await schema('26.1.0');
});

/**
 * Offset of the character after `needle`, which is where a cursor sits when somebody has just
 * finished typing it.
 *
 * Spelled out once because every test here is about a position, and `text.indexOf(x) + x.length`
 * repeated a dozen times hides which position was meant.
 */
function after(text: string, needle: string, from = 0): number {
  const at = text.indexOf(needle, from);
  if (at < 0) throw new Error(`fixture does not contain ${JSON.stringify(needle)}`);
  return at + needle.length;
}

/** Offset of the first character of `needle`. */
function at(text: string, needle: string, from = 0): number {
  const found = text.indexOf(needle, from);
  if (found < 0) throw new Error(`fixture does not contain ${JSON.stringify(needle)}`);
  return found;
}

describe('contextAt, inside a statement', () => {
  it('places a half-typed field with no separator after it in that field', () => {
    // The last field of the file, written but never closed: no comma, no semicolon, nothing after
    // it but a line feed. This is the state a cursor is in for most of the time it is anywhere.
    const text = syntaxFixture('unterminated-final-statement');
    const context = contextAt(text, after(text, '0.0', at(text, '0.0,') + 1), v26);

    expect(context.at).toBe('field');
    expect(context.fieldIndex).toBe(2);
    expect(context.typeName).toBe('Zone');
    expect(context.fieldName).toBe('x_origin');
    expect(context.statement.unterminated).toBe(true);
  });

  it('places a value written across two lines in the field that holds both halves', () => {
    const text = syntaxFixture('value-across-two-lines');
    const context = contextAt(text, after(text, 'My'), v26);

    expect(context.at).toBe('field');
    expect(context.fieldIndex).toBe(0);
    expect(context.fieldName).toBe('name');
    expect(text.slice(context.statement.fields[0]!.start, context.statement.fields[0]!.end)).toBe(
      'My\n  Zone'
    );
  });

  it('places an offset on the type name in the type name', () => {
    const text = syntaxFixture('line-endings-lf');
    const context = contextAt(text, at(text, 'Zone,') + 2, v26);

    expect(context.at).toBe('typeName');
    expect(context.fieldIndex).toBeUndefined();
    expect(context.typeName).toBe('Zone');
    expect(context.fieldName).toBeUndefined();
  });

  it('places an offset on the terminator in the last field it closes', () => {
    const text = syntaxFixture('line-endings-lf');
    const context = contextAt(text, at(text, '0.0;'), v26);

    expect(context.at).toBe('field');
    expect(context.fieldIndex).toBe(2);
    expect(context.fieldName).toBe('x_origin');
  });
});

describe('contextAt, between statements', () => {
  it('reports betweenStatements immediately after a terminator', () => {
    const text = syntaxFixture('line-endings-lf');
    const context = contextAt(text, after(text, 'Version, 26.1;'), v26);

    expect(context.at).toBe('betweenStatements');
    expect(context.fieldIndex).toBeUndefined();
    expect(context.statement.typeNameText).toBe('');
  });

  it('reports betweenStatements in trailing whitespace at end of file', () => {
    const text = syntaxFixture('line-endings-lf');
    expect(text.endsWith('\n')).toBe(true);

    const context = contextAt(text, text.length, v26);

    expect(context.at).toBe('betweenStatements');
    // The statement a cursor is beginning selects nothing, at the cursor, which is the region an
    // offer accepted here would insert into.
    expect(context.statement.region).toEqual({ start: text.length, end: text.length });
  });

  it('reports betweenStatements on a blank line between two statements', () => {
    const text = syntaxFixture('line-endings-lf');
    const context = contextAt(text, at(text, '\n\nZone,') + 1, v26);

    expect(context.at).toBe('betweenStatements');
  });

  it('reports betweenStatements for every offset in empty text', () => {
    expect(contextAt('', 0, v26).at).toBe('betweenStatements');
    expect(contextAt('   \n  ', 4, v26).at).toBe('betweenStatements');
  });
});

describe('contextAt, in a comment', () => {
  it('reports comment on the exclamation mark itself', () => {
    const text = syntaxFixture('line-endings-lf');
    const bang = at(text, '!- Name');

    expect(contextAt(text, bang, v26).at).toBe('comment');
    expect(contextAt(text, bang + 4, v26).at).toBe('comment');
  });

  it('reports comment at the end of the comment text, before the line feed', () => {
    const text = syntaxFixture('line-endings-lf');
    const end = at(text, '\n', at(text, '!- Name'));

    expect(contextAt(text, end, v26).at).toBe('comment');
  });

  it('still reports the statement the comment interrupts', () => {
    const text = syntaxFixture('line-endings-lf');
    const context = contextAt(text, at(text, '!- Direction'), v26);

    expect(context.at).toBe('comment');
    expect(context.typeName).toBe('Zone');
    expect(context.fieldIndex).toBeUndefined();
  });

  it('reports comment in a file that is nothing but comments', () => {
    const text = syntaxFixture('comments-only');

    expect(contextAt(text, 0, v26).at).toBe('comment');
    expect(contextAt(text, 30, v26).at).toBe('comment');
  });

  it('is not fooled by a semicolon inside a comment', () => {
    // The comment on the Name field carries both a comma and a semicolon. A backward scan that
    // took that semicolon for a terminator would resolve the two fields below it into a statement
    // that does not exist.
    const text = syntaxFixture('comma-inside-trailing-comment');
    const context = contextAt(text, at(text, '0.0;'), v26);

    expect(context.at).toBe('field');
    expect(context.typeName).toBe('Zone');
    expect(context.fieldIndex).toBe(2);
  });
});

describe('contextAt, above a malformation', () => {
  it('resolves an offset above an unterminated statement further down the file', () => {
    const text = syntaxFixture('unterminated-final-statement');
    const context = contextAt(text, at(text, 'Version') + 3, v26);

    expect(context.at).toBe('typeName');
    expect(context.typeName).toBe('Version');
    expect(context.statement.unterminated).toBe(false);
    expect(text.slice(context.statement.region.start, context.statement.region.end)).toBe(
      'Version, 26.1;'
    );
  });

  it('resolves an offset above a statement that swallowed the one after it', () => {
    const text = syntaxFixture('missing-terminator-swallows-next');
    const above = contextAt(text, at(text, '26.1'), v26);

    expect(above.at).toBe('field');
    expect(above.typeName).toBe('Version');

    // The Zone that forgot its terminator runs on through the Zone below it, exactly as the layer
    // reads it, and a cursor in either of them is in that one statement.
    const inside = contextAt(text, at(text, 'Zone Two'), v26);
    expect(inside.typeName).toBe('Zone');
    expect(text.slice(inside.statement.region.end - 1, inside.statement.region.end)).toBe(';');
    expect(inside.statement.region.start).toBe(at(text, 'Zone,'));
  });

  it('reports a written type name the schema does not define, and no field name', () => {
    const text = syntaxFixture('unknown-object-type');
    const context = contextAt(text, at(text, 'Whatever'), v26);

    expect(context.at).toBe('field');
    expect(context.fieldIndex).toBe(0);
    expect(context.statement.typeNameText).toBe('NotAnObject:AtAll');
    // The context is still returned: a finding about the unknown type needs positioning too.
    expect(context.typeName).toBeUndefined();
    expect(context.fieldName).toBeUndefined();
  });

  it('answers without a schema, reporting the written name and the field index', () => {
    const text = syntaxFixture('no-version-declared');
    const context = contextAt(text, at(text, 'Zone One'));

    expect(context.at).toBe('field');
    expect(context.fieldIndex).toBe(0);
    expect(context.statement.typeNameText).toBe('Zone');
    expect(context.typeName).toBeUndefined();
    expect(context.fieldName).toBeUndefined();
  });
});

describe('contextAt, out of range', () => {
  const text = syntaxFixture('line-endings-lf');

  it('clamps a negative offset to the start rather than throwing', () => {
    expect(contextAt(text, -1, v26)).toEqual(contextAt(text, 0, v26));
    expect(contextAt(text, -1e9, v26).at).toBe('typeName');
  });

  it('clamps an offset past the end to the end rather than throwing', () => {
    expect(contextAt(text, text.length + 1000, v26)).toEqual(contextAt(text, text.length, v26));
  });

  it('answers for an offset that is not a whole number, and for NaN', () => {
    expect(contextAt(text, 4.7, v26)).toEqual(contextAt(text, 4, v26));
    expect(contextAt(text, Number.NaN, v26)).toEqual(contextAt(text, 0, v26));
  });
});

/**
 * The load-bearing property, and the reason this file exists.
 *
 * The cursor reads one statement by scanning outwards from an offset; the layer reads every
 * statement in one forward pass. Two implementations of the same character rules that differ by
 * one character would put a completion on the neighbouring field, and nothing else in the suite
 * would notice. So every statement the layer finds is asked for again, one offset at a time,
 * through the cursor, and the two must produce the same statement.
 *
 * The layer is what a test may consult. `contextAt` must not, and does not.
 */
describe('contextAt agrees with the syntax layer', () => {
  for (const fixture of syntaxFixtures()) {
    it(`resolves the same statement as scanIdf, in ${fixture.name}.idf`, () => {
      const layer = scanIdf(fixture.text);
      for (const statement of layer.statements) {
        const { start, end } = statement.region;
        const offsets = new Set([start, start + 1, (start + end) >> 1, end - 1]);
        for (const offset of offsets) {
          if (offset < start || offset >= end) continue;
          const context = contextAt(fixture.text, offset);
          expect(
            context.statement,
            `offset ${offset} of ${fixture.name}.idf resolved to the wrong statement`
          ).toEqual(statement);
        }
      }
    });
  }
});
