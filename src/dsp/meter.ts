/**
 * Sound level meter maths, working on 10 ms blocks of audio that have already
 * been A-weighted. Everything here is plain arithmetic so it can be tested
 * without a browser.
 *
 * A phone microphone reports levels relative to digital full scale (dBFS), not
 * sound pressure. `offset` turns one into the other: dB(A) = 10·log10(mean square) + offset.
 * The default is a typical value for phone microphones; it can be calibrated
 * against a real meter. Either way the absolute numbers are approximate, while
 * differences between readings (a burst 30 dB above the background) are much more reliable.
 */

export interface Block {
  /** Mean square of the A-weighted samples in the block. */
  ms: number;
  /** Largest absolute unweighted sample. */
  peak: number;
  /** True if any sample reached full scale (the microphone overloaded). */
  clipped: boolean;
  /** Block length in seconds. */
  dt: number;
}

export const DEFAULT_OFFSET = 120;
/** Levels below this are treated as silence (a muted or missing microphone). */
const FLOOR_DB = 0;

export const toDb = (ms: number, offset: number): number => (ms > 0 ? Math.max(FLOOR_DB, 10 * Math.log10(ms) + offset) : FLOOR_DB);

/** Exponential time weighting: Fast is 125 ms, Slow is 1 s (IEC 61672). */
export const FAST = 0.125;
export const SLOW = 1;

export class Meter {
  offset = DEFAULT_OFFSET;
  private fastMs = 0;
  private slowMs = 0;
  /** Sum of mean square × seconds: the energy behind LAeq (independent of the offset). */
  energy = 0;
  /** Seconds measured. */
  duration = 0;
  /** Highest Fast mean square so far (offset-free, so recalibrating moves it consistently). */
  maxFastMs = 0;
  maxPeak = 0;
  clippedBlocks = 0;
  /** Seconds with the Fast level at or above each threshold. */
  readonly above = new Map<number, number>([
    [85, 0],
    [100, 0],
  ]);

  push(b: Block): void {
    this.fastMs += (b.ms - this.fastMs) * (1 - Math.exp(-b.dt / FAST));
    this.slowMs += (b.ms - this.slowMs) * (1 - Math.exp(-b.dt / SLOW));
    this.energy += b.ms * b.dt;
    this.duration += b.dt;
    if (this.fastMs > this.maxFastMs) this.maxFastMs = this.fastMs;
    const fast = this.fast;
    if (b.peak > this.maxPeak) this.maxPeak = b.peak;
    if (b.clipped) this.clippedBlocks++;
    for (const [level, secs] of this.above) if (fast >= level) this.above.set(level, secs + b.dt);
  }

  /** LAF: A-weighted, Fast. What the big number shows. */
  get fast(): number {
    return toDb(this.fastMs, this.offset);
  }

  /** LAS: A-weighted, Slow. */
  get slow(): number {
    return toDb(this.slowMs, this.offset);
  }

  /** LAFmax: the highest Fast level so far. */
  get maxFast(): number {
    return this.maxFastMs > 0 ? toDb(this.maxFastMs, this.offset) : -Infinity;
  }

  /** LAeq: the energy average over everything measured so far. */
  get leq(): number {
    return this.duration > 0 ? toDb(this.energy / this.duration, this.offset) : FLOOR_DB;
  }

  /** Peak sound level from the largest sample (unweighted, so it is not dB(A)). */
  get peak(): number {
    return this.maxPeak > 0 ? 20 * Math.log10(this.maxPeak) + this.offset : FLOOR_DB;
  }

  reset(): void {
    this.fastMs = this.slowMs = this.energy = this.duration = 0;
    this.maxFastMs = 0;
    this.maxPeak = 0;
    this.clippedBlocks = 0;
    for (const k of this.above.keys()) this.above.set(k, 0);
  }
}

/** Energy average of levels in dB. */
export function leqOf(levels: readonly number[]): number {
  if (levels.length === 0) return FLOOR_DB;
  let e = 0;
  for (const l of levels) e += 10 ** (l / 10);
  return 10 * Math.log10(e / levels.length);
}
