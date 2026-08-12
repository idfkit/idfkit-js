import { describe, expect, it } from 'vitest';

import { lex, type LexDiagnostic } from '@idfkit/core';

describe('lex', () => {
  it('reads a single-line object', () => {
    expect(lex('Version, 26.1;')).toEqual([{ typeName: 'Version', values: ['26.1'], line: 1 }]);
  });

  it('reads a multi-line object with field comments', () => {
    const text = [
      'Zone,',
      '  Zone One,      !- Name',
      '  0,             !- Direction of Relative North',
      '  1.5;           !- X Origin',
    ].join('\n');

    expect(lex(text)).toEqual([{ typeName: 'Zone', values: ['Zone One', '0', '1.5'], line: 1 }]);
  });

  it('ignores full-line comments between objects', () => {
    const text = ['! header comment', 'Version, 26.1;', '', '! another', 'Timestep, 6;'].join('\n');
    expect(lex(text).map((o) => o.typeName)).toEqual(['Version', 'Timestep']);
  });

  it('keeps empty fields so positions stay aligned', () => {
    // A run of bare commas is how IDF says "default these fields". Collapsing
    // them would shift every later value into the wrong schema slot.
    const result = lex('Zone, Z1, , , , 3.0;');
    expect(result[0]?.values).toEqual(['Z1', '', '', '', '3.0']);
  });

  it('joins field text interrupted by a comment', () => {
    const result = lex('Zone,\n  Z1, !- Name\n  4.0;  !- Ceiling Height');
    expect(result[0]?.values).toEqual(['Z1', '4.0']);
  });

  it('reports the starting line of each object', () => {
    const text = ['', '', 'Version, 26.1;', '', 'Timestep,', '  6;'].join('\n');
    expect(lex(text).map((o) => o.line)).toEqual([3, 5]);
  });

  it('reports an unterminated object instead of silently dropping it', () => {
    const diagnostics: LexDiagnostic[] = [];
    const result = lex('Zone,\n  Z1,\n  4.0', { onDiagnostic: (d) => diagnostics.push(d) });

    expect(result).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(/missing ";"/);
  });

  it('handles a comment running to end of input', () => {
    expect(lex('Version, 26.1;\n! trailing comment with no newline')).toHaveLength(1);
  });

  it('does not treat delimiters inside comments as syntax', () => {
    const result = lex('Version, 26.1;  !- note, with a comma; and a semicolon\nTimestep, 6;');
    expect(result.map((o) => o.typeName)).toEqual(['Version', 'Timestep']);
  });

  it('is reentrant across calls', () => {
    // Guards against per-call state leaking into module scope, which an earlier
    // draft of the scanner did.
    const first = lex('Zone,\n  Z1,\n  4.0');
    const second = lex('Version, 26.1;');
    expect(first).toEqual([]);
    expect(second).toEqual([{ typeName: 'Version', values: ['26.1'], line: 1 }]);
  });
});
