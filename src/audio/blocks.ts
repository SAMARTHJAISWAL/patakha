import { AFilter } from '../dsp/aweight';
import type { Block } from '../dsp/meter';

/**
 * Turns a stream of samples into 10 ms blocks: A-weighted mean square, peak and
 * overload. Used by the audio worklet in the browser and directly in tests.
 */
export class Blocker {
  private readonly filter: AFilter;
  private readonly size: number;
  private readonly dt: number;
  private buf: Float64Array;
  private n = 0;
  private sum = 0;
  private peak = 0;
  private clipped = false;

  constructor(sampleRate: number, private readonly emit: (b: Block) => void) {
    this.filter = new AFilter(sampleRate);
    this.size = Math.round(sampleRate / 100);
    this.dt = this.size / sampleRate;
    this.buf = new Float64Array(0);
  }

  push(samples: Float32Array): void {
    if (this.buf.length < samples.length) this.buf = new Float64Array(samples.length);
    const w = this.buf;
    this.filter.process(samples, w);
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]!;
      const a = Math.abs(x);
      if (a > this.peak) this.peak = a;
      if (a >= 0.999) this.clipped = true;
      this.sum += w[i]! * w[i]!;
      if (++this.n === this.size) {
        this.emit({ ms: this.sum / this.size, peak: this.peak, clipped: this.clipped, dt: this.dt });
        this.n = 0;
        this.sum = 0;
        this.peak = 0;
        this.clipped = false;
      }
    }
  }
}
