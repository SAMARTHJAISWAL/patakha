import { BurstDetector, type Burst, type Kind } from './dsp/bursts';
import { DEFAULT_OFFSET, Meter, toDb, type Block } from './dsp/meter';

/** A burst as logged. Levels are kept uncalibrated (dBFS), so recalibrating moves everything together. */
export interface LoggedBurst {
  kind: Kind;
  /** Wall-clock time, ms since the epoch. */
  at: number;
  /** Highest 10 ms A-weighted level, dBFS. Add the offset for dB(A). */
  fs: number;
  dur: number;
  count: number;
  clipped: boolean;
}

export interface Totals {
  crackers: number;
  ladis: number;
  long: number;
  /** Bangs outside 8-10 pm, local time. */
  outsideHours: number;
}

/** Everything that survives a reload. */
export interface Saved {
  v: 2;
  started: number;
  totals: Totals;
  bursts: LoggedBurst[];
  meter: { energy: number; duration: number; maxFastMs: number; maxFastAt: number; above85: number; above100: number };
}

const TRACE_SECONDS = 90;
const TRACE_STEP = 0.1;
export const LOG_LIMIT = 5000;

/** True if a time is outside the 8-10 pm window the Supreme Court set for Diwali crackers in 2018. */
export const outsideCrackerHours = (at: number): boolean => {
  const h = new Date(at).getHours();
  return h < 20 || h >= 22;
};

/**
 * One night's measurement: the meter, the burst detector, a short level trace for
 * the chart, and the log. Feed it 10 ms blocks; read numbers off it.
 */
export class Session {
  readonly meter = new Meter();
  readonly detector = new BurstDetector();
  readonly bursts: LoggedBurst[] = [];
  readonly totals: Totals = { crackers: 0, ladis: 0, long: 0, outsideHours: 0 };
  /** Fast level every 100 ms for the last 90 s (oldest first), and onset times (seconds of `clock`). */
  readonly trace: number[] = [];
  readonly onsets: number[] = [];
  started = Date.now();
  maxFastAt = 0;
  /** Seconds of audio analysed in this page load. */
  clock = 0;
  /** Wall-clock time that corresponds to clock = 0. */
  private clockBase = Date.now();
  private traceAcc = 0;
  private energyBefore = 0;
  private aboveBefore = { 85: 0, 100: 0 };
  private durationBefore = 0;
  onOnset: (() => void) | null = null;
  onBurst: ((b: LoggedBurst) => void) | null = null;

  /** `demo` sessions are for trying the meter: the app never saves them. */
  constructor(
    saved?: Saved | null,
    readonly demo = false,
  ) {
    if (saved) this.restore(saved);
    this.detector.onOnset = (t) => {
      this.onsets.push(t);
      while (this.onsets.length && this.onsets[0]! < this.clock - TRACE_SECONDS) this.onsets.shift();
      this.onOnset?.();
    };
    this.detector.onBurst = (b) => this.log(b);
  }

  get offset(): number {
    return this.meter.offset;
  }

  set offset(v: number) {
    this.meter.offset = v;
  }

  /** Calibrated level of a logged burst, dB(A). */
  db(b: LoggedBurst): number {
    return Math.round(b.fs + this.offset);
  }

  /**
   * Call when listening starts: burst times line up with the wall clock again, and
   * the detector re-learns the background (the phone may be somewhere else now).
   */
  resume(): void {
    this.detector.reset();
    this.clockBase = Date.now() - this.clock * 1000;
  }

  push(blocks: readonly Block[]): void {
    for (const b of blocks) {
      this.clock += b.dt;
      const before = this.meter.maxFastMs;
      this.meter.push(b);
      if (this.meter.maxFastMs > before) this.maxFastAt = this.clockBase + this.clock * 1000;
      this.detector.push(b.ms > 0 ? 10 * Math.log10(b.ms) : -200, b.dt, b.clipped);
      this.traceAcc += b.dt;
      if (this.traceAcc >= TRACE_STEP - 1e-9) {
        this.traceAcc -= TRACE_STEP;
        this.trace.push(this.meter.fast);
        if (this.trace.length > TRACE_SECONDS / TRACE_STEP) this.trace.shift();
      }
    }
  }

  /** Finish any burst in progress (when listening stops). */
  flush(): void {
    this.detector.flush();
  }

  /** Average level over the whole night, including before a reload. */
  get leq(): number {
    const energy = this.energyBefore + this.meter.energy;
    const duration = this.durationBefore + this.meter.duration;
    return duration > 0 ? toDb(energy / duration, this.offset) : 0;
  }

  get duration(): number {
    return this.durationBefore + this.meter.duration;
  }

  /** Seconds above a level, including before a reload (judged with the calibration in force at the time). */
  above(level: 85 | 100): number {
    return (this.meter.above.get(level) ?? 0) + this.aboveBefore[level];
  }

  private log(b: Burst): void {
    const at = this.clockBase + b.t * 1000;
    const entry: LoggedBurst = { kind: b.kind, at, fs: Math.round(b.peak * 10) / 10, dur: Math.round(b.dur * 100) / 100, count: b.count, clipped: b.clipped };
    this.bursts.push(entry);
    if (this.bursts.length > LOG_LIMIT) this.bursts.shift();
    this.totals.crackers += entry.count;
    if (entry.kind === 'ladi') this.totals.ladis++;
    if (entry.kind === 'long') this.totals.long++;
    if (outsideCrackerHours(entry.at)) this.totals.outsideHours += entry.count;
    this.onBurst?.(entry);
  }

  save(): Saved {
    return {
      v: 2,
      started: this.started,
      totals: { ...this.totals },
      bursts: this.bursts.slice(),
      meter: {
        energy: this.energyBefore + this.meter.energy,
        duration: this.duration,
        maxFastMs: this.meter.maxFastMs,
        maxFastAt: this.maxFastAt,
        above85: this.above(85),
        above100: this.above(100),
      },
    };
  }

  private restore(s: Saved): void {
    this.started = s.started;
    // Totals are saved, not recounted: the log keeps only the last LOG_LIMIT bursts.
    Object.assign(this.totals, s.totals);
    this.bursts.push(...s.bursts);
    this.energyBefore = s.meter.energy;
    this.durationBefore = s.meter.duration;
    this.meter.maxFastMs = s.meter.maxFastMs;
    this.maxFastAt = s.meter.maxFastAt;
    this.aboveBefore = { 85: s.meter.above85, 100: s.meter.above100 };
  }
}

/** Validate a saved night read back from storage (it may be old, corrupt or edited). */
export function parseSaved(raw: string | null): Saved | null {
  let x: unknown;
  try {
    x = JSON.parse(raw ?? 'null');
  } catch {
    return null;
  }
  if (!x || typeof x !== 'object') return null;
  const s = x as Record<string, unknown>;
  const nonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1e7;
  if (s.v !== 2 || !nonNeg(s.started) || !Array.isArray(s.bursts) || !s.meter || typeof s.meter !== 'object' || !s.totals || typeof s.totals !== 'object') return null;
  const m = s.meter as Record<string, unknown>;
  const t = s.totals as Record<string, unknown>;
  if (!['energy', 'duration', 'maxFastMs', 'maxFastAt', 'above85', 'above100'].every((k) => nonNeg(m[k]))) return null;
  if (!['crackers', 'ladis', 'long', 'outsideHours'].every((k) => count(t[k]))) return null;
  const bursts: LoggedBurst[] = [];
  for (const b of s.bursts.slice(-LOG_LIMIT) as Record<string, unknown>[]) {
    if (!b || typeof b !== 'object') continue;
    const fs = b.fs;
    if (
      (b.kind === 'bang' || b.kind === 'ladi' || b.kind === 'long') &&
      nonNeg(b.at) &&
      typeof fs === 'number' && Number.isFinite(fs) && fs <= 10 && fs >= -200 &&
      nonNeg(b.dur) &&
      Number.isInteger(b.count) && (b.count as number) >= 1 && (b.count as number) <= 10_000 &&
      typeof b.clipped === 'boolean'
    ) {
      bursts.push({ kind: b.kind, at: b.at, fs, dur: b.dur, count: b.count as number, clipped: b.clipped });
    }
  }
  return {
    v: 2,
    started: s.started,
    totals: { crackers: t.crackers as number, ladis: t.ladis as number, long: t.long as number, outsideHours: t.outsideHours as number },
    bursts,
    meter: {
      energy: m.energy as number,
      duration: m.duration as number,
      maxFastMs: m.maxFastMs as number,
      maxFastAt: m.maxFastAt as number,
      above85: m.above85 as number,
      above100: m.above100 as number,
    },
  };
}

export { DEFAULT_OFFSET };
