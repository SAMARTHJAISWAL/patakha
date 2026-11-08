import { bandFor } from './charts';

export interface Summary {
  crackers: number;
  ladis: number;
  long: number;
  loudest: number | null;
  loudestAt: number | null;
  average: number | null;
  dose: number;
  bins: { start: number; crackers: number; loudest: number | null }[];
  offset: number;
  demo: boolean;
}

/**
 * A portrait card summing up the night (1080 × 1350, the shape social apps show
 * best). Drawn on a canvas so it can be shared as an image.
 */
export async function summaryCard(s: Summary): Promise<Blob> {
  await document.fonts.ready;
  const W = 1080;
  const H = 1350;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#1d1030');
  bg.addColorStop(0.55, '#0b0a14');
  bg.addColorStop(1, '#0b0a14');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  // A burst of sparks in the corner.
  ctx.save();
  ctx.translate(900, 190);
  ctx.lineCap = 'round';
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const r0 = 30 + (i % 3) * 8;
    const r1 = 110 + (i % 4) * 22;
    ctx.strokeStyle = ['#ffd27a', '#f28c28', '#e8463a', '#ffb23f'][i % 4]!;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.stroke();
  }
  ctx.restore();

  const display = (px: number) => `400 ${px}px "Rozha One", Georgia, serif`;
  const sans = (weight: number, px: number) => `${weight} ${px}px "Manrope Variable", system-ui, sans-serif`;

  ctx.fillStyle = '#f6efe4';
  ctx.font = display(64);
  ctx.fillText('patakha', 80, 140);
  const w = ctx.measureText('patakha ').width;
  ctx.fillStyle = '#ffb23f';
  ctx.font = display(56);
  ctx.fillText('पटाखा', 80 + w, 140);

  ctx.fillStyle = '#cfc4b6';
  ctx.font = sans(600, 34);
  ctx.fillText(s.demo ? 'A demo Diwali night' : `My Diwali night · ${new Date().toLocaleDateString([], { day: 'numeric', month: 'long' })}`, 80, 205);

  ctx.fillStyle = '#ffb23f';
  ctx.font = display(260);
  ctx.fillText(s.crackers.toLocaleString(), 72, 470);
  ctx.fillStyle = '#f6efe4';
  ctx.font = sans(700, 44);
  ctx.fillText(s.crackers === 1 ? 'cracker heard' : 'crackers heard', 84, 540);

  const tile = (x: number, y: number, label: string, value: string, colour = '#f6efe4') => {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.beginPath();
    ctx.roundRect(x, y, 440, 150, 24);
    ctx.fill();
    ctx.fillStyle = '#9a8f88';
    ctx.font = sans(600, 30);
    ctx.fillText(label, x + 30, y + 52);
    ctx.fillStyle = colour;
    ctx.font = sans(800, 58);
    ctx.fillText(value, x + 30, y + 120);
  };
  const loud = s.loudest === null ? '--' : `${Math.round(s.loudest)} dB(A)`;
  tile(80, 600, 'Loudest', loud, s.loudest === null ? '#f6efe4' : bandFor(s.loudest).colour);
  tile(560, 600, 'Average', s.average === null ? '--' : `${Math.round(s.average)} dB(A)`);
  tile(80, 780, 'Ladis · rockets', `${s.ladis} · ${s.long}`);
  tile(560, 780, 'Noise dose', `${Math.round(s.dose)}%`, s.dose >= 100 ? '#e8463a' : s.dose >= 50 ? '#f2c230' : '#3fb68b');

  // The night in bars.
  const bins = s.bins.slice(-36);
  const max = Math.max(5, ...bins.map((b) => b.crackers));
  const x0 = 80;
  const y0 = 1180;
  const bw = 920 / Math.max(1, bins.length);
  bins.forEach((b, i) => {
    if (!b.crackers) return;
    const bh = (b.crackers / max) * 190;
    ctx.fillStyle = b.loudest === null ? '#9a8f88' : bandFor(b.loudest + s.offset).colour;
    ctx.beginPath();
    ctx.roundRect(x0 + i * bw + bw * 0.15, y0 - bh, bw * 0.7, bh, 6);
    ctx.fill();
  });
  ctx.fillStyle = 'rgba(246, 239, 228, 0.18)';
  ctx.fillRect(x0, y0 + 4, 920, 2);
  const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  ctx.fillStyle = '#9a8f88';
  ctx.font = sans(600, 26);
  if (bins.length) {
    ctx.fillText(hm(bins[0]!.start), x0, y0 + 40);
    ctx.textAlign = 'right';
    ctx.fillText(hm(bins.at(-1)!.start + 10 * 60_000), x0 + 920, y0 + 40);
    ctx.textAlign = 'center';
    ctx.fillText('crackers per 10 minutes', x0 + 460, y0 + 40);
    ctx.textAlign = 'left';
  }

  ctx.fillStyle = '#cfc4b6';
  ctx.font = sans(600, 28);
  ctx.textAlign = 'right';
  ctx.fillText('samarthjaiswal.github.io/patakha', 1000, 1290);
  ctx.textAlign = 'left';

  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not draw the card'))), 'image/png'));
}
