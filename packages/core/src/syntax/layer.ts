import { scan, type ScanHandler } from '../parse/scan.js';
import type { Region } from './region.js';
import { TokenStore, type TokenKind } from './tokens.js';

/**
 * One statement as the text writes it, terminated or not.
 *
 * Not an object in the model and carrying no schema meaning (FR-006): a statement whose type the
 * schema never heard of, or which carries twice the fields its type defines, is still a statement.
 * Deciding what any of it means is the reader's job, and the layer is what a reader positions
 * against.
 */
export interface Statement {
  /** The whole statement, from its first non-blank character through its terminator. */
  readonly region: Region;
  /** Just the type name. Empty, at the offset one would have begun, when none was written. */
  readonly typeName: Region;
  /** Type name text, exactly as written and not case-folded. */
  readonly typeNameText: string;
  /**
   * Fields after the type name, in positional order, one region each.
   *
   * Index 0 is the first field after the type name, matching `RawObject.values`, which has already
   * had the type name shifted off. A field written empty still gets a region, an empty one
   * positioned where its value would have begun, so that positional indexing never shifts and a
   * blank slot in the middle of an extensible group can still be pointed at.
   *
   * The count is what was written rather than what the type defines. A statement carrying more or
   * fewer fields than its type is a finding, not a representation problem.
   */
  readonly fields: readonly Region[];
  /** True when no terminator was found, meaning the statement runs to end of input. */
  readonly unterminated: boolean;
}

/**
 * Everything the text contains and where it was.
 *
 * The layer holds the text it was built from, which is what makes byte-identical reconstruction a
 * consequence rather than a feature: a reconstruction defined as concatenating slices of that text
 * returns the text by construction. What can actually break is the tiling, so that is what the
 * corpus test asserts and what {@link classify} makes observable.
 *
 * Nothing builds a layer implicitly (FR-005). `lex` and `parseIdf` read the same characters
 * through the same scan and construct none of this, so a caller who never names `scanIdf` pays
 * neither its time nor its memory.
 */
export interface SyntaxLayer {
  /** The text this layer was built from. Held so regions can be resolved. */
  readonly text: string;
  /** Statements in source order. */
  readonly statements: readonly Statement[];
  /** Every meaningful token in source order, packed. Whitespace is not among them. */
  readonly tokens: TokenStore;
}

/**
 * Scan IDF text into a syntax layer.
 *
 * Text and nothing else: no schema, because the layer records what the text says and never what it
 * means (FR-006). It never throws, for any input, and text that violates the grammar is
 * represented rather than stopped at (FR-004): an unterminated final statement runs to end of
 * input and says so, a statement written without a type name still tiles, and empty text produces
 * a layer with no statements and no tokens, which satisfies the tiling invariant vacuously.
 *
 * One linear pass over the shared scan, which is the same pass `lex` makes. The budget is a
 * quarter over a plain read of the same text; the work above the scan is a push per token and a
 * record per statement.
 */
export function scanIdf(text: string): SyntaxLayer {
  const collector = layerCollector(text);
  scan(text, collector.handler);
  return collector.finish();
}

/**
 * The layer's own scan handler, and the layer it builds, separately.
 *
 * Split out so that a caller which wants the layer AND something else from the same characters can
 * have both from one pass. The preserving read is that caller: it wants the layer and the raw
 * objects, and running the scan twice would double the cost of the one option this library asks a
 * caller to pay for.
 *
 * The handler is exactly what {@link scanIdf} passes, unchanged, so the layer a composed pass
 * builds is the layer `scanIdf` builds. Nothing here decides anything the single-pass version did
 * not.
 *
 * @internal
 */
export function layerCollector(text: string): {
  handler: ScanHandler;
  finish: () => SyntaxLayer;
} {
  const tokens = new TokenStore(initialCapacity(text.length));
  const statements: Statement[] = [];

  /**
   * Comments seen since the last field closed, as flat `[start, end]` pairs in source order.
   *
   * They are buffered rather than pushed on sight because a comment can interrupt a field, in
   * which case the scan reports it before the field it sits inside: the field's own bounds are
   * only known once the field closes. Emitting them at that point, ordered against the value,
   * is what keeps the store in source order.
   */
  const comments: number[] = [];
  /** Index into {@link comments} of the first pair not yet pushed. */
  let nextComment = 0;
  /** Raw text runs of the field being read, as flat `[start, end]` pairs in source order. */
  const runs: number[] = [];

  /** Offset the current statement opened at. */
  let openedAt = 0;
  /** The current statement's type name, replaced when its field closes. */
  let typeName: Region = EMPTY_REGION;
  /** The current statement's fields. Reassigned per statement, so a pushed record keeps its own. */
  let fields: Region[] = [];

  /** Push every buffered comment that begins before `offset`, keeping the store in source order. */
  const flushComments = (offset: number): void => {
    while (nextComment < comments.length && comments[nextComment]! < offset) {
      tokens.push(comments[nextComment]!, comments[nextComment + 1]!, 'comment');
      nextComment += 2;
    }
  };

  const handler: ScanHandler = {
    statementStart(offset) {
      openedAt = offset;
      fields = [];
    },

    /**
     * The runs are recorded only for the sake of a field written on both sides of a comment that
     * interrupts it. Every other reader of this scan wants the field's value, which arrives whole
     * below.
     */
    fieldText(start, end) {
      runs.push(start, end);
    },

    fieldEnd(index, start, end) {
      const region: Region = { start, end };
      if (index === 0) typeName = region;
      else fields.push(region);

      const kind: TokenKind = index === 0 ? 'typeName' : 'value';
      flushComments(start);
      // A field written empty has an empty region, which is a position rather than a span, so it
      // is recorded above and is no token.
      if (end > start) tokens.push(start, end, kind);

      // Only a comment can separate two runs of one field, so a run beginning at or after the
      // value ends is text written after an interrupting comment: `A !- why\n B,` writes both `A`
      // and `B` into one field. The scan bounds the value at `A` deliberately, so that a value
      // region and a comment region can never overlap, which leaves `B` reached by no region at
      // all, and a gap holding something other than whitespace is what the tiling invariant
      // forbids. Every other run holds the value itself or the whitespace before it, and both
      // begin before it ends, so a well-formed field never enters the body and never allocates.
      for (let at = 0; at < runs.length; at += 2) {
        const runStart = runs[at]!;
        if (runStart < end) continue;
        const runEnd = runs[at + 1]!;
        const raw = text.slice(runStart, runEnd);
        const from = runStart + (raw.length - raw.trimStart().length);
        const to = runEnd - (raw.length - raw.trimEnd().length);
        if (from >= to) continue;
        flushComments(from);
        tokens.push(from, to, kind);
      }

      flushComments(Infinity);

      comments.length = 0;
      nextComment = 0;
      runs.length = 0;
    },

    separator(offset) {
      tokens.push(offset, offset + 1, 'separator');
    },

    terminator(offset) {
      tokens.push(offset, offset + 1, 'terminator');
    },

    comment(start, end) {
      comments.push(start, end);
    },

    statementEnd(end, unterminated) {
      statements.push({
        region: { start: openedAt, end },
        typeName,
        typeNameText: text.slice(typeName.start, typeName.end),
        fields,
        unterminated,
      });
    },
  };

  return {
    handler,
    finish: () => {
      // Comments after the last terminator close no field, so nothing has flushed them. Text that
      // is only comments reaches here having reported no statement at all.
      flushComments(Infinity);
      return { text, statements, tokens };
    },
  };
}

/**
 * Stands in until a statement's first field closes, which it always does before the statement
 * ends, so no statement is ever recorded holding this.
 */
const EMPTY_REGION: Region = { start: 0, end: 0 };

/**
 * A starting size for the token store, so a large file does not grow it a dozen times.
 *
 * A commented IDF line runs to about a dozen characters per token, so one per sixteen undershoots
 * slightly and costs at most one doubling, which is the safer side to be wrong on: a file that is
 * mostly whitespace or mostly comment would otherwise pay for capacity it never fills.
 */
function initialCapacity(length: number): number {
  return length < 1024 ? 64 : length >> 4;
}
