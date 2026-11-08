/**
 * A-frequency-weighting as a digital filter.
 *
 * Sound level meters weight frequencies the way human hearing roughly does
 * (IEC 61672-1): low rumble counts for much less than the 1-4 kHz range our ears
 * are most sensitive to. The analogue A-weighting curve has four zeros at the
 * origin and poles at 20.6 Hz (double), 107.7 Hz, 737.9 Hz and 12,194 Hz (double).
 * We map it to the sample rate with the bilinear transform, split it into three
 * second-order sections, and normalise it to exactly 0 dB at 1 kHz.
 */

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

const F1 = 20.598997;
const F2 = 107.65265;
const F3 = 737.86223;
const F4 = 12194.217;

/** Map an analogue pole at -2πf (rad/s) into the z-plane with the bilinear transform. */
const pole = (f: number, fs: number): number => {
  const k = (2 * Math.PI * f) / (2 * fs);
  return (1 - k) / (1 + k);
};

/** Section with two real poles p, q and two zeros at z = zero. */
function section(p: number, q: number, zero: 1 | -1): Biquad {
  return {
    b0: 1,
    b1: -2 * zero,
    b2: 1,
    a1: -(p + q),
    a2: p * q,
  };
}

/** Magnitude of a cascade of biquads at frequency f. */
export function response(sections: readonly Biquad[], f: number, fs: number, gain = 1): number {
  const w = (2 * Math.PI * f) / fs;
  const cr = Math.cos(w);
  const ci = -Math.sin(w);
  const c2r = Math.cos(2 * w);
  const c2i = -Math.sin(2 * w);
  let mag = gain;
  for (const s of sections) {
    const nr = s.b0 + s.b1 * cr + s.b2 * c2r;
    const ni = s.b1 * ci + s.b2 * c2i;
    const dr = 1 + s.a1 * cr + s.a2 * c2r;
    const di = s.a1 * ci + s.a2 * c2i;
    mag *= Math.hypot(nr, ni) / Math.hypot(dr, di);
  }
  return mag;
}

export interface AWeighting {
  sections: Biquad[];
  /** Overall gain that makes the response exactly 1 at 1 kHz. */
  gain: number;
}

export function designAWeighting(fs: number): AWeighting {
  const sections = [
    // Two zeros at DC with the two 20.6 Hz poles: the steep low-frequency roll-off.
    section(pole(F1, fs), pole(F1, fs), 1),
    // Two more zeros at DC with the 107.7 Hz and 737.9 Hz poles.
    section(pole(F2, fs), pole(F3, fs), 1),
    // The high-frequency roll-off: zeros at Nyquist (the bilinear image of s = ∞).
    section(pole(F4, fs), pole(F4, fs), -1),
  ];
  return { sections, gain: 1 / response(sections, 1000, fs) };
}

/** A-weighting in dB at frequency f, for this sample rate. */
export function aWeightDb(a: AWeighting, f: number, fs: number): number {
  return 20 * Math.log10(response(a.sections, f, fs, a.gain));
}

/** Stateful cascade filter for streaming audio (direct form II transposed). */
export class AFilter {
  private readonly s: Biquad[];
  private readonly g: number;
  private readonly z1: Float64Array;
  private readonly z2: Float64Array;

  constructor(fs: number) {
    const a = designAWeighting(fs);
    this.s = a.sections;
    this.g = a.gain;
    this.z1 = new Float64Array(this.s.length);
    this.z2 = new Float64Array(this.s.length);
  }

  /** Filter `input` into `output` (may be the same array). */
  process(input: ArrayLike<number>, output: Float32Array | Float64Array): void {
    const n = this.s.length;
    for (let i = 0; i < input.length; i++) {
      let x = input[i]! * this.g;
      for (let k = 0; k < n; k++) {
        const s = this.s[k]!;
        const y = s.b0 * x + this.z1[k]!;
        this.z1[k] = s.b1 * x - s.a1 * y + this.z2[k]!;
        this.z2[k] = s.b2 * x - s.a2 * y;
        x = y;
      }
      output[i] = x;
    }
  }
}
