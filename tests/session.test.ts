import { describe, expect, it } from 'vitest';
import { BurstDetector, type Burst } from '../src/dsp/bursts';
import { LOG_LIMIT, Session, parseSaved } from '../src/session';
import { DT, Scene } from './levels';

/** Blocks for a level sequence in dBFS (mean square = 10^(L/10)). */
const blocks = (levels: number[]) => levels.map((l) => ({ ms: 10 ** (l / 10), peak: 10 ** (l / 20), clipped: false, dt: DT }));

describe('Session', () => {
  it('keeps the totals across a reload, even past the log limit', () => {
    const s = new Session();
    const d = s.detector as unknown as { onBurst: (b: Burst) => void };
    for (let i = 0; i < LOG_LIMIT + 1000; i++) d.onBurst({ kind: 'bang', t: i, peak: -10, dur: 0.1, count: 1, clipped: false });
    expect(s.totals.crackers).toBe(LOG_LIMIT + 1000);
    const again = new Session(parseSaved(JSON.stringify(s.save())));
    expect(again.totals.crackers).toBe(LOG_LIMIT + 1000);
    expect(again.bursts).toHaveLength(LOG_LIMIT);
  });

  it('recalibrating moves every level together, so the average never passes the loudest', () => {
    const s = new Session();
    s.push(blocks(new Scene(20).bang(5).bang(12, -5).levels));
    const gap = s.meter.maxFast - s.leq;
    const peakGap = s.meter.maxFast - s.db(s.bursts[0]!);
    for (const offset of [100, 120, 135, 150]) {
      s.offset = offset;
      expect(s.meter.maxFast - s.leq).toBeCloseTo(gap, 6);
      expect(s.meter.maxFast - s.db(s.bursts[0]!)).toBeCloseTo(peakGap, 0);
      expect(s.meter.maxFast).toBeGreaterThan(s.leq);
    }
  });

  it('restores the loudest level and the average from a save', () => {
    const s = new Session();
    s.push(blocks(new Scene(10).bang(4).levels));
    s.flush();
    const r = new Session(parseSaved(JSON.stringify(s.save())));
    expect(r.meter.maxFast).toBeCloseTo(s.meter.maxFast, 6);
    expect(r.leq).toBeCloseTo(s.leq, 6);
    expect(r.duration).toBeCloseTo(s.duration, 6);
  });
});

describe('parseSaved', () => {
  const good = () => {
    const s = new Session();
    s.push(blocks(new Scene(8).bang(3).levels));
    s.flush();
    return s.save();
  };

  it('accepts what save() writes', () => {
    const saved = good();
    expect(parseSaved(JSON.stringify(saved))).toEqual(saved);
  });

  it.each([
    ['corrupt JSON', '{"v":2,'],
    ['an old version', JSON.stringify({ ...good(), v: 1 })],
    ['a negative total', JSON.stringify({ ...good(), totals: { ...good().totals, crackers: -5 } })],
    ['null energy', JSON.stringify({ ...good(), meter: { ...good().meter, energy: null } })],
  ])('rejects %s', (_, raw) => {
    expect(parseSaved(raw)).toBeNull();
  });

  it('drops bursts with impossible values', () => {
    const s = good();
    s.bursts.push({ ...s.bursts[0]!, count: -1_000_000_000 }, { ...s.bursts[0]!, fs: Infinity } as never);
    expect(parseSaved(JSON.stringify(s))!.bursts).toHaveLength(1);
  });
});

describe('the detector and changes in the background', () => {
  it('does not log a sudden, steady rise in background noise as a rocket', () => {
    const d = new BurstDetector();
    const out: Burst[] = [];
    d.onBurst = (b) => out.push(b);
    const s = new Scene(30, -55);
    // A generator starts at 8 s and keeps running, 25 dB above the quiet street.
    for (let i = 800; i < s.levels.length; i++) s.levels[i] = -30 + (Math.sin(i) * 1.5);
    for (const l of s.levels) d.push(l, DT);
    d.flush();
    expect(out).toEqual([]);
    // ...and afterwards a real bang on top of the generator is still heard.
    const s2 = new Scene(4, -30).bang(2, -2);
    for (const l of s2.levels) d.push(l, DT);
    d.flush();
    expect(out.map((b) => b.kind)).toEqual(['bang']);
  });

  it('re-learns the background after a reset (the phone moved somewhere louder)', () => {
    const d = new BurstDetector();
    const out: Burst[] = [];
    d.onBurst = (b) => out.push(b);
    for (const l of new Scene(5, -60).levels) d.push(l, DT);
    d.reset();
    for (const l of new Scene(5, -35).levels) d.push(l, DT);
    d.flush();
    expect(out).toEqual([]);
  });
});
