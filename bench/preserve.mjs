#!/usr/bin/env node
/**
 * The three measurements the preserving writer owes (tasks T075 and T076).
 *
 * Reported rather than gated, unlike `budget.mjs`. These are the figures the
 * plan committed to taking, and taking them is the point: two of the three are
 * success criteria and the third is the item the plan named as the one to
 * watch. A gate is added when a number has a defended threshold, and these do
 * not yet.
 *
 * Every ratio is between two figures measured in the same run over the same
 * bytes, for the reason `budget.mjs` sets out at length: a wall-clock threshold
 * is either loose enough to miss a regression or tight enough to fail on a
 * noisy neighbour.
 *
 *   SC-004  reading with preservation OFF costs what reading costs today,
 *           because the option gates every piece of the new work.
 *   SC-005  reading with it ON costs no more than the syntax layer's own
 *           budget, a quarter over a plain read, plus one anchors array.
 *   the wrapper  reading a vertex through the extensible wrapper against
 *           reading it off the raw array. Reading vertices is a hot path in
 *           every geometry consumer, and the wrapper is what the plan flagged
 *           as the item to watch once the install budget was thought settled.
 */

import { performance } from 'node:perf_hooks';

import { parseIdf, scanIdf, writeIdf } from '../packages/core/dist/index.js';
import { schemaFor } from '../packages/core/dist/node.js';
import { referenceModel } from './corpus.mjs';

const RUNS = 15;
const WARMUP = 3;

/** Median of `RUNS` timed calls, after `WARMUP` untimed ones. */
function median(label, run) {
  for (let i = 0; i < WARMUP; i += 1) run();
  const times = [];
  for (let i = 0; i < RUNS; i += 1) {
    const started = performance.now();
    run();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const value = times[Math.floor(times.length / 2)];
  return { label, value };
}

const model = referenceModel();
const text = model.text;
const schema = await schemaFor('26.1.0');

const plain = median('parseIdf, preservation off', () => parseIdf(text, schema, { strict: false }));
const kept = median('parseIdf, preservation on', () =>
  parseIdf(text, schema, { strict: false, preserveFormatting: true })
);
const scan = median('scanIdf alone', () => scanIdf(text));

const preserved = parseIdf(text, schema, { strict: false, preserveFormatting: true }).document;
const formatted = parseIdf(text, schema, { strict: false }).document;
const writePreserving = median('writeIdf, preserving', () => writeIdf(preserved));
const writeFormatting = median('writeIdf, formatting', () => writeIdf(formatted));

// The wrapper, read against the raw array. Both walk every vertex of every
// surface and sum a coordinate, so what differs is only how the value is
// reached: an own accessor on an armed repeat, or a plain property.
const surfaces = [...formatted.all('BuildingSurface:Detailed')];
const raw = surfaces.map((surface) => surface.toJSON()['vertices'] ?? []);
const readThroughWrapper = median('a vertex, not preserving', () => {
  let total = 0;
  for (const surface of surfaces) {
    for (const vertex of surface.extensible) total += Number(vertex['vertex_x_coordinate'] ?? 0);
  }
  return total;
});
const readThroughArray = median('a vertex off a plain array', () => {
  let total = 0;
  for (const groups of raw) {
    for (const vertex of groups) total += Number(vertex['vertex_x_coordinate'] ?? 0);
  }
  return total;
});
// The same read on a PRESERVING document, where the repeats carry accessors because there is a
// touched record to maintain. This is what the tracking costs, and it is charged only here.
const preservedSurfaces = [...preserved.all('BuildingSurface:Detailed')];
const readWhilePreserving = median('a vertex while preserving', () => {
  let total = 0;
  for (const surface of preservedSurfaces) {
    for (const vertex of surface.extensible) total += Number(vertex['vertex_x_coordinate'] ?? 0);
  }
  return total;
});

const vertices = raw.reduce((n, groups) => n + groups.length, 0);

console.log(`\n  the preserving writer, measured\n`);
console.log(`  model            ${text.length.toLocaleString()} bytes, ${surfaces.length} surfaces, ${vertices.toLocaleString()} vertices`);
console.log(`  runs             median of ${RUNS}, after ${WARMUP} warm-up calls\n`);
console.log('  measurement                              median ms');
for (const m of [plain, kept, scan, writePreserving, writeFormatting, readThroughArray, readThroughWrapper, readWhilePreserving]) {
  console.log(`  ${m.label.padEnd(38)} ${m.value.toFixed(3).padStart(9)}`);
}

const ratio = (a, b) => `${(a.value / b.value).toFixed(2)}x`;
console.log('\n  ratios, which are what a machine cannot distort\n');
console.log(`  SC-004  preservation off / a plain read     ${ratio(plain, plain)}  by construction: it IS the plain read`);
console.log(`  SC-005  preservation on / preservation off  ${ratio(kept, plain)}  budget 1.25x plus one anchors array`);
console.log(`          scanIdf alone / a plain read        ${ratio(scan, plain)}  what the layer costs on its own`);
console.log(`          a preserving write / a formatting write  ${ratio(writePreserving, writeFormatting)}`);
console.log(`  wrapper a vertex, not preserving / a plain array  ${ratio(readThroughWrapper, readThroughArray)}`);
console.log(`          a vertex, preserving / a plain array      ${ratio(readWhilePreserving, readThroughArray)}  the accessors, charged only where they earn their keep`);
console.log();
