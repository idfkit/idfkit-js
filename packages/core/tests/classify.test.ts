import { describe, expect, it } from 'vitest';

import {
  classify,
  lex,
  lineColumnAt,
  scanIdf,
  type LexDiagnostic,
  type SyntaxLayer,
  type Token,
  type TokenKind,
} from '@idfkit/core';

import { syntaxFixture, syntaxFixtures } from './helpers.js';

/**
 * What the kinds mean.
 *
 * The tiling of the *stored* tokens is asserted in `scan.test.ts`; this file is about the
 * classified stream, which is a different thing: it fills the gaps with `trivia`, splits at line
 * boundaries, and is the only place a consumer sees a kind at all. So coverage is re-checked here
 * on the yielded stream, and everything else asked of it is about what each kind selects.
 */

/** Every kind the layer stores. `trivia` is the complement and is never stored, only yielded. */
const MEANINGFUL_KINDS: readonly TokenKind[] = [
  'typeName',
  'value',
  'separator',
  'terminator',
  'comment',
];

/**
 * Where a classified stream stops covering the text exactly once, described rather than counted.
 *
 * Empty, and only empty, when the stream begins at 0, ends at `text.length`, and has no gap and no
 * overlap between. A failure names the offset and the clause, so a regression reads as "gap at
 * [38,40)" rather than as two long strings differing somewhere.
 */
function coverageBreaks(layer: SyntaxLayer, tokens: readonly Token[]): string[] {
  const breaks: string[] = [];
  let covered = 0;
  for (const token of tokens) {
    if (token.end <= token.start) {
      breaks.push(`empty or inverted token [${token.start},${token.end})`);
    }
    if (token.start < covered) breaks.push(`overlap at ${token.start}, covered to ${covered}`);
    else if (token.start > covered) breaks.push(`gap [${covered},${token.start})`);
    covered = Math.max(covered, token.end);
  }
  if (covered !== layer.text.length) {
    breaks.push(`stream ends at ${covered}, text is ${layer.text.length} long`);
  }
  return breaks;
}

/**
 * Whether a token spans a line boundary, measured on its last character rather than on `end`.
 *
 * A region is half-open, so the last character it selects is at `end - 1`. That distinction is the
 * whole of this predicate: a value split at a newline ends at the *following* line's first offset,
 * and measuring the line of `end` would report every split token as a crossing when none of them
 * is. A token may therefore contain the line feed that ends its own line, which is inside that
 * line rather than across it.
 */
function crossesLine(layer: SyntaxLayer, token: Token): boolean {
  return lineColumnAt(layer, token.start).line !== lineColumnAt(layer, token.end - 1).line;
}

/** Whether any non-whitespace precedes a token on its own line, which is what "trails" means. */
function trails(text: string, token: Token): boolean {
  const lineStart = text.lastIndexOf('\n', token.start - 1) + 1;
  return text.slice(lineStart, token.start).trim() !== '';
}

/** The tokens of one kind, in source order. */
function of(tokens: readonly Token[], kind: TokenKind): readonly Token[] {
  return tokens.filter((token) => token.kind === kind);
}

/** One fixture, scanned and classified, with everything the assertions below want to look at. */
function classified(name: string): {
  readonly text: string;
  readonly layer: SyntaxLayer;
  readonly tokens: readonly Token[];
} {
  const text = syntaxFixture(name);
  const layer = scanIdf(text);
  return { text, layer, tokens: [...classify(layer)] };
}

describe('classify', () => {
  describe('coverage and kinds', () => {
    it('covers every character of every fixture exactly once', () => {
      for (const fixture of syntaxFixtures()) {
        const layer = scanIdf(fixture.text);
        expect(coverageBreaks(layer, [...classify(layer)]), fixture.name).toEqual([]);
      }
    });

    it('distinguishes a type name, a value, a separator, a terminator and a comment', () => {
      // One file carrying all five, so the claim is that they are told apart within the same text
      // rather than that five files each managed one.
      const { tokens } = classified('comma-inside-trailing-comment');
      const kinds = tokens.map((token) => token.kind);
      for (const kind of MEANINGFUL_KINDS) {
        expect(kinds, `no ${kind} token`).toContain(kind);
      }
      expect(kinds).toContain('trivia');
    });

    it('selects the type name each statement declares, and nothing else', () => {
      for (const fixture of syntaxFixtures()) {
        const layer = scanIdf(fixture.text);
        const drawn = of([...classify(layer)], 'typeName');

        // A type name that was written is drawn in full: the tokens inside its stored region
        // reassemble the text the statement reports for it.
        for (const statement of layer.statements) {
          if (statement.typeName.end === statement.typeName.start) continue;
          const parts = drawn.filter(
            (token) =>
              token.start >= statement.typeName.start && token.end <= statement.typeName.end
          );
          const text = parts.map((token) => fixture.text.slice(token.start, token.end)).join('');
          expect(text, `${fixture.name} at ${statement.typeName.start}`).toBe(
            statement.typeNameText
          );
        }

        // And nothing that is not one is drawn as one.
        for (const token of drawn) {
          const owner = layer.statements.find(
            (statement) =>
              token.start >= statement.typeName.start && token.end <= statement.typeName.end
          );
          expect(
            owner,
            `${fixture.name}: typeName [${token.start},${token.end}) belongs to no statement`
          ).toBeDefined();
        }
      }
    });

    it('selects each field value in full, delimiters excluded', () => {
      for (const fixture of syntaxFixtures()) {
        const layer = scanIdf(fixture.text);
        const drawn = of([...classify(layer)], 'value');

        for (const statement of layer.statements) {
          for (const field of statement.fields) {
            if (field.end === field.start) continue;
            const parts = drawn.filter(
              (token) => token.start >= field.start && token.end <= field.end
            );
            const text = parts.map((token) => fixture.text.slice(token.start, token.end)).join('');
            expect(text, `${fixture.name} at ${field.start}`).toBe(
              fixture.text.slice(field.start, field.end)
            );
          }
        }

        // No value carries a delimiter or a comment mark, whichever field it belongs to: those
        // three characters are exactly what ends a field, so one inside a value would mean the
        // value had swallowed a token of another kind.
        const fields = layer.statements.flatMap((statement) => statement.fields);
        for (const token of drawn) {
          const text = fixture.text.slice(token.start, token.end);
          expect(text, `${fixture.name} at ${token.start}`).not.toMatch(/[,;!]/);

          // A value token can be blank, but only in the middle of a field the text wrote across
          // several lines: `missing-terminator-swallows-next` has a field running through a blank
          // line, and the line split hands that line back as a value with nothing on it. What it
          // must never be is a blank token standing on its own where trivia belongs.
          if (text.trim() !== '') continue;
          const spanning = fields.some(
            (field) => field.start < token.start && field.end > token.end
          );
          expect(spanning, `${fixture.name}: blank value at ${token.start} spans no field`).toBe(
            true
          );
        }
      }
    });

    it('selects one comma per separator and one semicolon per terminator', () => {
      for (const fixture of syntaxFixtures()) {
        const layer = scanIdf(fixture.text);
        const tokens = [...classify(layer)];

        for (const token of of(tokens, 'separator')) {
          expect(fixture.text.slice(token.start, token.end), fixture.name).toBe(',');
        }
        for (const token of of(tokens, 'terminator')) {
          expect(fixture.text.slice(token.start, token.end), fixture.name).toBe(';');
        }

        // A terminator is what makes a statement terminated, so the two counts are one fact.
        expect(of(tokens, 'terminator').length, fixture.name).toBe(
          layer.statements.filter((statement) => !statement.unterminated).length
        );
      }
    });

    it('selects a comment from its mark to the end of its line', () => {
      for (const fixture of syntaxFixtures()) {
        const layer = scanIdf(fixture.text);
        for (const token of of([...classify(layer)], 'comment')) {
          const text = fixture.text.slice(token.start, token.end);
          expect(text, `${fixture.name} at ${token.start}`).toMatch(/^!/);
          // The line feed itself is trivia. A carriage return before it is the last character
          // before the newline and so belongs to the comment, which is why this looks for a line
          // feed rather than for trailing whitespace generally.
          expect(text, `${fixture.name} at ${token.start}`).not.toContain('\n');
        }
      }
    });

    it('selects only whitespace as trivia', () => {
      for (const fixture of syntaxFixtures()) {
        const layer = scanIdf(fixture.text);
        for (const token of of([...classify(layer)], 'trivia')) {
          const text = fixture.text.slice(token.start, token.end);
          expect(text, `${fixture.name} at ${token.start}`).toMatch(/^\s+$/);
        }
      }
    });
  });

  describe('comments', () => {
    it('keeps a comment trailing a value out of that value', () => {
      const { text, tokens } = classified('comma-inside-trailing-comment');
      const name = of(tokens, 'value')[1];
      const comment = of(tokens, 'comment')[0];

      expect(name && text.slice(name.start, name.end)).toBe('Zone One');
      expect(comment && text.slice(comment.start, comment.end)).toBe(
        '!- Name, which is followed here by a comma; and a semicolon'
      );
      // Its own region, opening after the value closes: an underline drawn on the value lands on
      // `Zone One` and stops there rather than running through the annotation beside it.
      expect(comment!.start).toBeGreaterThan(name!.end);
      expect(text.slice(name!.start, name!.end)).not.toContain('!');
    });

    it('tells a comment that trails a value from one that has its line to itself', () => {
      const trailing = classified('comma-inside-trailing-comment');
      const alone = classified('comment-between-separator-and-value');

      // The rule is whether any non-whitespace precedes the mark on the same line, and it is
      // decidable from the token stream alone, with no schema and no parse.
      const trailingComments = of(trailing.tokens, 'comment');
      expect(trailingComments).toHaveLength(3);
      expect(trailingComments.map((token) => trails(trailing.text, token))).toEqual([
        true,
        true,
        true,
      ]);

      const loneComments = of(alone.tokens, 'comment');
      expect(loneComments).toHaveLength(2);
      expect(loneComments.map((token) => trails(alone.text, token))).toEqual([false, false]);

      // And a comment sitting between a separator and its value is part of neither: the separator
      // closes before it, and the value opens after it.
      const separatorBefore = of(alone.tokens, 'separator').find(
        (token) => token.end <= loneComments[0]!.start
      );
      const valueAfter = of(alone.tokens, 'value').find(
        (token) => token.start >= loneComments[1]!.end
      );
      expect(separatorBefore).toBeDefined();
      expect(valueAfter && alone.text.slice(valueAfter.start, valueAfter.end)).toBe('0.0');
    });

    it('does not read a comma or a semicolon inside a comment as a delimiter', () => {
      const { text, tokens } = classified('comma-inside-trailing-comment');
      const comment = of(tokens, 'comment')[0]!;
      const inside = text.slice(comment.start, comment.end);

      // The fixture exists to put both delimiters inside a comment. If it ever stopped containing
      // them this test would keep passing while proving nothing, so it says so.
      expect(inside).toContain(',');
      expect(inside).toContain(';');

      for (const token of tokens) {
        if (token.kind !== 'separator' && token.kind !== 'terminator') continue;
        expect(
          token.start >= comment.end || token.end <= comment.start,
          `delimiter [${token.start},${token.end}) is inside the comment`
        ).toBe(true);
      }

      // Four commas and two semicolons are written as delimiters in this file; the pair inside the
      // comment adds to neither count.
      expect(of(tokens, 'separator')).toHaveLength(4);
      expect(of(tokens, 'terminator')).toHaveLength(2);
    });
  });

  describe('without a parse and without a schema', () => {
    it('classifies text that does not parse, completely', () => {
      for (const name of ['single-unterminated-word', 'unterminated-final-statement']) {
        const { text, layer, tokens } = classified(name);

        // "Does not parse" is shown rather than asserted by naming: `lex` reports the grammar
        // violation and drops the statement it could not terminate, so the reader ends up with
        // strictly fewer objects than the text wrote statements.
        const diagnostics: LexDiagnostic[] = [];
        const objects = lex(text, { onDiagnostic: (d) => diagnostics.push(d) });
        expect(diagnostics.length, name).toBeGreaterThan(0);
        expect(objects.length, name).toBeLessThan(layer.statements.length);

        // The layer represents the violation instead of stopping at it, so every character is
        // still classified: colouring a file somebody is halfway through typing is the point.
        expect(coverageBreaks(layer, tokens), name).toEqual([]);
        expect(layer.statements.at(-1)?.unterminated, name).toBe(true);
      }
    });

    it('classifies with no schema available at all', () => {
      // There is no schema in the call because there is no parameter for one: `scanIdf` takes text
      // and nothing else, and `classify` takes the layer and nothing else. That is what FR-006
      // claims, and an arity is how the claim is observable from outside.
      expect(scanIdf).toHaveLength(1);
      expect(classify).toHaveLength(1);

      // Two files no schema resolves for: one declaring no version at all, one declaring a version
      // this repository ships nothing for. Both classify, and both distinguish all five kinds.
      for (const name of ['no-version-declared', 'unsupported-version']) {
        const { layer, tokens } = classified(name);
        expect(coverageBreaks(layer, tokens), name).toEqual([]);
        const kinds = tokens.map((token) => token.kind);
        for (const kind of MEANINGFUL_KINDS) {
          expect(kinds, `${name}: no ${kind} token`).toContain(kind);
        }
      }
    });
  });

  describe('line boundaries', () => {
    // `Zone,\n  My\n  Zone,\n  0.0;\n`: one field written across two lines. The two assertions
    // below are the point of that fixture, and they are kept apart deliberately. A regression that
    // stopped splitting fails the second alone; a regression that stopped storing whole regions,
    // cutting the field at the newline on the way in, fails the first alone.

    it('stores a value region that does span a line boundary', () => {
      const { text, layer } = classified('value-across-two-lines');
      const name = layer.statements[0]?.fields[0];

      // Stated here so that a fixture quietly reformatted, which the corpus README warns against,
      // fails as itself rather than as a puzzling assertion about offsets further down.
      expect(text).toBe('Zone,\n  My\n  Zone,\n  0.0;\n');
      expect(name).toBeDefined();
      expect(text.slice(name!.start, name!.end)).toBe('My\n  Zone');
      expect(lineColumnAt(layer, name!.start).line).toBe(2);
      expect(lineColumnAt(layer, name!.end - 1).line).toBe(3);
    });

    it('yields no token that does, while coverage stays exact', () => {
      const { text, layer, tokens } = classified('value-across-two-lines');
      const stored = layer.statements[0]!.fields[0]!;

      const crossing = tokens
        .filter((token) => crossesLine(layer, token))
        .map((token) => `${token.kind} [${token.start},${token.end})`);
      expect(crossing).toEqual([]);
      expect(coverageBreaks(layer, tokens)).toEqual([]);

      // The split adds tokens and moves no boundary, so the halves of the stored region are still
      // exactly the stored region.
      const halves = of(tokens, 'value').filter(
        (token) => token.start >= stored.start && token.end <= stored.end
      );
      expect(halves).toHaveLength(2);
      expect(halves.map((token) => text.slice(token.start, token.end)).join('')).toBe('My\n  Zone');
    });

    it('yields no token that crosses a line boundary, anywhere in the corpus (SC-017)', () => {
      for (const fixture of syntaxFixtures()) {
        const layer = scanIdf(fixture.text);
        const tokens = [...classify(layer)];
        const crossing = tokens
          .filter((token) => crossesLine(layer, token))
          .map((token) => `${token.kind} [${token.start},${token.end})`);

        expect(crossing, fixture.name).toEqual([]);
        expect(coverageBreaks(layer, tokens), fixture.name).toEqual([]);
      }
    });
  });
});
