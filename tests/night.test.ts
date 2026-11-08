import { describe, expect, it } from 'vitest';
import { binNight, noiseDose } from '../src/night';
import type { LoggedBurst } from '../src/session';

describe('noise dose (NIOSH)', () => {
  it('is 100% for 8 hours at 85 dB(A)', () => {
    expect(noiseDose(85, 8 * 3600)).toBeCloseTo(100, 6);
  });
  it('doubles for every 3 dB louder', () => {
    expect(noiseDose(88, 8 * 3600)).toBeCloseTo(200, 6);
    expect(noiseDose(100, 15 * 60)).toBeCloseTo(100, 6); // 100 dB(A): 15 minutes is a full day's dose
  });
  it('is nothing for nothing measured', () => {
    expect(noiseDose(120, 0)).toBe(0);
  });
});

describe('the night in 10-minute bins', () => {
  const at = (h: number, m: number) => new Date(2026, 10, 8, h, m).getTime();
  const burst = (t: number, count = 1, fs = -20): LoggedBurst => ({ kind: count > 1 ? 'ladi' : 'bang', at: t, fs, dur: 0.1, count, clipped: false });

  it('counts crackers per bin, a ladi counting every bang, aligned to the clock', () => {
    const bins = binNight([burst(at(20, 3)), burst(at(20, 7), 20, -10), burst(at(20, 25))], at(20, 3), at(20, 31), 10, 48, 1);
    expect(bins.map((b) => new Date(b.start).getMinutes())).toEqual([0, 10, 20, 30]);
    expect(bins.map((b) => b.crackers)).toEqual([21, 0, 1, 0]);
    expect(bins[0]!.loudest).toBe(-10);
    expect(bins[1]!.loudest).toBeNull();
  });

  it('keeps only the latest bins on a very long night', () => {
    const bins = binNight([burst(at(18, 0)), burst(at(23, 55))], at(18, 0), at(23, 59), 10, 12);
    expect(bins).toHaveLength(12);
    expect(bins.at(-1)!.crackers).toBe(1);
    expect(bins.reduce((n, b) => n + b.crackers, 0)).toBe(1);
  });

  it('shows at least two hours, ending now, so early bars keep a sensible size', () => {
    const bins = binNight([burst(at(21, 2))], at(21, 0), at(21, 5));
    expect(bins).toHaveLength(12);
    expect(new Date(bins[0]!.start).getHours()).toBe(19);
    expect(new Date(bins.at(-1)!.start).getMinutes()).toBe(0);
    expect(bins.at(-1)!.crackers).toBe(1);
  });
});
