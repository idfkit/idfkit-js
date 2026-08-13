import { describe, expect, it } from 'vitest';

import { unzip } from '@idfkit/weather';

import { buildZip } from './helpers.js';

describe('unzip', () => {
  it('reads deflated members back to their original bytes', async () => {
    const epw = new TextEncoder().encode('LOCATION,Chicago,IL,USA\n' + 'x'.repeat(5000));
    const ddy = new TextEncoder().encode('SizingPeriod:DesignDay,\n');
    const archive = buildZip({ 'city.epw': epw, 'city.ddy': ddy });

    const members = await unzip(archive);
    expect([...members.keys()].sort()).toEqual(['city.ddy', 'city.epw']);
    expect(members.get('city.epw')).toEqual(epw);
    expect(members.get('city.ddy')).toEqual(ddy);
  });

  it('preserves Latin-1 high bytes through extraction', async () => {
    // 0xED is 'í' in Latin-1 — the kind of byte in a "Potosí" station name.
    const raw = new Uint8Array([0x4c, 0x4f, 0x43, 0xed]);
    const members = await unzip(buildZip({ 'x.epw': raw }));
    expect(members.get('x.epw')).toEqual(raw);
  });

  it('throws on a buffer that is not a ZIP', async () => {
    await expect(unzip(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/not a ZIP/i);
  });
});
