/**
 * The microphone side of hands-free dictation, as an interface.
 *
 * `Dictation` in `mode: 'hands-free'` opens the microphone once and cuts it
 * into utterances on the device (voice activity detection, no audio leaves
 * the page): each pause hands over one 16 kHz mono utterance, which the speech
 * source writes down while the next is still being spoken. A
 * `HandsFreeCaptureFactory` supplies that microphone. The one that ships is
 * `createHandsFreeCapture` in `@happyvertical/smrt-ui/forms/hands-free`, built
 * on `@happyvertical/speech/browser`'s `createVadCapture`; it lives in its own
 * entry so only apps that opt in bundle the optional peer.
 */

/** Tuning for the detector. Every field is optional. */
export interface HandsFreeVadOptions {
  /** Silence that ends an utterance, in ms. Default 800. */
  silenceMs?: number;
  /** Speech shorter than this is a click or a cough, not an utterance. Default 150. */
  minSpeechMs?: number;
  /** Audio kept from before the onset so the first syllable is not clipped. Default 300. */
  preRollMs?: number;
  /** An utterance this long is cut and the next one starts at once. Default 30000. */
  maxUtteranceMs?: number;
  /**
   * 0 (needs loud, close speech) to 1 (picks up quiet speech, and more
   * noise). Default 0.5.
   */
  sensitivity?: number;
}

/** A finished utterance, ready for a speech model. */
export interface HandsFreeUtterance {
  /** Mono samples (-1 to 1) at `sampleRate` (16 kHz), pre-roll included. */
  pcm: Float32Array;
  sampleRate: number;
  durationMs: number;
  /** Why it ended: a pause, the length cap, or the person turning it off. */
  reason: 'silence' | 'max' | 'flush';
}

export interface HandsFreeCaptureOptions {
  vad?: HandsFreeVadOptions;
  onUtterance: (utterance: HandsFreeUtterance) => void;
  /** An utterance began (`true`) or ended (`false`). */
  onSpeaking?: (speaking: boolean) => void;
  /** Loudness 0 to 1, many times a second. */
  onLevel?: (level: number) => void;
  /** The microphone failed after it opened. */
  onError?: (error: Error) => void;
  /** Media constraints for `getUserMedia`. */
  constraints?: MediaStreamConstraints;
}

export interface HandsFreeCapture {
  /** Opens the microphone and starts detecting. Rejects when it cannot. */
  start(): Promise<void>;
  /** Hands over any utterance in progress, then releases the microphone. */
  stop(): void;
  /** Releases the microphone and throws the audio away. */
  cancel(): void;
  /**
   * Half-duplex gate: stop hearing (the microphone stays open) while the page
   * plays audio, so the assistant's voice is not transcribed. An utterance in
   * progress is discarded. Optional; `Dictation` also ignores utterances that
   * arrive while it is suspended.
   */
  suspend?(): void;
  /** Hear again, after a short guard that ignores the playback's tail. */
  resume?(): void;
}

export type HandsFreeCaptureFactory = (
  options: HandsFreeCaptureOptions,
) => HandsFreeCapture;

/** Whether this browser can open a microphone and tap it with Web Audio. */
export function canCaptureHandsFree(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof AudioContext !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined'
  );
}
