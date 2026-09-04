import type { SyntaxLayer } from './layer.js';
import { lineStartsOf } from './region.js';
import type { Token, TokenKind } from './tokens.js';

/**
 * Every character of the text, as tokens, in source order.
 *
 * Two things happen here that the layer deliberately does not pay to store.
 *
 * The first is `trivia`. Whitespace is the complement of the stored tokens, so storing it would
 * roughly double the token count to hold something derivable by subtraction. This function fills
 * each gap as it walks, which is what makes the layer's complete coverage observable (FR-016)
 * without the layer carrying it: the sequence begins at offset 0, ends at `text.length`, and has
 * no gap and no overlap anywhere between.
 *
 * The second is the line split. No yielded token crosses a line boundary (FR-047), while a stored
 * `value` region may, because the format lets a field be written across two lines and real files
 * do it. Every token encoding in use, the Language Server Protocol's included, expresses a token
 * as a length on a single line, so a token spanning one cannot be encoded at all. The split adds
 * tokens and moves no boundary, so the tiling holds exactly as before, and the stored region stays
 * whole for everything that is not being drawn.
 *
 * A generator, so a consumer colouring a viewport stops where it stops rather than materialising
 * four hundred thousand tokens to read the first fifty.
 */
export function* classify(layer: SyntaxLayer): Iterable<Token> {
  const text = layer.text;
  const tokens = layer.tokens;
  const starts = tokens.starts;
  const ends = tokens.ends;
  // The layer's own line index, built once and shared with every position query made against it.
  const lineStarts = lineStartsOf(layer);

  /** The line the walk is on. It only ever moves forward, so the whole pass stays linear. */
  let line = 0;

  /** One token per line the span touches, split at each line start strictly inside it. */
  function* perLine(from: number, to: number, kind: TokenKind): Generator<Token> {
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= from) line += 1;
    let at = from;
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! < to) {
      line += 1;
      const boundary = lineStarts[line]!;
      yield { start: at, end: boundary, kind };
      at = boundary;
    }
    if (at < to) yield { start: at, end: to, kind };
  }

  /** One past the last character yielded so far, which is where the next gap would begin. */
  let covered = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const start = starts[index]!;
    if (start > covered) yield* perLine(covered, start, 'trivia');
    const end = ends[index]!;
    yield* perLine(start, end, tokens.kindAt(index));
    covered = end;
  }
  if (covered < text.length) yield* perLine(covered, text.length, 'trivia');
}
