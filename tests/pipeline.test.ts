import { describe, expect, it } from 'vitest';
import { Blocker } from '../src/audio/blocks';
import { demoNight } from '../src/audio/demo';
import { BurstDetector, type Burst } from '../src/dsp/bursts';
import { Meter, type Block } from '../src/dsp/meter';

/** Real audio through the real filter, blocker, meter and detector, as in the browser. */
function analyse(samples: Float32Array, fs: number) {
  const meter = new Meter();
  const det = new BurstDetector();
  const bursts: Burst[] = [];
  det.onBurst = (b) => bursts.push(b);
  const blocks: Block[] = [];
  const blocker = new Blocker(fs, (b) => {
    blocks.push(b);
    meter.push(b);
    det.push(b.ms > 0 ? 10 * Math.log10(b.ms) : -200, b.dt, b.clipped);
  });
  // Feed in 128-sample render quanta, like an AudioWorklet.
  for (let i = 0; i < samples.length; i += 128) blocker.push(samples.subarray(i, i + 128));
  det.flush();
  return { meter, bursts, blocks };
}

describe('the whole pipeline on the demo night', () => {
  for (const [fs, seed] of [[44100, 2026], [48000, 2026], [48000, 1], [48000, 2], [44100, 3], [48000, 4], [48000, 10]] as const) {
    it(`finds what was set off (night ${seed}, ${fs} Hz)`, () => {
      const demo = demoNight(fs, 60, seed);
      const { bursts, blocks, meter } = analyse(demo.samples, fs);
      expect(blocks.length).toBe(6000);
      expect(meter.duration).toBeCloseTo(60, 1);
      // Every planted event is found, as the right kind, close to when it happened.
      for (const e of demo.events) {
        const hit = bursts.find((b) => Math.abs(b.t - e.t) < 0.25);
        expect(hit, `${e.kind} at ${e.t.toFixed(2)} s`).toBeDefined();
        expect(hit!.kind, `${e.kind} at ${e.t.toFixed(2)} s`).toBe(e.kind);
        // Bangs in a ladi overlap, so a few merge; the count stays within 15%.
        if (e.kind === 'ladi') expect(Math.abs(hit!.count - e.count) / e.count).toBeLessThan(0.15);
      }
      // ...and nothing that was not set off.
      expect(bursts.length).toBe(demo.events.length);
    });
  }

  it('reads a full-scale 1 kHz sine at offset − 3 dB', () => {
    const fs = 48000;
    const x = new Float32Array(fs * 8);
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / fs);
    const { meter } = analyse(x, fs);
    // Mean square of a 0.5 sine is 0.125: 10·log10(0.125) = −9.03 dB.
    expect(meter.slow).toBeCloseTo(meter.offset - 9.03, 1);
    expect(meter.peak).toBeCloseTo(meter.offset - 6.02, 1);
  });
});
