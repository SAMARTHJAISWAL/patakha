/// <reference lib="webworker" />
/**
 * Runs on the audio thread: A-weights the microphone signal and sends 10 ms
 * blocks (mean square, peak, overload) to the page, a few at a time.
 */
import type { Block } from '../dsp/meter';
import { Blocker } from './blocks';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

class LevelProcessor extends AudioWorkletProcessor {
  private pending: Block[] = [];
  private readonly blocker = new Blocker(sampleRate, (b) => {
    this.pending.push(b);
    if (this.pending.length >= 4) {
      this.port.postMessage(this.pending);
      this.pending = [];
    }
  });

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (ch) this.blocker.push(ch);
    return true;
  }
}

registerProcessor('patakha-level', LevelProcessor);
