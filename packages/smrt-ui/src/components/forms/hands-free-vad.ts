/**
 * Hands-free microphone capture on `@happyvertical/speech/browser`.
 *
 * `createHandsFreeCapture` opens the microphone and runs it through the
 * speech package's on-device voice activity detector (`createVadCapture`):
 * an adaptive noise floor, a pause that ends each utterance, a pre-roll so
 * the first syllable is not clipped, and a length cap that splits long
 * speech. Each utterance arrives as 16 kHz mono PCM. The audio stays in
 * memory; `stop()` / `cancel()` release the microphone.
 *
 * This is the one module in smrt-ui that imports the optional peer
 * `@happyvertical/speech`, so it has its own entry
 * (`@happyvertical/smrt-ui/forms/hands-free`) and only apps that import it
 * bundle the peer:
 *
 * ```ts
 * import { createHandsFreeCapture } from '@happyvertical/smrt-ui/forms/hands-free';
 * new Dictation({ source, mode: 'hands-free', handsFreeCapture: createHandsFreeCapture, onText });
 * ```
 */
import * as speechBrowser from '@happyvertical/speech/browser';
import { DictationError } from './audio-capture.js';
import type {
  HandsFreeCapture,
  HandsFreeCaptureFactory,
  HandsFreeCaptureOptions,
} from './hands-free-capture.js';

export type {
  HandsFreeCapture,
  HandsFreeCaptureFactory,
  HandsFreeCaptureOptions,
  HandsFreeUtterance,
  HandsFreeVadOptions,
} from './hands-free-capture.js';

/** The part of `createVadCapture` this module uses (speech >= 0.102.4). */
interface VadCaptureLike {
  on(type: 'speechstart', listener: () => void): () => void;
  on(
    type: 'speechend',
    listener: (event: {
      samples: Float32Array;
      sampleRate: number;
      durationMs: number;
      reason: 'silence' | 'max' | 'flush';
    }) => void,
  ): () => void;
  on(type: 'level', listener: (event: { level: number }) => void): () => void;
  stop(): Promise<void>;
  cancel(): void;
  suspend?(): void;
  resume?(): void;
}

interface VadModule {
  createVadCapture?: (
    options: Record<string, unknown>,
  ) => Promise<VadCaptureLike>;
}

/** Hands-free capture on the speech package's `createVadCapture`. */
export const createHandsFreeCapture: HandsFreeCaptureFactory = (
  options: HandsFreeCaptureOptions,
): HandsFreeCapture => {
  let vad: VadCaptureLike | null = null;
  let cancelled = false;
  let stopped = false;
  // Wanted before the microphone finished opening.
  let suspendWanted = false;

  return {
    async start() {
      const create = (speechBrowser as VadModule).createVadCapture;
      if (typeof create !== 'function') {
        throw new DictationError(
          'unsupported',
          'Hands-free dictation needs @happyvertical/speech 0.102.4 or newer.',
        );
      }
      const opened = await create({
        ...options.vad,
        ...(options.constraints ? { constraints: options.constraints } : {}),
      });
      if (cancelled || stopped) {
        opened.cancel();
        return;
      }
      vad = opened;
      if (suspendWanted) opened.suspend?.();
      opened.on('speechstart', () => options.onSpeaking?.(true));
      opened.on('level', ({ level }) => options.onLevel?.(level));
      opened.on('speechend', (event) => {
        options.onSpeaking?.(false);
        options.onUtterance({
          pcm: event.samples,
          sampleRate: event.sampleRate,
          durationMs: event.durationMs,
          reason: event.reason,
        });
      });
    },

    suspend() {
      suspendWanted = true;
      vad?.suspend?.();
      // A discarded utterance never ends with a `speechend`.
      options.onSpeaking?.(false);
    },

    resume() {
      suspendWanted = false;
      vad?.resume?.();
    },

    stop() {
      stopped = true;
      const current = vad;
      vad = null;
      // `stop()` delivers the utterance in progress synchronously, then
      // releases the microphone.
      void current?.stop().catch((error: unknown) => {
        options.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    },

    cancel() {
      cancelled = true;
      vad?.cancel();
      vad = null;
    },
  };
};
