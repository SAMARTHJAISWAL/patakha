import { describe, expect, it } from 'vitest';
import { BurstDetector, type Burst } from '../src/dsp/bursts';
import { DT, Scene } from './levels';

function run(scene: Scene): { bursts: Burst[]; onsets: number[] } {
  const d = new BurstDetector();
  const bursts: Burst[] = [];
  const onsets: number[] = [];
  d.onBurst = (b) => bursts.push(b);
  d.onOnset = (t) => onsets.push(t);
  for (const l of scene.levels) d.push(l, DT);
  d.flush();
  return { bursts, onsets };
}

describe('burst detector', () => {
  it('finds single bangs at the right times', () => {
    const times = [2, 3.5, 5.2, 7, 9.9];
    const s = new Scene(12);
    for (const t of times) s.bang(t);
    const { bursts } = run(s);
    expect(bursts.map((b) => b.kind)).toEqual(times.map(() => 'bang'));
    bursts.forEach((b, i) => expect(Math.abs(b.t - times[i]!)).toBeLessThan(0.03));
    for (const b of bursts) expect(b.peak).toBeGreaterThan(-12);
  });

  it('groups a string of crackers into one ladi and counts every bang', () => {
    const s = new Scene(10).ladi(3, 24);
    const { bursts, onsets } = run(s);
    expect(bursts).toHaveLength(1);
    expect(bursts[0]!.kind).toBe('ladi');
    expect(bursts[0]!.count).toBeGreaterThanOrEqual(22);
    expect(bursts[0]!.count).toBeLessThanOrEqual(24);
    expect(onsets.length).toBe(bursts[0]!.count);
    expect(bursts[0]!.dur).toBeGreaterThan(1.4);
  });

  it('reports a whistle or anaar as one long sound', () => {
    const s = new Scene(10).sustained(3, 1.8);
    const { bursts } = run(s);
    expect(bursts.map((b) => b.kind)).toEqual(['long']);
    expect(bursts[0]!.dur).toBeGreaterThan(1.2);
  });

  it('does not count speech, a slow swell or steady noise', () => {
    const s = new Scene(20).speech(2, 6).sustained(11, 3, -45, 2.5);
    expect(run(s).bursts).toEqual([]);
  });

  it('ignores a silent or missing microphone', () => {
    const s = new Scene(5, -110);
    s.bang(2, -85);
    expect(run(s).bursts).toEqual([]);
  });

  it('still hears bangs in a loud background, relative to it', () => {
    const s = new Scene(10, -30).bang(4, 0).bang(6, -2);
    expect(run(s).bursts.map((b) => b.kind)).toEqual(['bang', 'bang']);
  });

  it('a busy night: counts agree with what was set off', () => {
    const s = new Scene(120, -50, 7);
    let expected = 0;
    for (let t = 2; t < 110; t += 6) {
      s.bang(t);
      s.bang(t + 1.5, -18);
      expected += 2;
    }
    s.ladi(41, 30).ladi(83, 12);
    s.sustained(65, 2);
    const { bursts } = run(s);
    const singles = bursts.filter((b) => b.kind === 'bang').length;
    expect(Math.abs(singles - expected)).toBeLessThanOrEqual(1);
    expect(bursts.filter((b) => b.kind === 'ladi')).toHaveLength(2);
    expect(bursts.filter((b) => b.kind === 'long')).toHaveLength(1);
  });

  it('notes when the microphone overloaded', () => {
    const d = new BurstDetector();
    const out: Burst[] = [];
    d.onBurst = (b) => out.push(b);
    const s = new Scene(5).bang(2, 0);
    s.levels.forEach((l, i) => d.push(l, DT, i === 200));
    d.flush();
    expect(out[0]!.clipped).toBe(true);
  });
});
