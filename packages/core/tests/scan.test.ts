import { beforeAll, describe, expect, it } from 'vitest';

import { classify, lex, parseIdf, scanIdf, type RawObject, type SyntaxLayer } from '@idfkit/core';
import type { Schema } from '@idfkit/schemas';

import { schema, syntaxFixture, syntaxFixtures, type SyntaxFixture } from './helpers.js';

let v26: Schema;
beforeAll(async () => {
  v26 = await schema('26.1.0');
});

const corpus = syntaxFixtures();

/**
 * The six clauses of the tiling invariant, verbatim from `contracts/syntax-layer.md`.
 *
 * Numbered here so a failure can name the clause a reader can then go and read, rather than
 * describing it in whatever words the assertion happened to use.
 */
const CLAUSES = [
  'tokens are in source order',
  'no token is empty or inverted',
  'no two tokens overlap',
  'every token lies within [0, text.length]',
  'every character in a gap between two tokens is whitespace',
  'with gaps filled as trivia, the sequence begins at 0 and ends at text.length',
] as const;

/**
 * Fail one clause, at one token, in one fixture.
 *
 * The whole point of this file is that a breakage is legible. `expect(rebuilt).toBe(text)` on a
 * 4 KB fixture reports that two strings differ and leaves a reader to diff them; the invariant is
 * six separate properties and exactly one of them will have broken, so the message says which one,
 * at which token index, and with the offsets involved.
 */
function fail(clause: number, index: number, detail: string, fixture: string): never {
  throw new Error(
    `clause ${clause} (${CLAUSES[clause - 1]}) failed at token ${index}: ${detail} in fixture ${fixture}.idf`
  );
}

/** `[start,end)`, the notation the contract writes regions in. */
function span(start: number, end: number): string {
  return `[${start},${end})`;
}

/** Offset of the first non-whitespace character in `text`, or -1. `\s` is what `trim` trims. */
function firstNonSpace(text: string): number {
  return text.search(/\S/);
}

/**
 * The positions of a token stream, and nothing else.
 *
 * The clause walk needs three numbers per token and no behaviour, so it asks for exactly that. A
 * `TokenStore` satisfies this, which is what lets the corpus pass one straight in, and so does a
 * hand-built stream, which is what lets the negative control below break a clause on purpose
 * without having to construct a store in an invalid state.
 */
interface TokenSpans {
  readonly length: number;
  readonly starts: Int32Array;
  readonly ends: Int32Array;
}

/**
 * Clauses 1 to 5, over the stored tokens, in one forward walk.
 *
 * One pass rather than five, because each clause is a comparison against the token before and the
 * order they are checked in matters: an offset outside the text (clause 4) makes every message the
 * other four could produce nonsense, and an out-of-order token (clause 1) makes "overlap" and
 * "gap" undefined. So the checks run in the order that keeps the message true.
 */
function assertStoredTiling(fixture: SyntaxFixture, text: string, tokens: TokenSpans): void {
  const starts = tokens.starts;
  const ends = tokens.ends;

  let previousStart = 0;
  let previousEnd = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const start = starts[index]!;
    const end = ends[index]!;

    if (start < 0 || end > text.length) {
      fail(4, index, `${span(start, end)} is outside [0,${text.length}]`, fixture.name);
    }

    if (end < start) fail(2, index, `${span(start, end)} is inverted`, fixture.name);
    if (end === start) fail(2, index, `${span(start, end)} is empty`, fixture.name);

    if (index > 0) {
      if (start < previousStart) {
        fail(
          1,
          index,
          `${span(start, end)} begins before token ${index - 1} at ${span(previousStart, previousEnd)}`,
          fixture.name
        );
      }
      if (start < previousEnd) {
        fail(
          3,
          index,
          `${span(previousStart, previousEnd)} overlaps ${span(start, end)}`,
          fixture.name
        );
      }
      if (start > previousEnd) {
        const gap = text.slice(previousEnd, start);
        const at = firstNonSpace(gap);
        if (at >= 0) {
          fail(
            5,
            index,
            `the gap ${span(previousEnd, start)} before it holds ${JSON.stringify(gap[at])} at offset ${previousEnd + at}`,
            fixture.name
          );
        }
      }
    }

    previousStart = start;
    previousEnd = end;
  }
}

/**
 * Clause 6, and the head and tail's share of clause 5.
 *
 * Clause 6 is a statement about the sequence with its gaps filled, so it is checked against
 * `classify`, which is the thing that fills them, rather than against arithmetic of this file's
 * own. Walking that sequence also covers the two regions clause 5 does not reach, the text before
 * the first token and after the last: those are not gaps *between* two tokens, but `classify`
 * hands them back as `trivia`, and a trivia token holding a letter would mean the fill was not
 * trivia at all. So every yielded trivia token is checked to be whitespace here.
 */
function assertFilledTiling(fixture: SyntaxFixture, layer: SyntaxLayer): void {
  const { text } = layer;

  let covered = 0;
  let index = 0;
  for (const token of classify(layer)) {
    if (token.start !== covered) {
      const detail =
        index === 0
          ? `the sequence begins at ${token.start} rather than at 0`
          : `${span(token.start, token.end)} leaves ${span(covered, token.start)} covered by nothing`;
      fail(6, index, detail, fixture.name);
    }
    if (token.kind === 'trivia') {
      const filled = text.slice(token.start, token.end);
      const at = firstNonSpace(filled);
      if (at >= 0) {
        fail(
          5,
          index,
          `the trivia filling ${span(token.start, token.end)} holds ${JSON.stringify(filled[at])} at offset ${token.start + at}`,
          fixture.name
        );
      }
    }
    covered = token.end;
    index += 1;
  }

  if (covered !== text.length) {
    fail(
      6,
      index - 1,
      `the sequence ends at ${covered} rather than at ${text.length}`,
      fixture.name
    );
  }
}

describe('the tiling invariant', () => {
  it('has a corpus to hold it against', () => {
    // A property asserted over an empty list passes. Naming the count here is what stops a broken
    // fixture loader from turning every test below into a green no-op.
    expect(corpus.length).toBeGreaterThanOrEqual(16);
  });

  it.each(corpus)('holds over $name', (fixture) => {
    const layer = scanIdf(fixture.text);
    assertStoredTiling(fixture, layer.text, layer.tokens);
    assertFilledTiling(fixture, layer);
  });

  it('holds vacuously for empty text', () => {
    const layer = scanIdf('');

    expect(layer.statements).toEqual([]);
    expect(layer.tokens.length).toBe(0);
    expect([...classify(layer)]).toEqual([]);
  });

  it('reports the clause and the token index rather than a string difference', () => {
    // The assertion about the assertions. A test whose failure reads "expected 'Zone,\n  Zone
    // One,...' to be 'Zone,\n  Zone One,...'" costs a reader the afternoon this file exists to save
    // them, so the shape of the message is itself checked. Clause 3 is broken deliberately, on a
    // real fixture's real token positions, and the message the walker produces is read back.
    const fixture = corpus.find((entry) => entry.name === 'line-endings-lf')!;
    const layer = scanIdf(fixture.text);
    const ends = layer.tokens.ends.slice();
    // The first token widened by one character, so it runs into the separator that follows it.
    ends[0] = layer.tokens.starts[1]! + 1;
    const overlapping: TokenSpans = {
      length: layer.tokens.length,
      starts: layer.tokens.starts,
      ends,
    };

    expect(() => assertStoredTiling(fixture, layer.text, overlapping)).toThrow(
      /^clause 3 \(no two tokens overlap\) failed at token 1: \[\d+,\d+\) overlaps \[\d+,\d+\) in fixture line-endings-lf\.idf$/
    );
  });
});

/**
 * Byte-identical reconstruction (SC-003, FR-010).
 *
 * This follows from the invariant above rather than standing alone. The layer holds the text, so a
 * reconstruction defined as concatenating slices of that text returns the text by construction:
 * what it can prove is that the traversal is total, not that slicing works. It is asserted anyway
 * because it is the property the specification names and because it fails loudly if `classify`
 * ever stops early, and it sits below the clause walk so that a reader who sees both fail reaches
 * for the clause message first.
 */
describe('reconstruction from classify', () => {
  it.each(corpus)('rebuilds $name byte for byte', (fixture) => {
    const layer = scanIdf(fixture.text);
    const rebuilt = [...classify(layer)]
      .map((token) => fixture.text.slice(token.start, token.end))
      .join('');

    expect(rebuilt).toBe(fixture.text);
  });

  it.each(['line-endings-lf', 'line-endings-crlf', 'line-endings-mixed'])(
    'keeps every line ending of %s',
    (name) => {
      const text = syntaxFixture(name);
      const rebuilt = [...classify(scanIdf(text))]
        .map((token) => text.slice(token.start, token.end))
        .join('');

      // Compared on the counts as well as on the text, because a reader looking at a failure of
      // this test wants to know whether a carriage return went missing or a whole line did.
      const carriageReturns = (source: string): number => source.split('\r').length - 1;
      const lineFeeds = (source: string): number => source.split('\n').length - 1;
      expect(carriageReturns(rebuilt)).toBe(carriageReturns(text));
      expect(lineFeeds(rebuilt)).toBe(lineFeeds(text));
      expect(rebuilt).toBe(text);
    }
  );

  it('rebuilds text that does not parse', () => {
    // Named rather than taken from the loop so the claim "including files that do not parse" is
    // checked rather than asserted: each of these four is confirmed to produce a diagnostic before
    // its reconstruction is checked, so the case cannot quietly become a well-formed file.
    const broken = [
      'single-unterminated-word',
      'unterminated-final-statement',
      'missing-terminator-swallows-next',
      'unknown-object-type',
    ];

    for (const name of broken) {
      const text = syntaxFixture(name);
      const { diagnostics } = parseIdf(text, v26, { strict: false });
      expect(
        diagnostics.map((diagnostic) => diagnostic.code),
        `${name} was expected not to parse`
      ).not.toEqual([]);

      const rebuilt = [...classify(scanIdf(text))]
        .map((token) => text.slice(token.start, token.end))
        .join('');
      expect(rebuilt).toBe(text);
    }
  });
});

/**
 * The statements `lex` reports for one text, paired with the statements `scanIdf` reports.
 *
 * `lex` yields an object only for a statement that terminated and carried a type name: an
 * unterminated one becomes a diagnostic and is dropped, and one written with no type name becomes
 * a different diagnostic and is dropped. The layer represents both, because representing what was
 * written is its job. So the correspondence is over the statements that survive that filter, and
 * the filter is spelled out here rather than left implicit, because a test that quietly compared
 * two lists of different lengths would prove nothing.
 */
function pairStatements(text: string): { statements: SyntaxLayer['statements']; raw: RawObject[] } {
  const layer = scanIdf(text);
  return {
    statements: layer.statements.filter(
      (statement) => !statement.unterminated && statement.typeNameText !== ''
    ),
    raw: lex(text),
  };
}

/**
 * The shared scanner's two modes, held against each other (contract: "The shared scanner").
 *
 * This is the test T018 exists for. `lex` and `scanIdf` read the same characters through one scan,
 * and if they ever drift by one character about where a comment ends, findings land on the wrong
 * field and nothing else notices until a file puts a comment somewhere unusual. Comparing the text
 * a field's region selects against the value `lex` assembled is what makes that drift a failure.
 */
describe('scanIdf and lex agree on where every field is', () => {
  it('has statements and fields to compare', () => {
    // Same guard as the corpus count above, one level down: the comparison below is a loop over
    // two lists, and two empty lists agree about everything.
    let statements = 0;
    let fields = 0;
    for (const fixture of corpus) {
      const paired = pairStatements(fixture.text);
      statements += paired.statements.length;
      for (const statement of paired.statements) fields += statement.fields.length;
    }

    // A floor rather than the exact count, because the corpus is meant to grow: a fixture added
    // for one case should be held to every property already proven, not break the guard on them.
    expect(statements).toBeGreaterThanOrEqual(30);
    expect(fields).toBeGreaterThanOrEqual(100);
  });

  it.each(corpus)('positions every field of $name identically', (fixture) => {
    const { text } = fixture;
    const { statements, raw } = pairStatements(text);

    expect(
      statements.length,
      `${fixture.name}: scanIdf reports ${statements.length} terminated, named statements and lex reports ${raw.length} objects`
    ).toBe(raw.length);

    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index]!;
      const object = raw[index]!;
      const where = `${fixture.name}, statement ${index}`;

      expect(
        text.slice(statement.typeName.start, statement.typeName.end),
        `${where}: type name`
      ).toBe(object.typeName);
      expect(statement.typeNameText, `${where}: type name text`).toBe(object.typeName);
      expect(statement.region.start, `${where}: statement offset`).toBe(object.offset);

      expect(
        statement.fields.length,
        `${where}: scanIdf reports ${statement.fields.length} fields and lex reports ${object.values.length} values`
      ).toBe(object.values.length);

      for (let field = 0; field < statement.fields.length; field += 1) {
        const region = statement.fields[field]!;
        const selected = text.slice(region.start, region.end);
        expect(
          selected,
          `${where}, field ${field}: scanIdf selects ${JSON.stringify(selected)} at ${span(region.start, region.end)} and lex reports ${JSON.stringify(object.values[field])}`
        ).toBe(object.values[field]);
      }
    }
  });

  it('positions a field written across two lines on both of its lines', () => {
    // The one shape where a stored region crosses a line boundary, so the two modes have the most
    // room to disagree: `lex` joins the runs and trims, the layer bounds the region.
    const text = syntaxFixture('value-across-two-lines');
    const { statements, raw } = pairStatements(text);

    const region = statements[0]!.fields[0]!;
    expect(text.slice(region.start, region.end)).toBe(raw[0]!.values[0]);
    expect(text.slice(region.start, region.end)).toContain('\n');
  });

  it('positions a value separated from its comma by a comment', () => {
    const text = syntaxFixture('comment-between-separator-and-value');
    const { statements, raw } = pairStatements(text);

    const zone = statements[1]!;
    for (let field = 0; field < zone.fields.length; field += 1) {
      const region = zone.fields[field]!;
      expect(text.slice(region.start, region.end)).toBe(raw[1]!.values[field]);
    }
  });
});

/** How many of the layer's two backing array types were constructed while `body` ran. */
interface LayerAllocations {
  readonly int32: number;
  readonly uint8: number;
}

/**
 * Count `Int32Array` and `Uint8Array` constructions during one synchronous call.
 *
 * The layer's storage is three typed arrays and nothing else: two `Int32Array` for starts and ends
 * and one `Uint8Array` for kinds, allocated in `TokenStore`'s constructor, plus the `Int32Array`
 * line index a position query builds. No other code in this package constructs a typed array at
 * all, so counting these two constructors counts the layer exactly.
 *
 * Structural rather than timed, which is the point: a timing comparison would be measuring the
 * machine, and would still pass on a day the layer was built and thrown away. Swapping the global
 * binding for a counting `Proxy` is sound because the implementation resolves `Int32Array` from
 * the global at construction time, like every other module in this package, and because the
 * assertion below runs a positive control through the same probe. An instrument that catches
 * nothing proves nothing; one that catches `scanIdf` and not `parseIdf` has measured something.
 */
function countLayerAllocations(body: () => void): LayerAllocations {
  const realInt32 = globalThis.Int32Array;
  const realUint8 = globalThis.Uint8Array;
  let int32 = 0;
  let uint8 = 0;

  globalThis.Int32Array = new Proxy(realInt32, {
    construct(target, args, newTarget) {
      int32 += 1;
      return Reflect.construct(target, args, newTarget) as object;
    },
  });
  globalThis.Uint8Array = new Proxy(realUint8, {
    construct(target, args, newTarget) {
      uint8 += 1;
      return Reflect.construct(target, args, newTarget) as object;
    },
  });

  try {
    body();
  } finally {
    globalThis.Int32Array = realInt32;
    globalThis.Uint8Array = realUint8;
  }

  return { int32, uint8 };
}

describe('nothing builds a layer implicitly (FR-005)', () => {
  it('allocates none of the layer while parseIdf and lex read the corpus', () => {
    // Warm first, outside the probe, so a one-time lazy computation inside the schema is not
    // mistaken for the read path allocating. Everything measured below is then a repeat call.
    for (const fixture of corpus) {
      lex(fixture.text);
      parseIdf(fixture.text, v26, { strict: false });
    }

    const allocations = countLayerAllocations(() => {
      for (const fixture of corpus) {
        lex(fixture.text);
        parseIdf(fixture.text, v26, { strict: false });
      }
    });

    expect(allocations).toEqual({ int32: 0, uint8: 0 });
  });

  it('allocates the layer when, and only when, scanIdf is named', () => {
    // The positive control for the assertion above. Same probe, same text, one call difference.
    const text = syntaxFixture('surface-bad-ninth-vertex');

    const withLayer = countLayerAllocations(() => {
      scanIdf(text);
    });
    const withoutLayer = countLayerAllocations(() => {
      parseIdf(text, v26, { strict: false });
    });

    expect(withLayer.int32).toBeGreaterThan(0);
    expect(withLayer.uint8).toBeGreaterThan(0);
    expect(withoutLayer).toEqual({ int32: 0, uint8: 0 });
  });

  it('leaves a parse result carrying no layer', () => {
    // The memory half of FR-005 read from the other end: whatever a caller holds onto after a
    // parse, none of it is a token store, so nothing keeps the layer alive by reference either.
    const text = syntaxFixture('line-endings-lf');
    const result = parseIdf(text, v26, { strict: false });

    expect(Object.keys(result).sort()).toEqual(['diagnostics', 'document']);
  });
});
