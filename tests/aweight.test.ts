import { describe, expect, it } from 'vitest';
import { AFilter, aWeightDb, designAWeighting } from '../src/dsp/aweight';

// IEC 61672-1 Table 3: nominal A-weighting in dB.
const IEC: [number, number][] = [
  [31.5, -39.4], [63, -26.2], [125, -16.1], [250, -8.6], [500, -3.2],
  [1000, 0], [2000, 1.2], [4000, 1.0], [8000, -1.1], [10000, -2.5],
];

describe('A-weighting filter', () => {
  for (const fs of [44100, 48000]) {
    it(`matches the IEC 61672 curve at ${fs} Hz`, () => {
      const a = designAWeighting(fs);
      for (const [f, db] of IEC) {
        // The bilinear transform squeezes the top octave. Still far inside the IEC 61672
        // class 1 tolerances there (+1.5/-2.5 dB at 8 kHz, +2/-3 dB at 10 kHz).
        const tol = f <= 4000 ? 0.15 : f <= 8000 ? 1.0 : 1.6;
        expect(Math.abs(aWeightDb(a, f, fs) - db), `${f} Hz`).toBeLessThan(tol);
      }
      expect(aWeightDb(a, 1000, fs)).toBeCloseTo(0, 10);
    });
  }

  it('filters a sine by the right amount in the time domain', () => {
    const fs = 48000;
    for (const [f, db] of [[100, -19.1], [1000, 0], [3150, 1.2]] as const) {
      const filt = new AFilter(fs);
      const n = fs; // one second
      const x = new Float64Array(n);
      for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * f * i) / fs);
      const y = new Float64Array(n);
      filt.process(x, y);
      let e = 0;
      for (let i = n / 2; i < n; i++) e += y[i]! * y[i]!; // skip the start-up transient
      const rms = Math.sqrt(e / (n / 2));
      expect(20 * Math.log10(rms / Math.SQRT1_2), `${f} Hz`).toBeCloseTo(db, 0);
    }
  });
});
