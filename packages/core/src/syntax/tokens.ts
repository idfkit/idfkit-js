import type { Region } from './region.js';

/**
 * What a span of text is, grammatically. Nothing here needs a schema: the layer records what the
 * text says and never what it means, so a `value` is a value whether or not the field exists.
 */
export type TokenKind =
  | 'typeName' // the statement's first field
  | 'value' // any other field's text
  | 'separator' // a comma
  | 'terminator' // a semicolon
  | 'comment' // an exclamation mark to end of line, the mark included
  | 'trivia'; // whitespace between meaningful tokens; never stored, only yielded

/**
 * One token, materialised.
 *
 * A `Token` *is* a `Region` rather than carrying one, which keeps a classified stream to one
 * object per token instead of two. On a file of forty thousand lines that difference is the
 * difference between an editor that repaints and one that stutters, and a token still passes
 * anywhere a region is expected.
 *
 * A materialised token never crosses a line boundary; a stored `value` region may, because the
 * format lets a field be written across two lines, and the classification view splits it.
 */
export interface Token extends Region {
  readonly kind: TokenKind;
}

/** Kind codes, in the order the union declares them. The index is what `kinds` stores. */
const KIND_BY_CODE: readonly TokenKind[] = [
  'typeName',
  'value',
  'separator',
  'terminator',
  'comment',
  'trivia',
];

const CODE_BY_KIND: Readonly<Record<TokenKind, number>> = {
  typeName: 0,
  value: 1,
  separator: 2,
  terminator: 3,
  comment: 4,
  trivia: 5,
};

/** Where growth starts. Small enough for a one-statement file, large enough to skip early copies. */
const INITIAL_CAPACITY = 64;

/**
 * Every token of one text, packed into three parallel arrays.
 *
 * Nine bytes per token, against upwards of forty for an object: a start, an end, and a kind code,
 * held in `Int32Array`, `Int32Array` and `Uint8Array`. On a reference model of ten thousand
 * statements that is roughly 3.6 MB rather than upwards of 16 MB.
 *
 * This is a contract rather than an implementation note. The intended use is an editor holding
 * several large files open at once, and a layer that allocated an object per token would pass
 * every correctness test while being unusable there. So `Token` objects are materialised only when
 * a caller asks for one, which for classification means only for the tokens actually drawn.
 *
 * The store knows nothing of the scanner that fills it or of the layer that holds it, and nothing
 * of the text either: it holds positions, and the text they index stays with the layer.
 */
export class TokenStore implements Iterable<Token> {
  #starts: Int32Array;
  #ends: Int32Array;
  #kinds: Uint8Array;
  #length = 0;

  constructor(capacity: number = INITIAL_CAPACITY) {
    const initial = Math.max(0, Math.trunc(capacity));
    this.#starts = new Int32Array(initial);
    this.#ends = new Int32Array(initial);
    this.#kinds = new Uint8Array(initial);
  }

  /** How many tokens are stored. The arrays below are longer than this; they carry slack. */
  get length(): number {
    return this.#length;
  }

  /**
   * Start offsets, in source order.
   *
   * A view over the live buffer, trimmed to `length`, for a consumer that wants to walk the
   * positions without materialising anything. It is invalidated by the next {@link push}, which in
   * practice means it is safe for as long as the layer is: nothing appends to a built layer.
   */
  get starts(): Int32Array {
    return this.#starts.subarray(0, this.#length);
  }

  /** End offsets, exclusive, in source order. A live view, like {@link starts}. */
  get ends(): Int32Array {
    return this.#ends.subarray(0, this.#length);
  }

  /** Kind codes, indices into the `TokenKind` union. A live view, like {@link starts}. */
  get kinds(): Uint8Array {
    return this.#kinds.subarray(0, this.#length);
  }

  /** Append one token and return its index. Grows geometrically, so a scan stays linear. */
  push(start: number, end: number, kind: TokenKind): number {
    const index = this.#length;
    if (index === this.#starts.length) this.#grow();
    this.#starts[index] = start;
    this.#ends[index] = end;
    this.#kinds[index] = CODE_BY_KIND[kind];
    this.#length = index + 1;
    return index;
  }

  /** The start offset of one token. */
  startAt(index: number): number {
    return this.#starts[this.#checked(index)]!;
  }

  /** The end offset of one token, exclusive. */
  endAt(index: number): number {
    return this.#ends[this.#checked(index)]!;
  }

  /** The kind of one token. */
  kindAt(index: number): TokenKind {
    return KIND_BY_CODE[this.#kinds[this.#checked(index)]!]!;
  }

  /** The stored kind code of one token, for a consumer encoding kinds numerically. */
  kindCodeAt(index: number): number {
    return this.#kinds[this.#checked(index)]!;
  }

  /**
   * Build a `Token` object for one stored token.
   *
   * The only place a token becomes an object. Called for the tokens a consumer actually reads, and
   * never on the way in.
   */
  materialise(index: number): Token {
    const at = this.#checked(index);
    return {
      start: this.#starts[at]!,
      end: this.#ends[at]!,
      kind: KIND_BY_CODE[this.#kinds[at]!]!,
    };
  }

  /**
   * Every stored token, materialised one at a time.
   *
   * Convenient rather than cheap: it allocates per token, so a consumer colouring a viewport reads
   * the arrays or goes through `classify`, which yields only what it is asked for. Note that this
   * yields stored tokens alone, so the gaps between them are not covered; `trivia` is never stored
   * and is computed as the complement.
   */
  *[Symbol.iterator](): IterableIterator<Token> {
    for (let index = 0; index < this.#length; index += 1) yield this.materialise(index);
  }

  #checked(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.#length) {
      throw new RangeError(`No token at index ${index} (${this.#length} stored)`);
    }
    return index;
  }

  #grow(): void {
    const capacity = this.#starts.length === 0 ? INITIAL_CAPACITY : this.#starts.length * 2;
    const starts = new Int32Array(capacity);
    const ends = new Int32Array(capacity);
    const kinds = new Uint8Array(capacity);
    starts.set(this.#starts);
    ends.set(this.#ends);
    kinds.set(this.#kinds);
    this.#starts = starts;
    this.#ends = ends;
    this.#kinds = kinds;
  }
}
