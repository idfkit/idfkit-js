import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getIdfVersion, parseIdf, writeIdf } from '@idfkit/core';
import { schemaFor } from '@idfkit/core/node';

import { exampleFilesDir, schema } from './helpers.js';

const dir = exampleFilesDir();

/**
 * A broad sample of the real example set.
 *
 * These are the files EnergyPlus ships, so they exercise the parts of the
 * format that hand-written fixtures never reach: every extensible shape, every
 * odd type name, autosized fields, and objects whose field count differs from
 * what the schema nominally allows.
 */
const SAMPLE_SIZE = 120;

describe.skipIf(dir === undefined)('round-trip against EnergyPlus example files', () => {
  const files =
    dir === undefined
      ? []
      : readdirSync(dir)
          .filter((f) => f.endsWith('.idf'))
          .sort();
  const sample = files.filter(
    (_, i) => i % Math.max(1, Math.ceil(files.length / SAMPLE_SIZE)) === 0
  );

  it('has files to test', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(sample)('parses and re-parses %s without losing data', async (file) => {
    const text = readFileSync(join(dir!, file), 'latin1');
    const version = getIdfVersion(text);
    // Files bundled with the install are all current; a stale one would signal
    // the version-resolution path is wrong rather than the parser.
    expect(version).toBeDefined();

    const s = await schemaFor(version);
    const { document, diagnostics } = parseIdf(text, s, { strict: false });

    expect(diagnostics).toEqual([]);
    expect(document.size).toBeGreaterThan(0);

    // The real invariant: writing and re-reading is a fixed point. It catches
    // field-order mistakes, extensible-group miscounts, and any value the
    // writer formats in a way the parser reads back differently.
    const second = parseIdf(writeIdf(document), s, { strict: false });
    expect(second.diagnostics).toEqual([]);
    expect(second.document.toJSON()).toEqual(document.toJSON());
  });
});

describe('multi-version support', () => {
  it('parses the same model under every bundled version it exists in', async () => {
    // The point of shipping all 17 versions: a 9.x file and a 26.x file are
    // both first-class, and neither needs a separate install.
    const versions = ['8.9.0', '9.4.0', '22.2.0', '24.1.0', '26.1.0'];

    for (const version of versions) {
      const s = await schema(version);
      const { document } = parseIdf(
        `Version, ${version.split('.').slice(0, 2).join('.')};\nZone, Z1, 0, 1.0, 2.0, 0.0;`,
        s
      );
      expect(document.version).toBe(version);
      expect(document.require('Zone', 'Z1').get('x_origin')).toBe(1);
    }
  });

  it('resolves a two-part file version to a bundled patch release', async () => {
    // IDF writes `Version, 9.0;` but the bundled schema is keyed 9.0.1. Without
    // this the entire 9.0 line would be unloadable.
    const s = await schemaFor('9.0.0');
    expect(s.version).toBe('9.0.1');
  });

  it('reports a helpful error for an unsupported version', async () => {
    await expect(schemaFor('7.0.0')).rejects.toThrow(/not supported/);
  });
});
