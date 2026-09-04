#!/usr/bin/env node
/**
 * The committed performance budget (tasks T056 to T060).
 *
 * WHAT THIS IS FOR
 *
 * `contracts/performance-budget.md` opens with the problem it exists to solve:
 * "Performance is a requirement here rather than a hope, so it needs a
 * measurement that can fail. There is none today: the figures this feature was
 * designed against were taken by hand and are recorded nowhere in the
 * repository." This is that measurement. It reads the model `corpus.mjs`
 * generates, times every path the contract names, in one process on one machine
 * in one run, and exits non-zero when a ratio moves.
 *
 * WHY EVERY GATE IS A RATIO
 *
 * Absolute milliseconds cannot fail reliably. A continuous-integration runner
 * varies by more than the margin being defended, so a wall-clock threshold is
 * either loose enough to miss a real regression or tight enough to fail on a
 * noisy neighbour, and a gate that fails randomly is a gate somebody disables.
 * Every enforced number below is therefore a ratio between two figures measured
 * in this same run, which cancels the machine out: if a cursor answer costs less
 * than a stated fraction of a full read of the same text here, it costs less
 * than that fraction everywhere.
 *
 * Milliseconds are still printed, because a human reading a run wants to know
 * whether the machine is fast, and because SC-001's "under 10 ms at the 95th
 * percentile" is stated in milliseconds. They are reported and never enforced,
 * and the output says so.
 *
 * THE FOUR GATES, AND WHICH HAZARD EACH ONE GUARDS
 *
 *   a cursor answer / parseIdf     FR-033, SC-001. The answer must cost a small
 *                                  fraction of a full read of the same text.
 *   scanIdf / parseIdf             SC-002. The syntax layer must not cost more
 *                                  than a read plus a quarter.
 *   parseIdf / lex                 FR-005, SC-002. `parseIdf` must not start
 *                                  building a layer for callers who never asked
 *                                  for one. See the note on this gate below.
 *   big file / small file          FR-033, and the one that pins the design. A
 *                                  ratio against `parseIdf` alone could be met
 *                                  by a merely fast reparse. Independence from
 *                                  file size could not.
 *
 * WHY THE THIRD GATE IS DIVIDED BY `lex` AND NOT BY ITS RECORDED MILLISECONDS
 *
 * The contract records `parseIdf` at 39 to 50 ms, hand-measured. Held against
 * that figure directly the gate would be wall-clock again, with all the failure
 * modes described above: the regression it exists to catch is a parse that
 * quietly acquires the layer's work, which on this machine would move 40 ms to
 * about 60 ms, and no absolute threshold both catches a 1.5x move and survives a
 * runner that is 1.5x slower.
 *
 * `lex` is the yardstick because it is the same read over the same bytes without
 * any of the layer: same scanner, same text, same allocation profile. A machine
 * that is slow at one is slow at the other, so the ratio holds across machines
 * while a parse that started building a layer moves it by half again.
 *
 * The recorded milliseconds are kept in `RECORDED_MS` and printed beside the run
 * because the contract records them, but they do not agree with this machine and
 * were never going to: `lex` measures 13 to 14 ms here against a recorded 35 ms.
 * So `CALIBRATION` records the ratio measured in the same sitting as the budget
 * it defends, which is the only honest basis for a threshold.
 *
 * WHAT IT DOES NOT CATCH
 *
 * A regression in the scanner that both `lex` and `parseIdf` share moves both
 * halves of the third gate together and passes. That is a real limit rather than
 * an oversight, and the absolute milliseconds printed above the gates are what a
 * human reads to see it. No within-run ratio can do better, and the alternative
 * fails on Tuesdays.
 *
 * USAGE
 *
 *   npm run bench            or   node bench/budget.mjs
 *   npm run check:bench      the same thing, under the name CI calls
 *
 * It reads `dist`, which is what an npm consumer receives, so run `npx tsc
 * --build` first. Exit 0 passed, 1 a gate broke, 2 it could not run.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { commentFreeModel, referenceModel, smallModel } from './corpus.mjs';

/* -------------------------------------------------------------------------- */
/* The budgets, as data (FR-035)                                               */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} Budgets
 * The enforced thresholds. Held here as an exported object rather than written
 * into a sentence or hidden in a comparison, because FR-035 asks for budgets
 * "next to the measurement as data, not in prose", so that changing one is a
 * visible diff somebody has to defend in review.
 * @property {number} cursorShareOfParse Largest share of `parseIdf` one cursor answer may cost.
 * @property {number} scanOverParse Largest multiple of `parseIdf` that `scanIdf` may cost.
 * @property {number} parseOverLex Largest multiple of `lex` that `parseIdf` may cost.
 * @property {number} fileSizeIndependence Largest factor between the same answer on the two models.
 * @property {number} offsetIndependence Largest factor between the two ends of one comment-free file.
 * @property {number} cursorP95Ms SC-001's absolute figure. Reported, never enforced.
 */

/** @type {Budgets} */
export const BUDGETS = {
  // 2% of a 40 ms read is under 1 ms, comfortably inside SC-001's 10 ms and
  // comfortably inside a 60 Hz frame. Measured today at about 0.03%, so this is
  // not a threshold the implementation is pressed against; it is the line below
  // which the answer is bounded by the statement rather than by the file.
  cursorShareOfParse: 0.02,

  // SC-002, verbatim. Measured today at about 0.50.
  scanOverParse: 1.25,

  // Measured at 2.64 to 3.00 across five runs (see CALIBRATION). The gate sits
  // 20% above the worst of those, which leaves room for a machine that balances
  // the two differently, and well below the 4.4 a parse that built a layer inside
  // itself would land at on the figures this run prints.
  parseOverLex: 3.6,

  // Deliberate, and the reasoning matters more than the number. The same answer
  // at the same probe offsets measures 1.65 to 1.68 (contextAt) and 1.39 to 1.49
  // (completionsAt) between the two models, and neither is a size effect: the probe
  // statement is byte-identical in both files and sits behind a different
  // preceding statement in each, so the backward scan starts a different distance
  // out. Anything whose cost is linear in the file lands near 93, which is the
  // ratio of the two models' sizes. The factor's whole job is to sit between
  // those two populations, and 3 is an order of magnitude below the linear one
  // while leaving 1.8x above the worst honest reading.
  fileSizeIndependence: 3,

  // The same reasoning as above, turned on the other axis. `fileSizeIndependence`
  // compares two files and so cannot see a cost that grows with the OFFSET rather
  // than with the size: both of its readings sit at the same place in their own
  // file. This one compares the first statement and the last of one file, and it
  // uses a comment-free file because that is the shape that exposes the defect.
  //
  // Measured today at about 1. The defect this gate exists to catch measured
  // 8,385 before it was fixed: `insideComment` searched backwards for an
  // exclamation mark, which reads the whole prefix when the file holds none, so
  // every answer cost grew with how far into the file the cursor sat. Nothing
  // else in this script could see it, because the reference model puts a comment
  // on nearly every line and the backward search always stopped within one.
  offsetIndependence: 3,

  // SC-001. Reported, not enforced: an absolute millisecond figure is a statement
  // about a reference machine, and this script does not know which machine it is
  // on. Printed so a human can see the answer is three orders of magnitude inside
  // it rather than one.
  cursorP95Ms: 10,
};

/**
 * @typedef {object} RecordedBaseline
 * A hand-measured figure from `contracts/performance-budget.md`, in milliseconds.
 * `null` where the contract records the path as new.
 * @property {number | null} low
 * @property {number | null} high
 */

/**
 * The contract's hand-measured baselines. Reported for humans, never enforced.
 *
 * They were taken on another machine in another sitting and they do not describe
 * this one: `lex` is recorded at 35 ms and measures 13 to 14 ms here. They are
 * printed anyway, unadjusted, because a baseline quietly rewritten to match the
 * machine that failed against it is not a baseline.
 *
 * @type {Record<string, RecordedBaseline>}
 */
export const RECORDED_MS = {
  lex: { low: 35, high: 35 },
  parseIdf: { low: 39, high: 50 },
  validateDocument: { low: 39, high: 39 },
  writeIdf: { low: 47, high: 47 },
  scanIdf: { low: null, high: null },
  classify: { low: null, high: null },
};

/**
 * @typedef {object} Observed
 * The span a ratio was seen to move over when a budget above it was set.
 * @property {number} runs How many runs it was watched across.
 * @property {number} low
 * @property {number} high
 */

/**
 * What the enforced ratios actually measured when the budgets above were set.
 *
 * A threshold is only defensible if somebody can see what was measured to reach
 * it, and a threshold set against a figure nobody wrote down is a threshold that
 * gets loosened the first time it fails. Medians, after discarded warm-up, on the
 * machine and date below.
 *
 * @type {{ measured: string } & Record<string, Observed>}
 */
export const CALIBRATION = {
  measured: '2026-09-04, Apple Silicon laptop, Node 22.12, darwin arm64',
  parseOverLex: { runs: 5, low: 2.64, high: 3.0 },
  scanOverParse: { runs: 5, low: 0.48, high: 0.5 },
  contextAtAcrossModels: { runs: 3, low: 1.65, high: 1.68 },
  completionsAtAcrossModels: { runs: 3, low: 1.39, high: 1.49 },
};

/* -------------------------------------------------------------------------- */
/* How much is measured                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Warm-up and timed iterations for the whole-file paths.
 *
 * Warm-up is discarded rather than averaged in. The first call into a cold
 * function measures the optimising compiler, not the code: `lex` costs 43 ms on
 * its first run against 13 ms once it is warm, and a benchmark that folded that
 * in would report a third of its number as start-up and call it a regression the
 * day somebody reordered the file.
 *
 * 21 iterations, so the 95th percentile is the second largest rather than the
 * largest, and one scheduler blip does not become the reported figure.
 */
const WHOLE_FILE = { warmup: 3, iterations: 21 };

/**
 * The same, for a cursor answer, which costs microseconds rather than
 * milliseconds and therefore needs far more samples to say anything about a
 * percentile.
 *
 * Time-boxed rather than fixed, and the reason is the failure this gate exists
 * to catch. An answer that costs 4 microseconds affords 3,000 samples in twelve
 * milliseconds. An answer that regressed into reparsing the file costs 20
 * milliseconds, and the same 3,000 samples at each of ten offsets in two models
 * would take three quarters of an hour: the gate would report the regression as
 * a build timeout rather than as a broken ratio, and a timeout says nothing about
 * which ratio moved. So each offset gets a wall-clock allowance, and the number
 * of samples falls out of what one call costs. 20 is the floor because a
 * percentile over fewer than that is not a percentile.
 */
const ANSWER = { warmupMs: 60, budgetMs: 60, minIterations: 20, maxIterations: 3000 };

/* -------------------------------------------------------------------------- */
/* Loading what the build produced                                             */
/* -------------------------------------------------------------------------- */

/**
 * Modules this reads, and the one instruction that fixes all of them.
 *
 * `dist`, not `src`, on the same grounds the example-file sweep gives: it is
 * what an npm consumer receives. The language package is reached by module
 * rather than through its index, which is a liberty a benchmark may take and a
 * consumer may not: the index assembles the published surface, and this measures
 * the implementation behind it.
 */
const BUILT = {
  core: '../packages/core/dist/index.js',
  coreNode: '../packages/core/dist/node.js',
  cursor: '../packages/language/dist/cursor.js',
  complete: '../packages/language/dist/complete.js',
};

/**
 * @typedef {object} Built
 * Everything the run calls, loaded from `dist`.
 * @property {Function} lex
 * @property {Function} parseIdf
 * @property {Function} validateDocument
 * @property {Function} writeIdf
 * @property {Function} scanIdf
 * @property {Function} classify
 * @property {Function} getIdfVersion
 * @property {Function} schemaFor
 * @property {Function} contextAt
 * @property {Function} completionsAt
 */

/**
 * Load them, or say the one thing that fixes an unbuilt checkout.
 *
 * Missing output is not a failed budget and must not be reported as one: a gate
 * that says a ratio broke when what really happened is that nobody ran the build
 * teaches a reader to distrust it. Hence the separate exit code.
 *
 * @returns {Promise<Built>}
 */
async function loadBuilt() {
  for (const [name, specifier] of Object.entries(BUILT)) {
    if (existsSync(fileURLToPath(new URL(specifier, import.meta.url)))) continue;
    console.error(`could not run: ${name} is not built (${specifier})`);
    console.error(
      'Run `npx tsc --build` first. This measures dist, which is what a consumer gets.'
    );
    process.exit(2);
  }
  const core = await import(BUILT.core);
  const coreNode = await import(BUILT.coreNode);
  const cursor = await import(BUILT.cursor);
  const complete = await import(BUILT.complete);
  return {
    lex: core.lex,
    parseIdf: core.parseIdf,
    validateDocument: core.validateDocument,
    writeIdf: core.writeIdf,
    scanIdf: core.scanIdf,
    classify: core.classify,
    getIdfVersion: core.getIdfVersion,
    schemaFor: coreNode.schemaFor,
    contextAt: cursor.contextAt,
    completionsAt: complete.completionsAt,
  };
}

/* -------------------------------------------------------------------------- */
/* The harness                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} Timing
 * What one measured path cost, in milliseconds.
 * @property {number} median
 * @property {number} p95
 * @property {number} min
 * @property {number} max
 * @property {number} samples
 */

/**
 * Somewhere for every measured result to go.
 *
 * A call whose result is dropped is a call the optimiser may delete, and a
 * benchmark that deleted the thing it was timing would report a very good
 * number. Touching the result once, outside the timed region, is enough to keep
 * every call alive.
 */
let sink = 0;

/** @param {unknown} produced */
function keep(produced) {
  sink += produced === undefined || produced === null ? 0 : 1;
}

/**
 * @param {Float64Array} sorted
 * @param {number} q
 * @returns {number}
 */
function quantile(sorted, q) {
  const index = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

/**
 * @param {Float64Array} durations
 * @returns {Timing}
 */
function summarize(durations) {
  const sorted = Float64Array.from(durations).sort();
  return {
    median: quantile(sorted, 0.5),
    // The 95th percentile, never the mean. A mean hides exactly the failure this
    // feature exists to prevent: an answer that is fast on average and
    // occasionally takes 40 ms drops a frame, and the reader experiences the
    // 40 ms rather than the average.
    p95: quantile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    samples: sorted.length,
  };
}

/**
 * Time one whole-file path.
 *
 * @param {() => unknown} run
 * @returns {Timing}
 */
function timeWholeFile(run) {
  for (let i = 0; i < WHOLE_FILE.warmup; i += 1) keep(run());
  const durations = new Float64Array(WHOLE_FILE.iterations);
  for (let i = 0; i < WHOLE_FILE.iterations; i += 1) {
    const started = performance.now();
    const produced = run();
    durations[i] = performance.now() - started;
    keep(produced);
  }
  return summarize(durations);
}

/**
 * Time one cursor answer at one offset, one call at a time.
 *
 * One call per timed region, rather than a thousand calls divided by a thousand.
 * A percentile over a batch is a percentile over batches, which is the mean again
 * wearing a different name, and the number SC-001 is about is what one answer
 * costs when a reader is waiting for it.
 *
 * @param {(offset: number) => unknown} ask
 * @param {number} offset
 * @returns {Float64Array}
 */
function timeAnswerAt(ask, offset) {
  // Warm up on a clock rather than a count, so a cheap answer gets thousands of
  // calls to compile against and an expensive one still leaves the loop.
  const warmupUntil = performance.now() + ANSWER.warmupMs;
  let warmed = 0;
  while (warmed < ANSWER.maxIterations && performance.now() < warmupUntil) {
    keep(ask(offset));
    warmed += 1;
  }

  // One warm call decides how many will fit in the allowance.
  const probeStarted = performance.now();
  keep(ask(offset));
  const each = Math.max(performance.now() - probeStarted, Number.EPSILON);
  const iterations = Math.min(
    ANSWER.maxIterations,
    Math.max(ANSWER.minIterations, Math.floor(ANSWER.budgetMs / each))
  );

  const durations = new Float64Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    const produced = ask(offset);
    durations[i] = performance.now() - started;
    keep(produced);
  }
  return durations;
}

/**
 * @param {readonly Float64Array[]} parts
 * @returns {Float64Array}
 */
function pool(parts) {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const all = new Float64Array(total);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}

/* -------------------------------------------------------------------------- */
/* What is measured, and where                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} Probe
 * One offset a cursor answer is asked at.
 * @property {string} label What makes this offset worth asking at.
 * @property {number} offset Where it is in that model's text.
 * @property {boolean} shared Whether the same offset exists in both models, which is
 *   what makes it usable for the file-size-independence comparison.
 */

/**
 * The offsets one model is sampled at.
 *
 * The five from `cursors` are the awkward ones, and they are in the text because
 * `corpus.mjs` put them there: the first statement of the file behind a 444-line
 * comment header, the last vertex of the longest statement in the file, inside a
 * comment, a blank line between two statements, and the trailing whitespace at
 * end of file. The five from `probe` sit inside one statement that is written
 * character for character the same way in both models, which is what makes the
 * two files comparable at all.
 *
 * Only the probe offsets are `shared`. The header the first statement sits behind
 * is 444 lines in one model and 12 in the other, so an answer asked there is
 * measuring the header rather than the file, and comparing the two would report a
 * size effect that is really a fixture difference.
 *
 * @param {import('./corpus.mjs').GeneratedModel} model
 * @returns {Probe[]}
 */
function probesFor(model) {
  return [
    ...Object.entries(model.cursors).map(([label, offset]) => ({ label, offset, shared: false })),
    ...Object.entries(model.probe).map(([label, offset]) => ({
      label: `probe.${label}`,
      offset,
      shared: true,
    })),
  ];
}

/**
 * @typedef {object} Answer
 * One cursor answer, named and bound to the schema it is asked against.
 * @property {string} name
 * @property {(text: string, offset: number) => unknown} ask
 */

/**
 * Every cursor answer the service offers today.
 *
 * `explainAt` and `declarationAt` join this list when phases 8 and 9 land, one
 * entry each, and every gate below then covers them without further edit.
 *
 * `completionsAt` is asked with no document, which is the keystroke path. Handing
 * it one would fold in the reference-name question, which is a whole-document
 * question by nature and is answered from a document the caller already holds
 * rather than from one this service parses.
 *
 * @param {unknown} schema
 * @param {Built} built
 * @returns {Answer[]}
 */
function answersAgainst(schema, built) {
  return [
    { name: 'contextAt', ask: (text, offset) => built.contextAt(text, offset, schema) },
    { name: 'completionsAt', ask: (text, offset) => built.completionsAt(text, offset, schema) },
  ];
}

/* -------------------------------------------------------------------------- */
/* The gates                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} Gate
 * One enforced ratio.
 * @property {string} name What is being divided by what.
 * @property {number} measured This run's figure.
 * @property {number} budget The line it must stay under, from `BUDGETS`.
 * @property {'percent' | 'times'} unit How to print both.
 * @property {string} because What a breach means, said in the failure.
 */

/**
 * @param {number} value
 * @param {Gate['unit']} unit
 * @returns {string}
 */
function inUnit(value, unit) {
  return unit === 'percent' ? `${(value * 100).toFixed(3)}%` : `${value.toFixed(2)}x`;
}

/* -------------------------------------------------------------------------- */
/* The report                                                                  */
/* -------------------------------------------------------------------------- */

/** @param {number} ms @returns {string} */
function msOf(ms) {
  return ms >= 1 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(4)} ms`;
}

/** @param {string} path @returns {string} */
function recordedOf(path) {
  const recorded = RECORDED_MS[path];
  if (recorded === undefined || recorded.low === null) return 'new';
  return recorded.low === recorded.high
    ? `${recorded.low} ms`
    : `${recorded.low} to ${recorded.high} ms`;
}

/** @param {import('./corpus.mjs').GeneratedModel} shape @returns {string} */
function shapeOf(shape) {
  return (
    `${shape.bytes.toLocaleString().padStart(9)} bytes   ` +
    `${shape.statements.toLocaleString().padStart(6)} statements   ` +
    `${shape.lines.toLocaleString().padStart(6)} lines   ` +
    `${shape.meaningfulTokens.toLocaleString().padStart(7)} tokens`
  );
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Measure everything, print it, and say whether a gate broke.
 *
 * Behind a function and behind the guard at the foot of the file, on the same
 * terms as `corpus.mjs`: the budgets above are worth importing and reading, and
 * importing them should not cost twenty seconds of measurement.
 *
 * @returns {Promise<number>} the process exit code
 */
async function main() {
  const built = await loadBuilt();
  const model = referenceModel();
  const variant = smallModel();
  const commentFree = commentFreeModel();

  // `schemaFor`, not `bundle.load`, because that is the path a reader takes and
  // it is the one that resolves a declared version onto a bundled one: the corpus
  // declares 26.1 and the bundle carries 26.1.0.
  const schema = await built.schemaFor(built.getIdfVersion(model.text));
  const answers = answersAgainst(schema, built);

  // Everything the timed regions need but do not measure: a document to validate
  // and to write, and a layer to classify. Built once, outside every timer, so
  // that `classify` reports what classification costs rather than what a scan
  // plus a classification costs.
  const document = built.parseIdf(model.text, schema).document;
  const layer = built.scanIdf(model.text);

  /** @type {Record<string, Timing>} */
  const wholeFile = {
    lex: timeWholeFile(() => built.lex(model.text)),
    parseIdf: timeWholeFile(() => built.parseIdf(model.text, schema)),
    validateDocument: timeWholeFile(() => built.validateDocument(document)),
    writeIdf: timeWholeFile(() => built.writeIdf(document)),
    scanIdf: timeWholeFile(() => built.scanIdf(model.text)),
    classify: timeWholeFile(() => {
      let counted = 0;
      for (const _token of built.classify(layer)) counted += 1;
      return counted;
    }),
  };

  /**
   * Every cursor answer, at every offset, in both models.
   *
   * @type {Map<string, { byOffset: Map<string, Float64Array>, variant: Map<string, Float64Array> }>}
   */
  const answerTimings = new Map();
  const probes = probesFor(model);
  const variantProbes = probesFor(variant).filter((probe) => probe.shared);

  for (const answer of answers) {
    /** @type {Map<string, Float64Array>} */
    const byOffset = new Map();
    for (const probe of probes) {
      byOffset.set(
        probe.label,
        timeAnswerAt((offset) => answer.ask(model.text, offset), probe.offset)
      );
    }
    /** @type {Map<string, Float64Array>} */
    const inVariant = new Map();
    for (const probe of variantProbes) {
      inVariant.set(
        probe.label,
        timeAnswerAt((offset) => answer.ask(variant.text, offset), probe.offset)
      );
    }
    answerTimings.set(answer.name, { byOffset, variant: inVariant });
  }

  /** Every offset in the reference model, pooled. @param {string} name @returns {Timing} */
  const pooledAnswer = (name) =>
    summarize(pool([...(answerTimings.get(name)?.byOffset.values() ?? [])]));

  /** The shared probe offsets only, in one model or the other. @returns {Timing} */
  const pooledProbe = (name, where) => {
    const timings = answerTimings.get(name);
    const parts =
      where === 'variant'
        ? [...(timings?.variant.values() ?? [])]
        : probes
            .filter((probe) => probe.shared)
            .map((probe) => timings?.byOffset.get(probe.label))
            .filter((part) => part !== undefined);
    return summarize(pool(parts));
  };

  /* ------------------------------------------------------------------------ */
  /* The gates, computed                                                      */
  /* ------------------------------------------------------------------------ */

  /** @type {Gate[]} */
  const gates = [];

  for (const answer of answers) {
    gates.push({
      name: `${answer.name} p95 / parseIdf median`,
      measured: pooledAnswer(answer.name).p95 / wholeFile.parseIdf.median,
      budget: BUDGETS.cursorShareOfParse,
      unit: 'percent',
      because:
        'FR-033 and SC-001. A cursor answer must cost a small fraction of a full read of the ' +
        'same text. The p95 is the numerator because the reader experiences the slow answer, ' +
        "not the average one; parseIdf's median is the denominator because a denominator taken " +
        'at its own p95 would quietly widen the allowance.',
    });
  }

  gates.push({
    name: 'scanIdf median / parseIdf median',
    measured: wholeFile.scanIdf.median / wholeFile.parseIdf.median,
    budget: BUDGETS.scanOverParse,
    unit: 'times',
    because:
      'SC-002. Building the syntax layer must stay within a quarter again of reading the file ' +
      'into a document, or the layer is not something a consumer can build on a whim.',
  });

  gates.push({
    name: 'parseIdf median / lex median',
    measured: wholeFile.parseIdf.median / wholeFile.lex.median,
    budget: BUDGETS.parseOverLex,
    unit: 'times',
    because:
      'FR-005 and SC-002. lex is the same read over the same bytes with none of the layer, so ' +
      'this ratio moves when parseIdf starts doing work a caller who never named scanIdf did ' +
      'not ask for. The recorded milliseconds are printed above and are not the gate; see the ' +
      'header for why an absolute threshold cannot do this job.',
  });

  for (const answer of answers) {
    const big = pooledProbe(answer.name, 'model');
    const small = pooledProbe(answer.name, 'variant');
    gates.push({
      // Medians, not percentiles, and this is the one place the choice goes the
      // other way. The p95 is what a reader experiences and is what the first
      // gate enforces; this one is a statement about the shape of the cost
      // function, and over microsecond samples the median is the stabler
      // estimator of it by a wide margin. Across three runs the median ratio
      // moved between 1.65 and 1.68 while the p95 ratio moved between 1.33 and
      // 2.50.
      name: `${answer.name}, ${model.bytes.toLocaleString()} bytes vs ${variant.bytes.toLocaleString()} bytes`,
      measured: Math.max(big.median / small.median, small.median / big.median),
      budget: BUDGETS.fileSizeIndependence,
      unit: 'times',
      because:
        'FR-033, and the assertion that pins the design. The same question at the same offsets ' +
        'in a statement written character for character the same way in both files. A design ' +
        'that reparsed, or that indexed the lines, or that consulted a SyntaxLayer, is linear ' +
        "in the file and lands near the ratio of the two files' sizes, which is about 93.",
    });
  }

  // The other axis: cost that grows with the offset rather than with the file.
  // Both readings are in ONE file, so a size ratio cannot explain a breach, and
  // the file carries no comments because that is the shape that exposes it.
  for (const answer of answers) {
    const near = summarize(
      timeAnswerAt((offset) => answer.ask(commentFree.text, offset), commentFree.near)
    );
    const far = summarize(
      timeAnswerAt((offset) => answer.ask(commentFree.text, offset), commentFree.far)
    );
    gates.push({
      name: `${answer.name}, last vs first statement, no comments`,
      measured: Math.max(far.median / near.median, near.median / far.median),
      budget: BUDGETS.offsetIndependence,
      unit: 'times',
      because:
        'FR-033, on the axis the two-model gate cannot see. Both readings are in the same file, ' +
        'so its size divides out and only the distance from the start differs. Any search that ' +
        'runs backwards to a character the file does not contain reads the whole prefix, and ' +
        'this ratio then grows with the file: it measured 8,385 when insideComment searched ' +
        'backwards for an exclamation mark. The reference model cannot show it, because a ' +
        'comment on nearly every line stops that search within one.',
    });
  }

  /* ------------------------------------------------------------------------ */
  /* The report, printed                                                      */
  /* ------------------------------------------------------------------------ */

  console.log('idfkit language-service performance budget (FR-033 to FR-035, SC-001, SC-002)');
  console.log('');
  console.log(`  reference model ${shapeOf(model)}`);
  console.log(`  variant         ${shapeOf(variant)}`);
  console.log(`  schema          EnergyPlus ${schema.version}`);
  console.log(`  node            ${process.version} on ${process.platform} ${process.arch}`);
  console.log('');
  console.log('  MILLISECONDS BELOW ARE INFORMATIONAL. They describe this machine and nothing');
  console.log('  else, and no threshold is held against them. THE RATIOS FURTHER DOWN ARE THE');
  console.log('  GATE: each is measured inside this one run, so a faster or slower machine moves');
  console.log('  both halves of it together.');
  console.log('');
  console.log(
    `  ${'path'.padEnd(20)}${'median'.padStart(12)}${'p95'.padStart(12)}` +
      `${'samples'.padStart(10)}   recorded`
  );
  for (const [path, timing] of Object.entries(wholeFile)) {
    console.log(
      `  ${path.padEnd(20)}${msOf(timing.median).padStart(12)}${msOf(timing.p95).padStart(12)}` +
        `${String(timing.samples).padStart(10)}   ${recordedOf(path)}`
    );
  }
  for (const answer of answers) {
    const timing = pooledAnswer(answer.name);
    console.log(
      `  ${answer.name.padEnd(20)}${msOf(timing.median).padStart(12)}` +
        `${msOf(timing.p95).padStart(12)}${String(timing.samples).padStart(10)}   new`
    );
  }
  console.log('');
  console.log('  cursor answers, 95th percentile in ms, by offset');
  console.log(`  ${'offset'.padEnd(24)}${answers.map((a) => a.name.padStart(16)).join('')}`);
  for (const probe of probes) {
    const cells = answers.map((answer) => {
      const durations = answerTimings.get(answer.name)?.byOffset.get(probe.label);
      return (durations === undefined ? '' : summarize(durations).p95.toFixed(4)).padStart(16);
    });
    console.log(`  ${probe.label.padEnd(24)}${cells.join('')}`);
  }
  console.log('');
  console.log('  GATES. These are what fails.');
  console.log('');
  console.log(`  ${'gate'.padEnd(56)}${'measured'.padStart(12)}${'budget'.padStart(12)}`);

  /** @type {Gate[]} */
  const broken = [];
  for (const gate of gates) {
    const failed = gate.measured > gate.budget;
    if (failed) broken.push(gate);
    console.log(
      `  ${gate.name.padEnd(56)}${inUnit(gate.measured, gate.unit).padStart(12)}` +
        `${inUnit(gate.budget, gate.unit).padStart(12)}   ${failed ? 'BROKE' : 'pass'}`
    );
  }
  console.log('');

  const worstAnswerP95 = Math.max(...answers.map((answer) => pooledAnswer(answer.name).p95));
  console.log(
    `  reported, not enforced: SC-001 asks for a cursor answer under ${BUDGETS.cursorP95Ms} ms at` +
      ` the 95th\n  percentile. The slowest answer here is ${msOf(worstAnswerP95)}, on this machine.`
  );
  console.log('');

  // Reading the sink keeps every measured call reachable, so that nothing timed
  // above could have been optimised away for having an unused result.
  if (!Number.isFinite(sink)) {
    console.log('::error::the measurement lost its results, so nothing above was measured');
    return 2;
  }

  if (broken.length > 0) {
    for (const gate of broken) {
      console.log(
        `::error::${gate.name} measured ${inUnit(gate.measured, gate.unit)} against a budget of ` +
          `${inUnit(gate.budget, gate.unit)}, which is ${(gate.measured / gate.budget).toFixed(2)}x ` +
          'its budget'
      );
      console.log(`      ${gate.because}`);
      console.log('');
    }
    console.log(
      `FAIL: ${broken.length} of ${gates.length} gates broke. ` +
        'Milliseconds move with the machine and these do not, so a breach here is a change in ' +
        'this repository rather than a change in the runner.'
    );
    return 1;
  }

  // The last two batches of gates, each one per answer: file-size independence
  // first, then offset independence. Reported apart because they are different
  // claims and one passing says nothing about the other.
  const worstOf = (batch) => Math.max(...batch.map((gate) => gate.measured));
  const bySize = worstOf(gates.slice(-2 * answers.length, -answers.length));
  const byOffset = worstOf(gates.slice(-answers.length));
  console.log(
    `PASS: all ${gates.length} gates hold. The slowest cursor answer costs ` +
      `${inUnit(worstAnswerP95 / wholeFile.parseIdf.median, 'percent')} of a full read of the ` +
      `same text, costs within ${inUnit(bySize, 'times')} of the same in a file a hundredth ` +
      `the size, and within ${inUnit(byOffset, 'times')} of the same at the far end of a ` +
      'comment-free file.'
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) process.exit(await main());
