import { AudioEngine, MicError, type Source } from '../audio/engine';
import { DEFAULT_OFFSET } from '../dsp/meter';
import { Session, outsideCrackerHours, parseSaved, type LoggedBurst } from '../session';
import { bandFor, buildGauge, drawTrace, Spectrogram } from './charts';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const KEY = 'patakha:night';
const OFFSET_KEY = 'patakha:offset';

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode or full: the meter still works, it just forgets on reload */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

const KIND_LABEL = { bang: 'Bang', ladi: 'Ladi', long: 'Rocket or anaar' } as const;

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const minutes = (s: number) => (s < 60 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

/** ISO 8601 in local time with its UTC offset, e.g. 2026-11-08T21:14:03+05:30. */
function localIso(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

/** A night is one evening: a count left over from an earlier day starts afresh. */
function sameNight(a: number, b: number): boolean {
  // Shift by 6 hours so that 1 am still belongs to the night before.
  const day = (t: number) => new Date(t - 6 * 3600_000).toDateString();
  return day(a) === day(b);
}

export class App {
  /** Tonight's real measurement: saved, and survives reloads. */
  night: Session;
  /** The demo night: never saved, so it can never mix with a real count. */
  private demoSession: Session | null = null;
  /** The session on screen (and receiving audio while listening). */
  session: Session;
  private starting = false;
  private offset = DEFAULT_OFFSET;
  private wakePending: Promise<void> | null = null;
  private engine: AudioEngine | null = null;
  private source: Source | null = null;
  private readonly gauge: (db: number | null, max: number | null) => void;
  private spectrogram: Spectrogram | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private saveTimer = 0;
  private lastText = 0;
  private soundOn = false;

  constructor() {
    const saved = parseSaved(store.get(KEY));
    this.night = new Session(saved && sameNight(saved.started, Date.now()) ? saved : null);
    this.session = this.night;
    const offset = Number(store.get(OFFSET_KEY));
    this.offset = store.get(OFFSET_KEY) !== null && Number.isFinite(offset) && offset >= 90 && offset <= 150 ? offset : DEFAULT_OFFSET;
    this.night.offset = this.offset;
    this.wireSession();

    this.gauge = buildGauge($('gauge') as unknown as SVGSVGElement);
    this.buildScale();
    this.bind();
    this.renderStats();
    this.renderLog();
    this.syncOffset();
    requestAnimationFrame(() => this.frame());
    setInterval(() => {
      if (this.source) this.save();
    }, 10_000);
    window.addEventListener('pagehide', () => this.save());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.source) void this.keepAwake();
    });
  }

  private wireSession(): void {
    const s = this.session;
    s.onOnset = () => this.flash();
    s.onBurst = (b) => {
      this.addLogRow(b, true);
      this.renderStats();
      if (!s.demo) this.scheduleSave();
    };
  }

  /** Put a session on screen. */
  private show(s: Session): void {
    if (this.session === s) return;
    this.session = s;
    this.wireSession();
    this.renderStats();
    this.renderLog();
  }

  // ---- Listening -------------------------------------------------------------

  async listen(kind: Source): Promise<void> {
    // One start at a time: overlapping starts would wire two audio streams into one count.
    if (this.starting) return;
    this.starting = true;
    this.hideError();
    if (this.source) this.stop();
    this.syncButtons();
    try {
      this.engine ??= await AudioEngine.create();
      this.engine.onEnded = () => {
        this.stop();
        this.showError('The microphone stopped. Press Start listening to carry on.');
      };
      if (kind === 'demo') {
        this.demoSession = new Session(null, true);
        this.demoSession.offset = this.offset;
      }
      const target = kind === 'demo' ? this.demoSession! : this.night;
      this.engine.onBlocks = (blocks) => target.push(blocks);
      await this.engine.start(kind);
      this.engine.setDemoSound(kind === 'demo' && this.soundOn);
      this.spectrogram ??= new Spectrogram($<HTMLCanvasElement>('spectrogram'), this.engine.analyser);
      this.show(target);
      this.source = kind;
      target.resume();
      void this.keepAwake();
    } catch (e) {
      this.stop();
      if (e instanceof MicError) {
        const tip = e.reason === 'denied' ? ' Allow the microphone in your browser settings, or try the demo night.' : e.reason === 'missing' ? ' Try the demo night instead.' : '';
        this.showError(e.message + tip);
      } else {
        this.showError(`Audio could not start: ${(e as Error).message}`);
      }
    } finally {
      this.starting = false;
      this.syncButtons();
    }
  }

  stop(): void {
    this.engine?.stop();
    this.session.flush();
    const wasDemo = this.source === 'demo';
    this.source = null;
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.save();
    // After the demo, show the real night's numbers again.
    if (wasDemo) this.show(this.night);
    this.syncButtons();
  }

  /** Keep the screen on while measuring, where the browser allows it. */
  private keepAwake(): Promise<void> {
    if (!('wakeLock' in navigator) || this.wakeLock) return Promise.resolve();
    this.wakePending ??= navigator.wakeLock
      .request('screen')
      .then((lock) => {
        // Stopped while the request was pending: let go at once.
        if (!this.source) return void lock.release().catch(() => {});
        this.wakeLock = lock;
        lock.addEventListener('release', () => (this.wakeLock = null));
      })
      .catch(() => {
        /* not allowed (battery saver, unsupported): fine */
      })
      .finally(() => (this.wakePending = null));
    return this.wakePending;
  }

  // ---- Rendering ---------------------------------------------------------------

  private frame(): void {
    requestAnimationFrame(() => this.frame());
    const s = this.session;
    const listening = this.source !== null;
    if (listening) {
      const db = s.meter.fast;
      this.gauge(db, Number.isFinite(s.meter.maxFast) ? s.meter.maxFast : null);
      $('level').textContent = String(Math.round(db));
      const band = bandFor(db);
      $('state').textContent = band.label;
      document.documentElement.style.setProperty('--level-colour', band.colour);
      const now = performance.now();
      if (now - this.lastText > 1000) {
        this.lastText = now;
        $('level-text').textContent = `${Math.round(db)} decibels, ${band.label.toLowerCase()}`;
        this.renderStats();
      }
      this.spectrogram?.step(1);
    }
    drawTrace(
      $<HTMLCanvasElement>('trace'),
      s.trace,
      s.onsets.map((t) => s.clock - t),
      90,
    );
  }

  private flash(): void {
    const f = $('flash');
    f.classList.remove('on');
    void f.offsetWidth; // restart the animation
    f.classList.add('on');
  }

  private renderStats(): void {
    const s = this.session;
    const t = s.totals;
    $('s-crackers').textContent = t.crackers.toLocaleString();
    $('s-ladis').textContent = t.ladis.toLocaleString();
    $('s-long').textContent = t.long.toLocaleString();
    $('s-outside').textContent = t.outsideHours.toLocaleString();
    const max = s.meter.maxFast;
    $('s-max').textContent = Number.isFinite(max) && max > 0 ? `${Math.round(max)} dB(A)` : '--';
    $('s-max-at').textContent = Number.isFinite(max) && s.maxFastAt ? `at ${new Date(s.maxFastAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
    $('s-leq').textContent = s.duration > 1 ? `${Math.round(s.leq)} dB(A)` : '--';
    $('demo-badge').hidden = !s.demo;
    $('stats-title').textContent = s.demo ? 'Demo night' : 'Tonight so far';
    $('s-85').textContent = minutes(s.above(85));
    $('since').textContent = s.duration > 1 ? `${minutes(s.duration)} measured` : '';
  }

  private renderLog(): void {
    $('bursts').replaceChildren();
    for (const b of this.session.bursts.slice(-200)) this.addLogRow(b, false);
  }

  private addLogRow(b: LoggedBurst, fresh: boolean): void {
    const list = $('bursts');
    const li = document.createElement('li');
    li.className = `burst ${b.kind}${fresh ? ' fresh' : ''}`;
    const db = this.session.db(b);
    li.style.setProperty('--c', bandFor(db).colour);
    const what = b.kind === 'ladi' ? `Ladi · ${b.count} bangs` : KIND_LABEL[b.kind];
    const louder = b.clipped ? '+' : '';
    li.innerHTML = `<span class="b-icon" aria-hidden="true"></span><span class="b-what"></span><span class="b-time"></span><span class="b-db"></span>`;
    li.querySelector('.b-what')!.textContent = what;
    li.querySelector('.b-time')!.textContent = time(b.at) + (outsideCrackerHours(b.at) ? ' · outside 8–10 pm' : '');
    li.querySelector('.b-db')!.textContent = `${db}${louder} dB`;
    if (b.clipped) li.title = 'The microphone overloaded, so this was louder than shown.';
    list.prepend(li);
    while (list.children.length > 200) list.lastElementChild!.remove();
    $('empty').hidden = list.children.length > 0;
  }

  private buildScale(): void {
    const items: [number, string][] = [
      [30, 'A quiet bedroom at night'],
      [60, 'Normal conversation'],
      [85, 'Heavy traffic. Hours of this a day damage hearing'],
      [100, 'Harmful after about 15 minutes'],
      [120, 'Painful; harm can happen almost at once'],
      [125, 'The legal limit for a cracker, in dB(AI) at 4 m'],
    ];
    const ul = $('scale');
    for (const [db, text] of items) {
      const li = document.createElement('li');
      li.style.setProperty('--c', bandFor(db).colour);
      li.innerHTML = '<span class="s-db"></span><span class="s-text"></span>';
      li.querySelector('.s-db')!.textContent = `${db} dB`;
      li.querySelector('.s-text')!.textContent = text;
      ul.appendChild(li);
    }
  }

  // ---- Controls -----------------------------------------------------------------

  private bind(): void {
    $('btn-listen').addEventListener('click', () => void this.listen('mic'));
    $('btn-demo').addEventListener('click', () => void this.listen('demo'));
    $('btn-stop').addEventListener('click', () => this.stop());
    $('btn-sound').addEventListener('click', () => {
      this.soundOn = !this.soundOn;
      this.engine?.setDemoSound(this.soundOn);
      this.syncButtons();
    });
    $('btn-csv').addEventListener('click', () => this.downloadCsv());
    const dialog = $<HTMLDialogElement>('confirm-reset');
    $('btn-reset').addEventListener('click', () => {
      // A close by Esc or the back gesture keeps the old returnValue, so clear it first.
      dialog.returnValue = '';
      dialog.showModal();
    });
    dialog.addEventListener('close', () => {
      if (dialog.returnValue === 'reset') this.reset();
    });
    const slider = $<HTMLInputElement>('offset');
    slider.addEventListener('input', () => {
      this.setOffset(Number(slider.value));
      store.set(OFFSET_KEY, slider.value);
    });
    $('btn-offset-reset').addEventListener('click', () => {
      this.setOffset(DEFAULT_OFFSET);
      store.remove(OFFSET_KEY);
    });
  }

  private setOffset(v: number): void {
    this.offset = v;
    this.night.offset = v;
    if (this.demoSession) this.demoSession.offset = v;
    this.syncOffset();
    this.renderStats();
    this.renderLog();
  }

  private syncOffset(): void {
    const v = this.offset;
    $<HTMLInputElement>('offset').value = String(v);
    $('offset-out').textContent = `${v >= DEFAULT_OFFSET ? '+' : ''}${(v - DEFAULT_OFFSET).toFixed(1)} dB`;
  }

  private syncButtons(): void {
    const on = this.source !== null;
    for (const id of ['btn-listen', 'btn-demo', 'btn-stop']) $<HTMLButtonElement>(id).disabled = this.starting;
    $('btn-listen').hidden = this.source === 'mic';
    $('btn-demo').hidden = this.source === 'demo';
    $('btn-listen').textContent = this.source === 'demo' ? 'Use the microphone' : 'Start listening';
    $('btn-demo').textContent = this.source === 'mic' ? 'Switch to the demo' : 'Play the demo night';
    $('btn-stop').hidden = !on;
    $('btn-sound').hidden = this.source !== 'demo';
    $('btn-sound').setAttribute('aria-pressed', String(this.soundOn));
    $('btn-sound').textContent = this.soundOn ? 'Sound off' : 'Sound on';
    $('hint').hidden = on && this.source === 'mic';
    document.documentElement.classList.toggle('listening', on);
    if (!on) {
      $('level').textContent = '--';
      $('state').textContent = 'Not listening';
      $('level-text').textContent = 'Not listening';
      this.gauge(null, null);
    }
  }

  private showError(text: string): void {
    const e = $('error');
    e.textContent = text;
    e.hidden = false;
  }

  private hideError(): void {
    $('error').hidden = true;
  }

  // ---- Saving -----------------------------------------------------------------------

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 1500);
  }

  private save(): void {
    store.set(KEY, JSON.stringify(this.night.save()));
  }

  private reset(): void {
    const wasListening = this.source;
    if (wasListening) this.stop();
    store.remove(KEY);
    this.night = new Session(null);
    this.night.offset = this.offset;
    this.session = this.night;
    this.wireSession();
    this.renderStats();
    this.renderLog();
    if (wasListening) void this.listen(wasListening);
  }

  private downloadCsv(): void {
    // Local times (with the offset from UTC), like the 8-10 pm rule they are checked against.
    const rows = [['local_time', 'kind', 'bangs', 'max_10ms_dBA', 'mic_overloaded', 'seconds', 'outside_8_to_10_pm']];
    for (const b of this.session.bursts) {
      rows.push([localIso(b.at), b.kind, String(b.count), String(this.session.db(b)), String(b.clipped), String(b.dur), String(outsideCrackerHours(b.at))]);
    }
    const blob = new Blob([rows.map((r) => r.join(',')).join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `patakha-${this.session.demo ? 'demo' : localIso(this.session.started).slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}
