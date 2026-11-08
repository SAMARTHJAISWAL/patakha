import type { LoggedBurst } from './session';

/**
 * Noise dose, the NIOSH way: 85 dB(A) for 8 hours is 100% of a day's safe
 * exposure, and every 3 dB louder halves the safe time (equal energy). From an
 * energy average `leq` over `seconds`, the dose is the time spent divided by the
 * time allowed at that level.
 */
export function noiseDose(leq: number, seconds: number): number {
  if (seconds <= 0) return 0;
  const allowed = 8 * 3600 / 2 ** ((leq - 85) / 3);
  return (100 * seconds) / allowed;
}

export interface Bin {
  /** Start of the bin, ms since the epoch. */
  start: number;
  /** Crackers heard in it (a ladi counts every bang). */
  crackers: number;
  /** Loudest burst in it, dBFS (null if none). */
  loudest: number | null;
}

/**
 * Crackers per `minutes`-minute bin, from the first burst (or `from`) to `to`,
 * aligned to the clock (9:00, 9:10, ...). At least `minBins` bins (so a short
 * measurement still shows a sensible time axis) and at most `maxBins`, the latest kept.
 */
export function binNight(bursts: readonly LoggedBurst[], from: number, to: number, minutes = 10, maxBins = 48, minBins = 12): Bin[] {
  const size = minutes * 60_000;
  const first = bursts.length ? Math.min(from, bursts[0]!.at) : from;
  const start = Math.min(Math.floor(first / size) * size, Math.floor(to / size) * size - (minBins - 1) * size);
  const end = Math.max(to, start + size);
  let n = Math.ceil((end - start) / size);
  let origin = start;
  if (n > maxBins) {
    origin = start + (n - maxBins) * size;
    n = maxBins;
  }
  const bins: Bin[] = Array.from({ length: n }, (_, i) => ({ start: origin + i * size, crackers: 0, loudest: null }));
  for (const b of bursts) {
    const i = Math.floor((b.at - origin) / size);
    const bin = bins[i];
    if (!bin) continue;
    bin.crackers += b.count;
    bin.loudest = bin.loudest === null ? b.fs : Math.max(bin.loudest, b.fs);
  }
  return bins;
}
