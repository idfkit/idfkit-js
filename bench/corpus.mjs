#!/usr/bin/env node
/**
 * The reference model the performance budget is measured against (task T001).
 *
 * WHY IT IS GENERATED AND NOT COMMITTED
 *
 * `contracts/performance-budget.md`: "The generator is committed. A benchmark
 * against a file somebody has locally is not a benchmark." A 643 KB blob in the
 * tree would work too, and would be worse in two ways: it cannot be regenerated
 * at a different size without a second blob, and nobody reviewing a change to it
 * can tell what moved. A generator is 20 KB of source whose diff is readable.
 *
 * WHY THE SEED IS FIXED AND `Math.random` IS BANNED HERE
 *
 * The budget is enforced as a RATIO measured within one run, and a ratio only
 * cancels the machine out when both halves ran over the same bytes. Two runs
 * that differ by a few hundred vertices differ by more than the margin being
 * defended, so a benchmark seeded from the clock reports a different number
 * every time and no regression is ever attributable. `makeRandom` below is a
 * mulberry32, twelve lines, no dependency, byte-identical on every Node that
 * has `Math.imul` — which is every Node this repository supports.
 *
 * WHAT THE SHAPE IS FOR
 *
 * The budget's pathological offsets (SC-001, task T059) are properties of the
 * text, not of the harness, so the text has to contain them:
 *
 *   a large comment header       444 lines of it, so the first statement is far
 *                                from offset 0 and a cursor answer there cannot
 *                                be cheap by accident
 *   many extensible repeats      a `BuildingSurface:Detailed` whose vertices run
 *                                for a hundred lines is the longest single
 *                                statement a backward scan can land inside, and
 *                                therefore its worst case
 *   trailing whitespace at EOF   the `betweenStatements` state, which has no
 *                                statement to scan back to at all
 *
 * `cursors` below hands those offsets to the benchmark rather than making it
 * search for them, because a search that runs inside the timed region measures
 * the search.
 *
 * THE FOUR TARGETS, AND WHICH ONES ARE EXACT
 *
 * The contract states four figures: 10,001 statements, 40,002 lines, roughly
 * 643 KB, roughly 400,000 meaningful tokens. What this generator produces:
 *
 *   statements   10,001      exact, asserted by `referenceModel`
 *   lines        40,002      exact, asserted by `referenceModel`
 *   size         641,576 B   0.2 percent under the stated 643 KB
 *   tokens       313,576     against a stated "roughly 400,000"
 *
 * The token figure is the one that misses, and it misses because the other three
 * cannot all be met at once by text that still reads as EnergyPlus. 643 KB over
 * 40,002 lines is 16 bytes a line; 400,000 tokens over the same lines is 10
 * tokens a line. An average line would have to carry ten tokens inside sixteen
 * bytes, which only a dense run of single-character numeric fields does, and a
 * file made of nothing else contains no name, no comment and no annotated field
 * to measure the scanner against. So size is the figure held closest, because
 * size is what every path being measured is linear in, and the token count is
 * reported by `--stats` rather than engineered towards.
 *
 * USAGE
 *
 *   node bench/corpus.mjs                 the reference model, to stdout
 *   node bench/corpus.mjs --small         the one-hundredth-size variant
 *   node bench/corpus.mjs --stats         the measured shape, as JSON
 *
 * and as a module:
 *
 *   import { referenceModel, smallModel, probeOffsetsIn } from './corpus.mjs';
 */

import { pathToFileURL } from 'node:url';

/** The seed. Fixed forever; changing it invalidates every recorded baseline. */
const SEED = 0x1dfc0de;

/** Statements in the reference model, the Version statement included. */
const FULL_STATEMENTS = 10001;

/** Lines in the reference model. Every line, the comment header's included. */
const FULL_LINES = 40002;

/**
 * Comment-header lines in the variant.
 *
 * Not a scaled-down 444: the preamble and its closing rule are nine lines, and
 * they are the same nine lines in both files, so this is close to the smallest
 * header that still says what the file is.
 */
const SMALL_HEADER_LINES = 12;

/**
 * How many statements of each shape the reference model holds.
 *
 * Counts rather than weights, so the composition is a reviewable number instead
 * of the outcome of a thousand coin flips. The variant draws from this same list
 * and stops early rather than scaling it, so the statements it holds are the same
 * statements, not merely the same mix.
 *
 * The counts are what land the size on the contract's 643 KB. One-line statements
 * dominate because their average length decides the file's size almost by itself;
 * vertex runs are the only construct dense enough to keep the token count near
 * the stated figure; annotated statements are the fewest and the most expensive
 * per statement, and are here because they are the only shape that puts a comment
 * between a value and the separator after it.
 */
const COMPOSITION = [
  { shape: 'oneLiner', count: 8719 },
  { shape: 'surface', count: 1000 },
  { shape: 'columnar', count: 200 },
  { shape: 'annotated', count: 80 },
];

/**
 * @typedef {object} ProbeOffsets
 * Offsets into one model's text for the probe statement, which is the same text
 * in the reference model and in the variant. `bench/budget.mjs` asks the same
 * cursor question at each of these in both files and requires the two answers to
 * cost within a small factor of each other; that is the check that a cursor
 * answer's cost grows with the statement rather than with the file.
 * @property {number} statementStart Offset of the probe statement's first character.
 * @property {number} typeName Offset inside its type name.
 * @property {number} fixedField Offset inside a fixed field's value.
 * @property {number} extensibleValue Offset inside the ninth vertex, deep in the extensible run.
 * @property {number} comment Offset inside one of its field comments.
 */

/**
 * @typedef {object} CursorSamples
 * The offsets the percentile run samples, named for what makes each awkward.
 * @property {number} firstStatement Inside the first statement, behind the comment header.
 * @property {number} largeExtensible Inside the last vertex of the longest statement in the file.
 * @property {number} insideComment Inside the comment header.
 * @property {number} betweenStatements Inside a blank line between two statements.
 * @property {number} trailingWhitespace The end of the text, past the last terminator.
 */

/**
 * @typedef {object} GeneratedModel
 * @property {string} text The model itself.
 * @property {number} statements Statements it holds, the Version statement included.
 * @property {number} lines Lines it holds.
 * @property {number} bytes Its length in UTF-8 bytes.
 * @property {number} meaningfulTokens Tokens that are not whitespace, counted by `countMeaningfulTokens`.
 * @property {ProbeOffsets} probe Where the probe statement sits in this text.
 * @property {CursorSamples} cursors Offsets worth sampling in this text.
 */

/**
 * mulberry32. Deterministic, uniform enough for choosing between shapes, and
 * small enough to read in one sitting, which a dependency would not be.
 *
 * @param {number} seed
 * @returns {() => number} the next value in [0, 1)
 */
function makeRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {() => number} random
 * @param {number} lowest inclusive
 * @param {number} highest inclusive
 * @returns {number}
 */
function between(random, lowest, highest) {
  return lowest + Math.floor(random() * (highest - lowest + 1));
}

/**
 * @template T
 * @param {() => number} random
 * @param {readonly T[]} items
 * @returns {T}
 */
function oneOf(random, items) {
  return items[Math.floor(random() * items.length)];
}

/** @param {number} n @param {number} width @returns {string} */
function padded(n, width) {
  return String(n).padStart(width, '0');
}

/**
 * A coordinate, kept short on purpose.
 *
 * Vertex runs are where the size and the token count are decided: a vertex and
 * its commas are six tokens, and at one to three characters a coordinate they are
 * the only construct in the format that gets near the contract's ratio of tokens
 * to bytes. Writing them to six decimal places, which some exporters do, would
 * triple the file for the same token count.
 *
 * @param {() => number} random
 * @returns {string}
 */
function coordinate(random) {
  const roll = random();
  if (roll < 0.88) return String(between(random, 0, 9));
  if (roll < 0.98) return String(between(random, 10, 99));
  return `${between(random, 0, 9)}.${between(random, 0, 9)}`;
}

/* -------------------------------------------------------------------------- */
/* The statement shapes                                                        */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} Statement
 * @property {readonly string[]} lines Its lines, each without its newline.
 * @property {number} [extensibleLine] Index into `lines` of a line deep in an extensible run.
 */

const SHORT_ZONE = (r, i) => `Zone,Z${padded(i, 5)},0,0,0,0;`;
const SHORT_CONSTRUCTION = (r, i) =>
  `Construction,C${padded(i, 5)},M${padded(between(r, 1, 400), 4)};`;
const SHORT_LIMITS = (r, i) => `ScheduleTypeLimits,L${padded(i, 4)},0,1;`;

/**
 * The one-line shapes, listed with repeats rather than with weights.
 *
 * A repeated entry is a weight written in the only unit that matters here,
 * which is bytes: the size of the reference model is decided almost entirely by
 * how long the average one-line statement is, because there are eight thousand
 * of them. Short objects outnumber long ones in real files too, so the list is
 * not distorted to hit a number.
 */
const ONE_LINERS = [
  SHORT_ZONE,
  SHORT_ZONE,
  SHORT_ZONE,
  SHORT_ZONE,
  SHORT_ZONE,
  SHORT_ZONE,
  SHORT_CONSTRUCTION,
  SHORT_CONSTRUCTION,
  SHORT_CONSTRUCTION,
  SHORT_CONSTRUCTION,
  SHORT_LIMITS,
  SHORT_LIMITS,
  (r, i) => `Zone,Z${padded(i, 5)},0,0,0,0,1,1;`,
  (r, i) => `Zone,Z${padded(i, 5)},0,0,0,0,1,1;`,
  (r, i) => `Zone,Z${padded(i, 5)},0,0,0,0,1,1;`,
  (r, i) => `Zone,Z${padded(i, 5)},0,0,0,0,1,1;`,
  (r, i) => `Construction,C${padded(i, 5)},M${padded(between(r, 1, 400), 4)},M0001;`,
  (r, i) => `Schedule:Constant,S${padded(i, 4)},L0001,${between(r, 0, 1)};`,
  (r, i) => `Material:NoMass,M${padded(i, 4)},Rough,2.3,0.9,0.8;`,
  (r) => `Output:Meter,${oneOf(r, METERS)},${oneOf(r, FREQUENCIES)};`,
  (r) => `Output:Variable,*,${oneOf(r, OUTPUT_VARIABLES)},${oneOf(r, FREQUENCIES)};`,
];

const OUTPUT_VARIABLES = [
  'Zone Air Temperature',
  'Zone Air Humidity Ratio',
  'Surface Inside Face Temperature',
  'Zone Mean Radiant Temperature',
];

const METERS = ['Electricity:Facility', 'NaturalGas:Facility', 'Cooling:Electricity'];

const FREQUENCIES = ['Timestep', 'Hourly', 'Daily', 'Monthly', 'RunPeriod'];

/**
 * A dense single-line object. The commonest shape in the file and the one that
 * keeps the average line short.
 *
 * @param {() => number} random
 * @param {number} index
 * @returns {Statement}
 */
function oneLiner(random, index) {
  return { lines: [oneOf(random, ONE_LINERS)(random, index)] };
}

/**
 * A `BuildingSurface:Detailed` with a vertex run, written two vertices to the
 * line, which is how a geometry exporter writes them.
 *
 * The vertex count is drawn wide on purpose: three in five surfaces have four
 * vertices, three in ten have a few dozen, and better than one in ten runs to
 * between a hundred and two hundred and eighty. That last case is the one the
 * budget's worst offset lands in, and it is why the tail is here at all.
 *
 * @param {() => number} random
 * @param {number} index
 * @returns {Statement}
 */
function detailedSurface(random, index) {
  const roll = random();
  const vertices =
    roll < 0.58 ? 4 : roll < 0.88 ? between(random, 8, 40) : between(random, 100, 280);
  const lines = [
    `BuildingSurface:Detailed,S${padded(index, 5)},${oneOf(random, SURFACE_TYPES)},` +
      `C${padded(between(random, 1, 400), 5)},Z${padded(between(random, 1, 900), 5)},` +
      `Outdoors,,SunExposed,WindExposed,,${vertices},`,
  ];
  for (let pair = 0; pair < Math.ceil(vertices / 2); pair += 1) {
    const remaining = vertices - pair * 2;
    const written = remaining >= 2 ? 2 : 1;
    const coordinates = [];
    for (let v = 0; v < written; v += 1) {
      coordinates.push(coordinate(random), coordinate(random), coordinate(random));
    }
    const last = pair === Math.ceil(vertices / 2) - 1;
    lines.push(`${coordinates.join(',')}${last ? ';' : ','}`);
  }
  return { lines, extensibleLine: lines.length - 1 };
}

const SURFACE_TYPES = ['Wall', 'Roof', 'Floor', 'Ceiling'];

/**
 * One field to a line with no annotation, which is the other way real files are
 * written and the shape that pushes the line count up without pushing the byte
 * count up with it.
 *
 * @param {() => number} random
 * @param {number} index
 * @returns {Statement}
 */
function columnar(random, index) {
  const shape = oneOf(random, COLUMNAR_SHAPES);
  const values = shape.values(random, index);
  const lines = [`${shape.typeName},`];
  values.forEach((value, position) => {
    lines.push(`  ${value}${position === values.length - 1 ? ';' : ','}`);
  });
  return { lines };
}

const COLUMNAR_SHAPES = [
  {
    typeName: 'Zone',
    values: (r, i) => [`Z${padded(i, 5)}`, '0', '0', '0', '0', '1', '1'],
  },
  {
    typeName: 'Material',
    values: (r, i) => [`M${padded(i, 4)}`, 'MediumRough', '0.1', '0.6', '1400', '1000'],
  },
  {
    typeName: 'ZoneInfiltration:DesignFlowRate',
    values: (r, i) => [
      `I${padded(i, 4)}`,
      `Z${padded(between(r, 1, 900), 5)}`,
      `S${padded(between(r, 1, 400), 4)}`,
      'AirChanges/Hour',
      '',
      '',
      '',
      '0.5',
    ],
  },
  {
    typeName: 'Schedule:Compact',
    values: (r, i) => [
      `S${padded(i, 4)}`,
      'Any Number',
      'Through: 12/31',
      'For: AllDays',
      'Until: 24:00',
      String(between(r, 0, 1)),
    ],
  },
];

/**
 * The annotated shape: one field to a line with a `!- Field Name` comment beside
 * it, which is what the EnergyPlus IDF editor writes and what most real files
 * look like.
 *
 * It is the most expensive shape per statement and the least token-dense, so its
 * share is small. It is not optional, though: it is the only shape that puts a
 * comment between a value and the separator that follows it, which is the case
 * the scanner most easily gets wrong.
 *
 * @param {() => number} random
 * @param {number} index
 * @returns {Statement}
 */
function annotated(random, index) {
  const shape = oneOf(random, ANNOTATED_SHAPES);
  const values = shape.values(random, index);
  const lines = [`${shape.typeName},`];
  values.forEach(([value, fieldName], position) => {
    const written = `  ${value}${position === values.length - 1 ? ';' : ','}`;
    lines.push(`${written.padEnd(26, ' ')}!- ${fieldName}`);
  });
  return { lines };
}

const ANNOTATED_SHAPES = [
  {
    typeName: 'Lights',
    values: (r, i) => [
      [`LIGHTS_${padded(i, 4)}`, 'Name'],
      [`Z${padded(between(r, 1, 900), 5)}`, 'Zone or ZoneList Name'],
      [`S${padded(between(r, 1, 400), 4)}`, 'Schedule Name'],
      ['Watts/Area', 'Design Level Calculation Method'],
      ['', 'Lighting Level {W}'],
      ['10.76', 'Watts per Zone Floor Area {W/m2}'],
      ['', 'Watts per Person {W/person}'],
      ['0.0', 'Return Air Fraction'],
      ['0.72', 'Fraction Radiant'],
      ['0.18', 'Fraction Visible'],
    ],
  },
  {
    typeName: 'People',
    values: (r, i) => [
      [`PEOPLE_${padded(i, 4)}`, 'Name'],
      [`Z${padded(between(r, 1, 900), 5)}`, 'Zone or ZoneList Name'],
      [`S${padded(between(r, 1, 400), 4)}`, 'Number of People Schedule Name'],
      ['People/Area', 'Number of People Calculation Method'],
      ['', 'Number of People'],
      ['0.05', 'People per Zone Floor Area {person/m2}'],
      ['', 'Zone Floor Area per Person {m2/person}'],
      ['0.3', 'Fraction Radiant'],
    ],
  },
  {
    typeName: 'WindowMaterial:Glazing',
    values: (r, i) => [
      [`GLZ_${padded(i, 4)}`, 'Name'],
      ['SpectralAverage', 'Optical Data Type'],
      ['', 'Window Glass Spectral Data Set Name'],
      ['0.003', 'Thickness {m}'],
      ['0.837', 'Solar Transmittance at Normal Incidence'],
      ['0.075', 'Front Side Solar Reflectance at Normal Incidence'],
      ['0.075', 'Back Side Solar Reflectance at Normal Incidence'],
      ['0.898', 'Visible Transmittance at Normal Incidence'],
    ],
  },
];

/** @type {Record<string, (random: () => number, index: number) => Statement>} */
const SHAPES = {
  oneLiner,
  surface: detailedSurface,
  columnar,
  annotated,
};

/* -------------------------------------------------------------------------- */
/* The probe statement                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The one statement that is literal rather than generated.
 *
 * `contracts/performance-budget.md` requires the same cursor answer measured on
 * the reference model and on a file one hundredth its size, "with the cursor in a
 * statement of the same shape". Same shape is not enough to compare offsets
 * against, so this is the same TEXT, inserted at the same fraction of the way
 * through both files. What differs between the two measurements is then the size
 * of the file around it, which is exactly the variable under test.
 *
 * Twelve vertices: long enough that the backward scan has real work to do, short
 * enough that it is an ordinary statement rather than the worst case, which
 * `cursors.largeExtensible` covers separately.
 */
const PROBE_LINES = [
  'BuildingSurface:Detailed,',
  '  PROBE_SURFACE,          !- Name',
  '  Wall,                   !- Surface Type',
  '  PROBE_CONSTRUCTION,     !- Construction Name',
  '  PROBE_ZONE,             !- Zone Name',
  '  Outdoors,               !- Outside Boundary Condition',
  '  ,                       !- Outside Boundary Condition Object',
  '  SunExposed,             !- Sun Exposure',
  '  WindExposed,            !- Wind Exposure',
  '  0.5,                    !- View Factor to Ground',
  '  12,                     !- Number of Vertices',
  '  0.0,0.0,3.0,            !- Vertex 1',
  '  4.0,0.0,3.0,            !- Vertex 2',
  '  8.0,0.0,3.0,            !- Vertex 3',
  '  12.0,0.0,3.0,           !- Vertex 4',
  '  12.0,4.0,3.0,           !- Vertex 5',
  '  12.0,8.0,3.0,           !- Vertex 6',
  '  8.0,8.0,3.0,            !- Vertex 7',
  '  4.0,8.0,3.0,            !- Vertex 8',
  '  0.0,8.0,3.0,            !- Vertex 9',
  '  0.0,4.0,3.0,            !- Vertex 10',
  '  0.0,2.0,3.0,            !- Vertex 11',
  '  0.0,0.0,3.0;            !- Vertex 12',
];

const PROBE_TEXT = `${PROBE_LINES.join('\n')}\n`;

/** The first line of the probe, which is what `probeOffsetsIn` searches for. */
const PROBE_ANCHOR = `${PROBE_LINES[0]}\n${PROBE_LINES[1]}`;

/**
 * Offsets inside `PROBE_TEXT`, relative to its own start. Computed once, from the
 * text, so that editing a line above cannot silently move a cursor onto a comma.
 *
 * @type {ProbeOffsets}
 */
const PROBE_RELATIVE = {
  statementStart: 0,
  typeName: 'Building'.length,
  fixedField: PROBE_TEXT.indexOf('Wall') + 2,
  extensibleValue: PROBE_TEXT.indexOf('0.0,8.0,3.0') + 4,
  comment: PROBE_TEXT.indexOf('!- Surface Type') + 3,
};

/**
 * Where the probe statement sits in a model's text.
 *
 * Exported so a caller that has only the text, having written it out with
 * `node bench/corpus.mjs > model.idf`, can still find it without searching for a
 * shape by eye.
 *
 * @param {string} text
 * @returns {ProbeOffsets}
 */
export function probeOffsetsIn(text) {
  const start = text.indexOf(PROBE_ANCHOR);
  if (start === -1) {
    throw new Error('this text holds no probe statement; it did not come from bench/corpus.mjs');
  }
  return {
    statementStart: start,
    typeName: start + PROBE_RELATIVE.typeName,
    fixedField: start + PROBE_RELATIVE.fixedField,
    extensibleValue: start + PROBE_RELATIVE.extensibleValue,
    comment: start + PROBE_RELATIVE.comment,
  };
}

/* -------------------------------------------------------------------------- */
/* The comment header                                                          */
/* -------------------------------------------------------------------------- */

const HEADER_PREAMBLE = [
  '!-Generator idfkit bench/corpus.mjs',
  '!-Option SortedOrder',
  '!',
  '! Synthetic reference model for the idfkit language-service budget.',
  '! Generated deterministically from a fixed seed. Do not edit by hand: the',
  '! benchmark compares runs against each other, so an edited copy compares a',
  '! model against a different model and reports a regression that is not one.',
  '!',
];

const HEADER_FILLER = [
  '! Ordinary EnergyPlus objects follow:',
  '!',
  '! zones, constructions, materials,',
  '!',
  '! schedules, internal gains, output',
  '!',
  '! requests, and detailed surfaces',
  '!',
  '! whose vertex runs are the longest',
  '!',
  '! single statements in this file.',
  '!',
  '! The header is long on purpose. A',
  '!',
  '! cursor answer asked in the first',
  '!',
  '! statement scans back past all of it,',
  '!',
  '! and a scan that is cheap only for',
  '!',
  '! having started near offset zero is',
  '!',
  '! not the scan this design claims.',
  '!',
];

/**
 * Exactly `lineCount` lines of comment, deterministically.
 *
 * @param {number} lineCount
 * @returns {string}
 */
function commentHeader(lineCount) {
  if (lineCount < HEADER_PREAMBLE.length + 1) {
    throw new Error(
      `the body already fills the line budget: only ${lineCount} header lines are left, ` +
        `and the preamble alone needs ${HEADER_PREAMBLE.length + 1}`
    );
  }
  const lines = [...HEADER_PREAMBLE];
  while (lines.length < lineCount - 1) {
    lines.push(HEADER_FILLER[(lines.length - HEADER_PREAMBLE.length) % HEADER_FILLER.length]);
  }
  lines.push('!');
  return `${lines.join('\n')}\n`;
}

/* -------------------------------------------------------------------------- */
/* Building a model                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The order the shapes are emitted in: the composition above, expanded into one
 * entry per statement and then shuffled with the seeded generator.
 *
 * Real files are grouped by class and this one is not, deliberately. Grouping
 * would put every long statement in one contiguous stretch, and a percentile
 * sampled at even offsets would then be sampling one shape at a time.
 *
 * The variant draws from this same order rather than from a scaled-down copy of
 * it, and stops early. That makes the variant a genuine prefix of the reference
 * model's statement stream up to the probe, which is a stronger guarantee than
 * "the same mix": the statements around the probe are the same statements.
 *
 * @param {() => number} random
 * @returns {string[]}
 */
function shapeOrder(random) {
  /** @type {string[]} */
  const order = [];
  for (const { shape, count } of COMPOSITION) {
    for (let i = 0; i < count; i += 1) order.push(shape);
  }
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * @typedef {object} BuildRequest
 * How far to go, and how to finish the header. Exactly one of `statements` and
 * `targetBytes` is given: the reference model is specified by its statement
 * count, the variant by its size, because those are the terms the contract
 * states each of them in.
 * @property {number} [statements] Stop once this many statements are written, the Version statement included.
 * @property {number} [targetBytes] Stop once the body reaches this many bytes.
 * @property {number} [targetLines] Pad the comment header until the whole file has exactly this many lines.
 * @property {number} [headerLines] Use exactly this many header lines. Ignored when `targetLines` is given.
 */

/**
 * @param {BuildRequest} request
 * @returns {GeneratedModel}
 */
function build(request) {
  const random = makeRandom(SEED);
  const order = shapeOrder(random);

  /** @type {string[]} */
  const chunks = [];
  let length = 0;
  let lines = 0;
  let statements = 0;

  /** @param {string} chunk @param {number} newlines */
  const emit = (chunk, newlines) => {
    chunks.push(chunk);
    length += chunk.length;
    lines += newlines;
  };

  /** @param {readonly string[]} statementLines */
  const emitStatement = (statementLines) => {
    emit(`${statementLines.join('\n')}\n`, statementLines.length);
    statements += 1;
  };

  emitStatement(['Version, 26.1;']);

  // How far through the file we are, in whichever unit this request was made in.
  const targetStatements = request.statements ?? Infinity;
  const targetBytes = request.targetBytes ?? Infinity;
  const progress = () => Math.max(statements / targetStatements, length / targetBytes);

  let probeWritten = false;
  let longestVertexOffset = -1;
  let longestVertexLength = 0;
  let firstBlankLineOffset = -1;
  let shapeIndex = 0;

  for (const shape of order) {
    if (!probeWritten && progress() >= 0.6) {
      emitStatement(PROBE_LINES);
      probeWritten = true;
    }
    if (progress() >= 1) break;
    const statement = SHAPES[shape](random, shapeIndex + 1);
    if (statement.extensibleLine !== undefined && statement.lines.length > longestVertexLength) {
      longestVertexLength = statement.lines.length;
      longestVertexOffset =
        length +
        statement.lines.slice(0, statement.extensibleLine).reduce((n, l) => n + l.length + 1, 0) +
        1;
    }
    emitStatement(statement.lines);
    // A blank line after every statement, which is what an exporter writes and
    // what gives `betweenStatements` somewhere to land, and a second one now and
    // then where a real file would start a new section.
    const sectionBreak = random() < 0.09;
    if (firstBlankLineOffset === -1) firstBlankLineOffset = length;
    emit(sectionBreak ? '\n\n' : '\n', sectionBreak ? 2 : 1);
    shapeIndex += 1;
  }

  const body = chunks.join('');
  const headerLineCount =
    request.targetLines === undefined ? (request.headerLines ?? 8) : request.targetLines - lines;
  const header = commentHeader(headerLineCount);
  const text = header + body;

  const shift = header.length;
  const firstStatementOffset = shift + 'Vers'.length;

  return {
    text,
    statements,
    lines: lines + headerLineCount,
    bytes: Buffer.byteLength(text, 'utf8'),
    meaningfulTokens: countMeaningfulTokens(text),
    probe: probeOffsetsIn(text),
    cursors: {
      firstStatement: firstStatementOffset,
      largeExtensible: shift + longestVertexOffset,
      insideComment: HEADER_PREAMBLE[0].length + 4,
      betweenStatements: shift + firstBlankLineOffset,
      trailingWhitespace: text.length,
    },
  };
}

/**
 * The reference model: 10,001 statements and 40,002 lines, exactly.
 *
 * @returns {GeneratedModel}
 */
export function referenceModel() {
  const model = build({ statements: FULL_STATEMENTS, targetLines: FULL_LINES });
  assertShape(model, FULL_STATEMENTS, FULL_LINES);
  return model;
}

/**
 * The one-hundredth-size variant, holding the same probe statement.
 *
 * Size is what is scaled, because size is the word the contract uses: "the same
 * cursor answer measured on the reference model and on a file one hundredth its
 * size". Its statement count and its line count fall out of that rather than
 * being pinned as well, which would over-specify a file whose only job is to be
 * small and to contain the probe.
 *
 * The divisor is applied to the reference model's measured size rather than to a
 * remembered constant, so the two stay one hundredth apart when the composition
 * above is edited. That costs one extra build of the reference model, once, well
 * outside anything the benchmark times.
 *
 * @returns {GeneratedModel}
 */
export function smallModel() {
  const target = Math.round(referenceModel().bytes / 100);
  return build({ targetBytes: target, headerLines: SMALL_HEADER_LINES });
}

/**
 * @param {GeneratedModel} model
 * @param {number} statements
 * @param {number} lines
 */
function assertShape(model, statements, lines) {
  if (model.statements !== statements || model.lines !== lines) {
    throw new Error(
      `the generator drifted: ${model.statements} statements and ${model.lines} lines, ` +
        `against the ${statements} and ${lines} the contract states`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Measuring what came out                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Meaningful tokens: type names, written values, separators, terminators and
 * comments. Whitespace is not one, and neither is an empty field between two
 * commas, which has a region but no text.
 *
 * This is a reporting figure, not an assertion. It is counted here rather than
 * by `scanIdf` on purpose: this module must run before the scanner exists, and a
 * generator that cannot describe its own output until the thing it is measuring
 * has been written is a generator nobody can develop against.
 *
 * @param {string} text
 * @returns {number}
 */
export function countMeaningfulTokens(text) {
  let tokens = 0;
  let valueStart = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '!') {
      if (valueStart !== -1 && text.slice(valueStart, i).trim() !== '') tokens += 1;
      valueStart = -1;
      tokens += 1;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === ',' || ch === ';') {
      if (valueStart !== -1 && text.slice(valueStart, i).trim() !== '') tokens += 1;
      valueStart = -1;
      tokens += 1;
      continue;
    }
    if (valueStart === -1 && ch.trim() !== '') valueStart = i;
  }
  if (valueStart !== -1 && text.slice(valueStart).trim() !== '') tokens += 1;
  return tokens;
}

/* -------------------------------------------------------------------------- */
/* Command line                                                                */
/* -------------------------------------------------------------------------- */

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const wantsSmall = process.argv.includes('--small');
  const model = wantsSmall ? smallModel() : referenceModel();
  if (process.argv.includes('--stats')) {
    const { text: _text, ...shape } = model;
    process.stdout.write(`${JSON.stringify(shape, null, 2)}\n`);
  } else {
    process.stdout.write(model.text);
  }
}
