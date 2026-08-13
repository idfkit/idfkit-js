import { describe, expect, it } from 'vitest';

import { haversineKm } from '@idfkit/weather';

describe('haversineKm', () => {
  it('is zero for identical points', () => {
    expect(haversineKm(41.98, -87.9, 41.98, -87.9)).toBe(0);
  });

  it("matches a known distance (Chicago O'Hare to Midway ~ 25 km)", () => {
    const d = haversineKm(41.98333, -87.9, 41.786, -87.752);
    expect(d).toBeGreaterThan(20);
    expect(d).toBeLessThan(30);
  });

  it('handles near-antipodal points without a domain error', () => {
    const d = haversineKm(0, 0, 0.0001, 179.9999);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeGreaterThan(20000);
  });

  it('is symmetric', () => {
    const a = haversineKm(51.5, -0.12, 48.85, 2.35);
    const b = haversineKm(48.85, 2.35, 51.5, -0.12);
    expect(a).toBeCloseTo(b, 9);
  });
});
