import { rng } from '../dsp/rng';

/**
 * A synthesised minute of Diwali night, for trying the meter without a
 * microphone (and for testing it). Every event is listed, so tests can check
 * what the detector finds against what was set off.
 */
export interface DemoEvent {
  kind: 'bang' | 'ladi' | 'long';
  t: number;
  count: number;
}

export interface Demo {
  samples: Float32Array;
  events: DemoEvent[];
}

export function demoNight(sampleRate: number, seconds = 60, seed = 2026): Demo {
  const r = rng(seed);
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  const events: DemoEvent[] = [];

  // Background: a distant city hum (brownian noise) and a little wind.
  let brown = 0;
  for (let i = 0; i < n; i++) {
    brown = 0.995 * brown + (r() - 0.5) * 0.02;
    out[i] = brown * 0.045 + (r() - 0.5) * 0.0006;
  }

  const bang = (t: number, amp: number, decay: number) => {
    const i0 = Math.round(t * sampleRate);
    const len = Math.round(sampleRate * decay * 6);
    let lp = 0;
    for (let k = 0; k < len && i0 + k < n; k++) {
      const env = Math.exp(-k / (decay * sampleRate));
      // Low-passed noise with a click at the start: the crack and the boom.
      lp += 0.35 * ((r() * 2 - 1) - lp);
      const click = k < sampleRate * 0.002 ? 1 - k / (sampleRate * 0.002) : 0;
      out[i0 + k]! += amp * env * (0.7 * lp + 0.3 * (r() * 2 - 1)) + amp * 0.5 * click;
    }
  };

  const whistle = (t: number, dur: number, amp: number) => {
    const i0 = Math.round(t * sampleRate);
    const len = Math.round(dur * sampleRate);
    let phase = 0;
    for (let k = 0; k < len && i0 + k < n; k++) {
      const u = k / len;
      const f = 1400 + 1800 * u;
      phase += (2 * Math.PI * f) / sampleRate;
      const env = Math.min(1, u * 8) * Math.min(1, (1 - u) * 10);
      out[i0 + k]! += amp * env * (0.8 * Math.sin(phase) + 0.2 * (r() * 2 - 1));
    }
  };

  const hiss = (t: number, dur: number, amp: number) => {
    const i0 = Math.round(t * sampleRate);
    const len = Math.round(dur * sampleRate);
    for (let k = 0; k < len && i0 + k < n; k++) {
      const u = k / len;
      const env = Math.min(1, u * 6) * Math.min(1, (1 - u) * 6);
      const crackle = r() < 0.0015 ? 3 : 1;
      out[i0 + k]! += amp * env * (r() * 2 - 1) * crackle;
    }
  };

  // The programme: scattered bombs, a few ladis, rockets and an anaar, some near, some far.
  let t = 1.2;
  while (t < seconds - 4) {
    const roll = r();
    if (roll < 0.55) {
      bang(t, 0.15 + r() * 0.75, 0.05 + r() * 0.08);
      events.push({ kind: 'bang', t, count: 1 });
      t += 0.9 + r() * 1.8;
    } else if (roll < 0.72) {
      const count = 12 + Math.floor(r() * 25);
      let at = t;
      for (let k = 0; k < count; k++) {
        bang(at, 0.1 + r() * 0.35, 0.02 + r() * 0.015);
        at += 0.06 + r() * 0.04;
      }
      events.push({ kind: 'ladi', t, count });
      t = at + 1.5 + r() * 1.5;
    } else if (roll < 0.88) {
      const dur = 1.2 + r() * 0.8;
      whistle(t, dur, 0.12 + r() * 0.2);
      events.push({ kind: 'long', t, count: 1 });
      t += dur + 0.9;
      bang(t, 0.3 + r() * 0.5, 0.08);
      events.push({ kind: 'bang', t, count: 1 });
      t += 1.6 + r() * 1.5;
    } else {
      const dur = 2.5 + r() * 1.5;
      hiss(t, dur, 0.18 + r() * 0.15);
      events.push({ kind: 'long', t, count: 1 });
      t += dur + 1.5 + r() * 1.5;
    }
  }

  // Keep it inside full scale, like a real recording.
  for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, out[i]!));
  return { samples: out, events };
}
