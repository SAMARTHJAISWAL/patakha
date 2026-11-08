/** The gauge, the level trace and the spectrogram. */

export const GAUGE_MIN = 30;
export const GAUGE_MAX = 130;

/** Bands of the scale, with the colour the gauge uses for each. */
export const BANDS = [
  { from: 30, to: 55, colour: '#3fb68b', label: 'Quiet' },
  { from: 55, to: 70, colour: '#9ccc4f', label: 'Moderate' },
  { from: 70, to: 85, colour: '#f2c230', label: 'Loud' },
  { from: 85, to: 100, colour: '#f28c28', label: 'Very loud' },
  { from: 100, to: 115, colour: '#e8463a', label: 'Harmful' },
  { from: 115, to: 130, colour: '#c2187a', label: 'Painful' },
] as const;

export function bandFor(db: number): (typeof BANDS)[number] {
  return BANDS.find((b) => db < b.to) ?? BANDS[BANDS.length - 1]!;
}

const CX = 160;
const CY = 165;
const R = 135;
const angle = (db: number) => Math.PI * (1 - (Math.min(GAUGE_MAX, Math.max(GAUGE_MIN, db)) - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN));
const pt = (db: number, r = R) => [CX + r * Math.cos(angle(db)), CY - r * Math.sin(angle(db))] as const;

function arc(from: number, to: number, r = R): string {
  const [x0, y0] = pt(from, r);
  const [x1, y1] = pt(to, r);
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

/** Build the gauge's static parts; returns a function that moves the level arc and needle. */
export function buildGauge(svg: SVGSVGElement): (db: number | null, max: number | null) => void {
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag: string, attrs: Record<string, string | number>) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    svg.appendChild(e);
    return e;
  };
  el('path', { d: arc(GAUGE_MIN, GAUGE_MAX), class: 'g-track', 'stroke-width': 22, fill: 'none' });
  for (const b of BANDS) el('path', { d: arc(b.from, b.to), stroke: b.colour, 'stroke-width': 22, fill: 'none', opacity: 0.22 });
  const level = el('path', { d: arc(GAUGE_MIN, GAUGE_MIN + 0.01), class: 'g-level', 'stroke-width': 22, fill: 'none', 'stroke-linecap': 'butt' });
  for (let db = GAUGE_MIN; db <= GAUGE_MAX; db += 10) {
    const [x0, y0] = pt(db, R - 17);
    const [x1, y1] = pt(db, R - 25);
    el('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: 'g-tick' });
    const [tx, ty] = pt(db, R - 38);
    const t = el('text', { x: tx, y: ty + 4, class: 'g-label', 'text-anchor': 'middle' });
    t.textContent = String(db);
  }
  // The legal limit for a cracker, 125 dB(AI) at 4 m.
  const [lx0, ly0] = pt(125, R + 14);
  const [lx1, ly1] = pt(125, R - 13);
  el('line', { x1: lx0, y1: ly0, x2: lx1, y2: ly1, class: 'g-limit' });
  const [ltx, lty] = pt(125, R + 18);
  const lt = el('text', { x: ltx + 4, y: lty - 2, class: 'g-limit-label', 'text-anchor': 'start' });
  lt.textContent = 'limit';
  const max = el('line', { class: 'g-max', x1: 0, y1: 0, x2: 0, y2: 0 });

  return (db, peak) => {
    if (db === null) {
      level.setAttribute('d', arc(GAUGE_MIN, GAUGE_MIN + 0.01));
      max.setAttribute('opacity', '0');
      return;
    }
    level.setAttribute('d', arc(GAUGE_MIN, Math.max(GAUGE_MIN + 0.01, db)));
    level.setAttribute('stroke', bandFor(db).colour);
    if (peak !== null && peak > GAUGE_MIN) {
      const [a, b] = pt(peak, R + 13);
      const [c, d] = pt(peak, R - 13);
      max.setAttribute('x1', a.toFixed(1));
      max.setAttribute('y1', b.toFixed(1));
      max.setAttribute('x2', c.toFixed(1));
      max.setAttribute('y2', d.toFixed(1));
      max.setAttribute('opacity', '1');
    }
  };
}

function fit(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return canvas.getContext('2d')!;
}

/** Level over the last 90 s: one value per 100 ms, oldest first; onsets in seconds before now. */
export function drawTrace(canvas: HTMLCanvasElement, trace: readonly number[], onsetsAgo: readonly number[], seconds: number): void {
  const ctx = fit(canvas);
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  const y = (db: number) => h - ((Math.min(GAUGE_MAX, Math.max(GAUGE_MIN, db)) - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)) * h;
  // Grid lines every 20 dB, and the 85 dB line.
  ctx.lineWidth = 1;
  for (let db = 40; db < GAUGE_MAX; db += 20) {
    ctx.strokeStyle = 'rgba(255, 240, 220, 0.08)';
    ctx.beginPath();
    ctx.moveTo(0, y(db));
    ctx.lineTo(w, y(db));
    ctx.stroke();
  }
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(242, 140, 40, 0.5)';
  ctx.beginPath();
  ctx.moveTo(0, y(85));
  ctx.lineTo(w, y(85));
  ctx.stroke();
  ctx.setLineDash([]);
  // Bangs.
  ctx.fillStyle = 'rgba(255, 210, 90, 0.9)';
  for (const ago of onsetsAgo) {
    const x = w - (ago / seconds) * w;
    ctx.fillRect(x - 1, 0, 2, h * 0.12);
  }
  if (trace.length < 2) return;
  const n = (seconds * 10) | 0;
  const x = (i: number) => w - ((trace.length - 1 - i) / n) * w;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(232, 70, 58, 0.55)');
  grad.addColorStop(0.5, 'rgba(242, 194, 48, 0.35)');
  grad.addColorStop(1, 'rgba(63, 182, 139, 0.15)');
  ctx.beginPath();
  ctx.moveTo(x(0), h);
  trace.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(trace.length - 1), h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  trace.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = '#ffd27a';
  ctx.lineWidth = Math.max(1.5, w / 400);
  ctx.stroke();
}

/** Inferno-like colour map: black, purple, red, orange, yellow, white. */
const STOPS: [number, [number, number, number]][] = [
  [0, [8, 6, 18]],
  [0.25, [72, 18, 92]],
  [0.5, [178, 40, 72]],
  [0.7, [238, 104, 32]],
  [0.88, [252, 196, 60]],
  [1, [255, 252, 228]],
];
const LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let k = 0;
    while (k < STOPS.length - 2 && v > STOPS[k + 1]![0]) k++;
    const [a, ca] = STOPS[k]!;
    const [b, cb] = STOPS[k + 1]!;
    const u = (v - a) / (b - a);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = ca[c]! + (cb[c]! - ca[c]!) * u;
  }
  return lut;
})();

/**
 * A scrolling spectrogram: each call adds one column on the right, with frequency
 * on a log scale from 60 Hz to 12 kHz. Crackers show as bright vertical streaks;
 * a rocket's whistle as a rising line.
 */
export class Spectrogram {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly bins: Float32Array<ArrayBuffer>;
  private rowBin: Int32Array = new Int32Array(0);

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly analyser: AnalyserNode,
  ) {
    this.ctx = canvas.getContext('2d', { willReadFrequently: false })!;
    this.bins = new Float32Array(analyser.frequencyBinCount);
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h && this.rowBin.length === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.fillStyle = 'rgb(8, 6, 18)';
    this.ctx.fillRect(0, 0, w, h);
    const nyq = this.analyser.context.sampleRate / 2;
    const lo = Math.log(60);
    const hi = Math.log(Math.min(12000, nyq));
    this.rowBin = new Int32Array(h);
    for (let y = 0; y < h; y++) {
      const f = Math.exp(hi - ((y + 0.5) / h) * (hi - lo));
      this.rowBin[y] = Math.min(this.bins.length - 1, Math.round((f / nyq) * this.bins.length));
    }
  }

  /** Add `cols` columns (call once per animation frame). */
  step(cols = 2): void {
    this.resize();
    const { width: w, height: h } = this.canvas;
    this.analyser.getFloatFrequencyData(this.bins);
    this.ctx.drawImage(this.canvas, -cols, 0);
    const img = this.ctx.createImageData(cols, h);
    for (let y = 0; y < h; y++) {
      const db = this.bins[this.rowBin[y]!]!;
      // -100 dBFS (near silence) to -30 dBFS (very loud) across the colour map.
      const v = Math.max(0, Math.min(255, ((db + 100) / 70) * 255)) | 0;
      for (let c = 0; c < cols; c++) {
        const o = (y * cols + c) * 4;
        img.data[o] = LUT[v * 3]!;
        img.data[o + 1] = LUT[v * 3 + 1]!;
        img.data[o + 2] = LUT[v * 3 + 2]!;
        img.data[o + 3] = 255;
      }
    }
    this.ctx.putImageData(img, w - cols, 0);
  }
}

/**
 * The night in bars: crackers per bin, coloured by the loudest moment in it, with
 * the 8-10 pm window shaded and the hours marked.
 */
export function drawNight(canvas: HTMLCanvasElement, bins: readonly { start: number; crackers: number; loudest: number | null }[], offset: number): void {
  const ctx = fit(canvas);
  const { width: w, height: h } = canvas;
  const dpr = w / Math.max(1, canvas.clientWidth);
  ctx.clearRect(0, 0, w, h);
  if (!bins.length) return;
  const axis = 18 * dpr;
  const top = 14 * dpr;
  const plotH = h - axis - top;
  const bw = w / bins.length;
  const max = Math.max(5, ...bins.map((b) => b.crackers));

  // The 8-10 pm window.
  ctx.fillStyle = 'rgba(143, 180, 255, 0.12)';
  bins.forEach((b, i) => {
    const hr = new Date(b.start).getHours();
    if (hr >= 20 && hr < 22) ctx.fillRect(i * bw, top, bw, plotH);
  });

  bins.forEach((b, i) => {
    if (!b.crackers) return;
    const bh = Math.max(2 * dpr, (b.crackers / max) * plotH);
    ctx.fillStyle = b.loudest === null ? '#9a8f88' : bandFor(b.loudest + offset).colour;
    const x = i * bw + bw * 0.15;
    ctx.beginPath();
    ctx.roundRect(x, top + plotH - bh, bw * 0.7, bh, Math.min(4 * dpr, bw * 0.2));
    ctx.fill();
  });

  // Hour labels and the busiest bin's count.
  ctx.fillStyle = 'rgba(246, 239, 228, 0.6)';
  ctx.font = `600 ${11 * dpr}px Manrope Variable, system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  bins.forEach((b, i) => {
    const d = new Date(b.start);
    if (d.getMinutes() === 0 || (i === 0 && bins.length < 7)) {
      ctx.textAlign = i === 0 ? 'left' : 'center';
      ctx.fillText(d.toLocaleTimeString([], { hour: 'numeric', minute: bins.length < 7 ? '2-digit' : undefined }), i * bw + (i === 0 ? 2 * dpr : 0), h - 4 * dpr);
    }
  });
  const busiest = bins.reduce((m, b, i) => (b.crackers > bins[m]!.crackers ? i : m), 0);
  const top1 = bins[busiest]!;
  if (top1.crackers) {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f6efe4';
    const bh = (top1.crackers / max) * plotH;
    ctx.fillText(String(top1.crackers), Math.min(w - 12 * dpr, Math.max(12 * dpr, busiest * bw + bw / 2)), Math.max(11 * dpr, top + plotH - bh - 4 * dpr));
  }
}
