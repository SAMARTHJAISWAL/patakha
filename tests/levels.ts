/** Synthetic 10 ms level sequences (dBFS) for testing the burst detector. */
import { rng } from '../src/dsp/rng';

export const DT = 0.01;

export class Scene {
  readonly levels: number[];
  private readonly r: () => number;

  constructor(seconds: number, readonly bg = -55, seed = 1) {
    this.r = rng(seed);
    this.levels = Array.from({ length: Math.round(seconds / DT) }, () => bg + (this.r() - 0.5) * 4);
  }

  /** Add a sound (energy sum) of the given level shape starting at t seconds. */
  private add(t: number, shape: number[]): void {
    const i0 = Math.round(t / DT);
    shape.forEach((l, k) => {
      const i = i0 + k;
      if (i >= this.levels.length) return;
      const a = 10 ** (this.levels[i]! / 10) + 10 ** (l / 10);
      this.levels[i] = 10 * Math.log10(a);
    });
  }

  /** A cracker: instant rise to `peak`, then an exponential decay of `decay` dB per 10 ms. */
  bang(t: number, peak = -10, decay = 3): this {
    const shape: number[] = [];
    for (let l = peak; l > this.bg - 10; l -= decay) shape.push(l);
    this.add(t, shape);
    return this;
  }

  /** A string of `n` bangs `gap` seconds apart. */
  ladi(t: number, n: number, gap = 0.07, peak = -14): this {
    for (let k = 0; k < n; k++) this.bang(t + k * gap, peak + (this.r() - 0.5) * 6, 4);
    return this;
  }

  /** A sustained sound: ramps up over `rise` seconds, holds, then fades. */
  sustained(t: number, seconds: number, level = -22, rise = 0.25): this {
    const n = Math.round(seconds / DT);
    const r = Math.round(rise / DT);
    this.add(t, Array.from({ length: n }, (_, k) => level - Math.max(0, (r - k) / r) * 30 + (this.r() - 0.5) * 2));
    return this;
  }

  /** Speech-like: syllables 8-12 dB above the background, smooth onsets. */
  speech(t: number, seconds: number): this {
    const n = Math.round(seconds / DT);
    this.add(t, Array.from({ length: n }, (_, k) => this.bg + 6 + 6 * Math.max(0, Math.sin((k / 12) * Math.PI))));
    return this;
  }
}
