import type { Block } from '../dsp/meter';
import { demoNight } from './demo';
import workletUrl from './worklet.ts?worker&url';

export type Source = 'mic' | 'demo';

export class MicError extends Error {
  constructor(
    readonly reason: 'denied' | 'missing' | 'insecure' | 'other',
    message: string,
  ) {
    super(message);
  }
}

/**
 * The audio graph:
 *
 *   microphone or demo ─┬─▶ level worklet (A-weighting, 10 ms blocks) ─▶ page
 *                       ├─▶ analyser (spectrogram)
 *                       └─▶ speakers (demo only, if sound is on)
 *
 * The microphone is opened with echo cancellation, noise suppression and
 * automatic gain control all off: those are designed for calls, and each of
 * them would quietly distort a level reading.
 */
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;
  private readonly sink: GainNode;
  private readonly speaker: GainNode;
  private stream: MediaStream | null = null;
  private source: AudioNode | null = null;
  private node: AudioWorkletNode | null = null;
  onBlocks: ((blocks: Block[]) => void) | null = null;
  /** Called if the microphone stops on its own (unplugged, permission revoked). */
  onEnded: (() => void) | null = null;

  private constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    // The worklet must be pulled by the graph to run, so it feeds a silent sink.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(ctx.destination);
    this.speaker = ctx.createGain();
    this.speaker.gain.value = 0;
    this.speaker.connect(ctx.destination);
  }

  static async create(): Promise<AudioEngine> {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(workletUrl);
    return new AudioEngine(ctx);
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  async start(kind: Source): Promise<void> {
    this.stopSource();
    await this.ctx.resume();
    if (kind === 'mic') {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new MicError('insecure', 'The microphone is only available on a secure (https) page.');
      }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        });
      } catch (e) {
        const name = (e as DOMException).name;
        if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicError('denied', 'Microphone permission was refused.');
        if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new MicError('missing', 'No microphone was found.');
        throw new MicError('other', `The microphone could not be opened (${name}).`);
      }
      for (const track of this.stream.getAudioTracks()) track.addEventListener('ended', () => this.onEnded?.());
      this.source = this.ctx.createMediaStreamSource(this.stream);
    } else {
      const { samples } = demoNight(this.ctx.sampleRate, 60);
      const buf = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
      buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.speaker);
      src.start();
      this.source = src;
    }

    this.node = new AudioWorkletNode(this.ctx, 'patakha-level', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.node.port.onmessage = (e: MessageEvent<Block[]>) => this.onBlocks?.(e.data);
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.source.connect(this.analyser);
  }

  /** Hear the demo night (it is always analysed; this only routes it to the speakers). */
  setDemoSound(on: boolean): void {
    this.speaker.gain.setTargetAtTime(on ? 0.6 : 0, this.ctx.currentTime, 0.05);
  }

  stop(): void {
    this.stopSource();
    void this.ctx.suspend();
  }

  private stopSource(): void {
    if (this.source instanceof AudioBufferSourceNode) this.source.stop();
    this.source?.disconnect();
    this.node?.disconnect();
    if (this.node) this.node.port.onmessage = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.source = null;
    this.node = null;
    this.stream = null;
  }
}
