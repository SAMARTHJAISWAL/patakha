/**
 * Finds cracker bursts in a stream of 10 ms levels.
 *
 * A cracker is an impulse: the level jumps by tens of decibels within a few
 * milliseconds, far above the background, then decays. The detector tracks the
 * background as a low percentile of the last few seconds (so a burst itself
 * barely moves it), and starts an event on a sharp rise well above it. Bangs that
 * follow each other closely are grouped into a series, and each series is then
 * classified:
 *
 * - ladi: five or more bangs in quick succession (a string of crackers),
 * - long: a sound that stays far above the background for most of a second or
 *   more (anaar fountains, rocket whistles, chakri),
 * - bang: anything else (a single bomb, a few in a row).
 *
 * Levels are in dBFS here, so detection does not depend on calibration.
 */

export type Kind = 'bang' | 'ladi' | 'long';

export interface Burst {
  kind: Kind;
  /** Start time, seconds since the measurement began. */
  t: number;
  /** Highest 10 ms level in the series, dBFS. */
  peak: number;
  /** Seconds from the first onset to the end of the last bang. */
  dur: number;
  /** Number of bangs (1 for a single bang or a long sound). */
  count: number;
  /** The microphone overloaded, so the real peak was higher. */
  clipped: boolean;
}

export interface DetectorOptions {
  /** How far above the background an onset must reach, dB. */
  aboveBg: number;
  /** How much the level must rise within `attackBlocks`, dB. */
  attack: number;
  attackBlocks: number;
  /** An event ends when the level stays within this of the background for `releaseBlocks`. */
  release: number;
  releaseBlocks: number;
  /** A drop of this much below the bang's peak, then a rise of `reattack` within 20 ms, starts a new bang. */
  split: number;
  /**
   * Inside a ladi the bangs overlap, so the next one often rises only a few dB out of
   * the previous one's tail. This is lower than `attack`, which applies from silence.
   */
  reattack: number;
  /** Likewise, how far above the background a bang inside an event must reach, dB. */
  reAboveBg: number;
  /** Bangs closer than this (seconds) belong to the same series. */
  seriesGap: number;
  /** Series with at least this many bangs are a ladi. */
  ladi: number;
  /**
   * A sound that stays within `holdRange` dB of its peak for at least this long (seconds)
   * is a long sound. Total duration would not do: a big bang's echo fades for a second or more.
   */
  long: number;
  holdRange: number;
  /** A sound this far above the background for `swellBlocks` counts even without a sharp onset (whistles). */
  swell: number;
  swellBlocks: number;
  /** Background: this percentile of the last `windowBlocks` levels. */
  percentile: number;
  windowBlocks: number;
  /** Ignore anything quieter than this, dBFS (a silent or missing microphone). */
  floor: number;
  /** Longest single event, seconds. */
  maxEvent: number;
}

export const DEFAULTS: DetectorOptions = {
  aboveBg: 14,
  attack: 9,
  attackBlocks: 3,
  release: 6,
  releaseBlocks: 6,
  split: 6,
  reattack: 6,
  reAboveBg: 8,
  seriesGap: 0.45,
  ladi: 5,
  long: 0.5,
  holdRange: 10,
  swell: 16,
  swellBlocks: 25,
  percentile: 0.3,
  windowBlocks: 500,
  floor: -75,
  maxEvent: 8,
};

/** Blocks (10 ms each) of listening before detection starts. */
const WARMUP = 50;

interface Bang {
  start: number;
  end: number;
  peak: number;
  clipped: boolean;
  /** Every 10 ms level of the bang (to measure how long it held near its peak). */
  levels: number[];
}

export class BurstDetector {
  readonly opts: DetectorOptions;
  /** Called the moment a bang starts (for a flash on screen). */
  onOnset: ((t: number) => void) | null = null;
  /** Called when a series is complete and classified. */
  onBurst: ((b: Burst) => void) | null = null;

  private readonly ring: Float64Array;
  private filled = 0;
  private pos = 0;
  private bg = -100;
  private sinceBg = 0;
  private t = 0;
  private cur: Bang | null = null;
  private quiet = 0;
  /** Lowest level since the current bang's peak (for splitting a ladi into bangs). */
  private trough = Infinity;
  private swellRun = 0;
  private series: Bang[] = [];
  bangs = 0;

  constructor(opts: Partial<DetectorOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.ring = new Float64Array(this.opts.windowBlocks);
  }

  get background(): number {
    return this.bg;
  }

  /** Feed one block level (dBFS) of duration dt seconds. */
  push(level: number, dt: number, clipped = false): void {
    const o = this.opts;
    this.t += dt;
    const t = this.t;
    const prev = this.ago(o.attackBlocks);

    if (this.filled < WARMUP) {
      // Learn what normal sounds like before judging anything against it.
      this.learn(level);
    } else if (this.cur) {
      const c = this.cur;
      // A new bang inside the event: the level fell well below this bang's peak and
      // now jumps up again sharply. Checked before the peak is updated, so a louder
      // next bang starts a new bang instead of just raising this one's peak.
      const sharp = level - Math.min(this.ago(1), this.ago(2)) >= o.reattack;
      const resplit = this.trough <= c.peak - o.split && sharp && level >= this.bg + o.reAboveBg;
      if (!resplit) {
        if (c.levels.length < 1000) c.levels.push(level);
        if (level > c.peak) {
          c.peak = level;
          this.trough = level;
        } else if (level < this.trough) this.trough = level;
        c.clipped ||= clipped;
      }
      if (resplit) {
        c.end = t - dt;
        this.closeBang();
        this.openBang(t - dt, level, clipped);
      } else if (level < this.bg + o.release) {
        if (++this.quiet >= o.releaseBlocks) {
          c.end = t - this.quiet * dt;
          this.closeBang();
        }
      } else {
        this.quiet = 0;
        if (t - c.start > o.maxEvent) this.backgroundChanged();
      }
    } else {
      const onset = level >= o.floor && level >= this.bg + o.aboveBg && level - prev >= o.attack;
      this.swellRun = level >= o.floor && level >= this.bg + o.swell ? this.swellRun + 1 : 0;
      if (onset) this.openBang(t - dt, level, clipped);
      else if (this.swellRun >= o.swellBlocks) this.openBang(t - this.swellRun * dt, level, clipped);
      else this.learn(level);
    }

    this.remember(level);
    const last = this.series.at(-1);
    if (!this.cur && last && t - last.end > o.seriesGap) this.closeSeries();
  }

  /**
   * An event that is still near its peak after `maxEvent` seconds is not a cracker:
   * the background itself got louder (a generator, music, traffic). Drop it and
   * re-learn the background from the last couple of seconds.
   */
  private backgroundChanged(): void {
    this.cur = null;
    this.quiet = 0;
    this.bangs--;
    const n = Math.min(this.filled, 200);
    const recent: number[] = [];
    for (let k = 1; k <= n; k++) recent.push(this.ago(k));
    recent.sort((a, b) => a - b);
    this.bg = recent[Math.floor(this.opts.percentile * (recent.length - 1))] ?? this.bg;
  }

  /** Forget everything heard so far (listening restarted, perhaps somewhere else). */
  reset(): void {
    this.flush();
    this.filled = 0;
    this.pos = 0;
    this.bg = -100;
    this.sinceBg = 0;
    this.swellRun = 0;
    this.quiet = 0;
    // The clock keeps running: burst times stay comparable across restarts.
  }

  /** Finish whatever is in progress (end of measurement). */
  flush(): void {
    if (this.cur) {
      this.cur.end = this.t;
      this.closeBang();
    }
    if (this.series.length) this.closeSeries();
  }

  private openBang(start: number, level: number, clipped: boolean): void {
    this.cur = { start, end: start, peak: level, clipped, levels: [level] };
    this.trough = level;
    this.quiet = 0;
    this.swellRun = 0;
    this.bangs++;
    this.onOnset?.(start);
  }

  private closeBang(): void {
    this.series.push(this.cur!);
    this.cur = null;
    this.quiet = 0;
  }

  private closeSeries(): void {
    const o = this.opts;
    // Split where one bang starts long after the previous one: a bomb whose echo
    // runs into a ladi is a bang, then a ladi, not one long ladi.
    const runs: Bang[][] = [];
    for (const b of this.series) {
      const run = runs.at(-1);
      if (run && b.start - run.at(-1)!.start <= o.seriesGap) run.push(b);
      else runs.push([b]);
    }
    this.series = [];
    for (const run of runs) this.classify(run);
  }

  private classify(run: Bang[]): void {
    const o = this.opts;
    const dt = 0.01;
    if (run.length >= o.ladi) {
      const peak = Math.max(...run.map((b) => b.peak));
      const start = run[0]!.start;
      this.onBurst?.({ kind: 'ladi', t: start, peak, dur: run.at(-1)!.end - start, count: run.length, clipped: run.some((b) => b.clipped) });
      return;
    }
    // A short run of separate bangs is reported bang by bang.
    for (const b of run) {
      const held = b.levels.filter((l) => l >= b.peak - o.holdRange).length * dt;
      this.onBurst?.({ kind: held >= o.long ? 'long' : 'bang', t: b.start, peak: b.peak, dur: b.end - b.start, count: 1, clipped: b.clipped });
    }
  }

  /** Level n blocks ago (or a very low value before there is history). */
  private ago(n: number): number {
    if (this.filled < n) return -200;
    const i = (this.pos - n + this.ring.length * 2) % this.ring.length;
    return this.ring[i]!;
  }

  private remember(level: number): void {
    this.ring[this.pos] = level;
    this.pos = (this.pos + 1) % this.ring.length;
    if (this.filled < this.ring.length) this.filled++;
  }

  /** Update the background estimate, only while nothing is happening. */
  private learn(level: number): void {
    if (this.filled < WARMUP) {
      // Until there is enough history, follow the level directly (it starts at the first level heard).
      this.bg = this.filled === 0 ? level : Math.min(this.bg + 0.5, Math.max(this.bg - 3, level));
      return;
    }
    if (++this.sinceBg < 20) return;
    this.sinceBg = 0;
    const xs = Array.from(this.ring.subarray(0, this.filled)).sort((a, b) => a - b);
    this.bg = xs[Math.floor(this.opts.percentile * (xs.length - 1))]!;
  }
}
