/**
 * Record a short spoken message with `MediaRecorder`, for dictation in
 * browsers whose speech recognition is missing or broken (Firefox, Brave).
 *
 * The recording is compressed by the browser: WebM/Opus where supported
 * (Chrome, Edge, Firefox, Brave), MP4/AAC on Safari. It stops by itself at
 * `maxDurationMs` (the recording so far is kept) and fails when it grows past
 * `maxBytes`, so a forgotten microphone cannot fill memory or exceed what the
 * server accepts. The audio stays in memory; nothing is written or logged.
 */

/** MIME types tried in order; the first `MediaRecorder` supports wins. */
export const DICTATION_AUDIO_MIME_TYPES: readonly string[] = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

/** Default cap on a recording's length: 2 minutes. */
export const DICTATION_MAX_DURATION_MS = 120_000;

/** Default cap on a recording's size: 10 MB. */
export const DICTATION_MAX_BYTES = 10 * 1024 * 1024;

/** A finished recording. */
export interface DictationRecording {
  audio: Blob;
  /** The recording's MIME type, e.g. `audio/webm;codecs=opus`. */
  mimeType: string;
  /** How long it recorded, in milliseconds. */
  durationMs: number;
  /** Whether it stopped because it reached `maxDurationMs`. */
  reachedTimeLimit: boolean;
}

/** Records one message. `Dictation` creates a fresh one per message. */
export interface DictationAudioCapture {
  /** Opens the microphone and starts recording. Rejects when it cannot. */
  start(): Promise<void>;
  /** Stops recording and resolves with the audio. */
  stop(): Promise<DictationRecording>;
  /** Stops recording and throws the audio away. */
  cancel(): void;
  /**
   * Called when the recording stops by itself: `time` (reached
   * `maxDurationMs`; `stop()` still returns the audio) or `size` (grew past
   * `maxBytes`; `stop()` rejects with a `too-long` `DictationError`).
   */
  onLimit(callback: (reason: 'time' | 'size') => void): () => void;
}

export interface DictationAudioCaptureOptions {
  /** Default {@link DICTATION_MAX_DURATION_MS}. */
  maxDurationMs?: number;
  /** Default {@link DICTATION_MAX_BYTES}. */
  maxBytes?: number;
  /** MIME types to try, in order. Default {@link DICTATION_AUDIO_MIME_TYPES}. */
  mimeTypes?: readonly string[];
  /** Media constraints for `getUserMedia`. Default `{ audio: true }`. */
  constraints?: MediaStreamConstraints;
}

/** Creates a recorder for one message. */
export type DictationAudioCaptureFactory = (
  options: DictationAudioCaptureOptions,
) => DictationAudioCapture;

/** Error kinds `Dictation` understands (see `DictationErrorKind`). */
type CaptureErrorKind = 'unsupported' | 'too-long';

/**
 * An error that already knows which plain-words message it needs.
 * `classifyDictationError` reads `dictationKind` first.
 */
export class DictationError extends Error {
  readonly dictationKind: string;
  readonly code: string;

  constructor(dictationKind: string, message: string, code?: string) {
    super(message);
    this.name = 'DictationError';
    this.dictationKind = dictationKind;
    this.code = code ?? dictationKind;
  }
}

function captureError(kind: CaptureErrorKind, message: string): DictationError {
  return new DictationError(kind, message);
}

/** Whether this browser can record audio for dictation. */
export function canCaptureDictationAudio(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

/** The first MIME type `MediaRecorder` can record, or `''` (its default). */
export function pickDictationMimeType(
  candidates: readonly string[] = DICTATION_AUDIO_MIME_TYPES,
): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const supports =
    typeof MediaRecorder.isTypeSupported === 'function'
      ? (type: string) => MediaRecorder.isTypeSupported(type)
      : () => false;
  return candidates.find((type) => supports(type)) ?? '';
}

/** Records with `MediaRecorder` (see the module comment). */
export const createMediaRecorderCapture: DictationAudioCaptureFactory = (
  options = {},
) => {
  const maxDurationMs = options.maxDurationMs ?? DICTATION_MAX_DURATION_MS;
  const maxBytes = options.maxBytes ?? DICTATION_MAX_BYTES;
  const limitListeners = new Set<(reason: 'time' | 'size') => void>();
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let bytes = 0;
  let startedAt = 0;
  let endedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reachedTimeLimit = false;
  let tooBig = false;
  let cancelled = false;
  let stopped: Promise<void> | null = null;
  let resolveStopped: (() => void) | null = null;

  const emitLimit = (reason: 'time' | 'size') => {
    for (const listener of limitListeners) {
      try {
        listener(reason);
      } catch {
        // A broken listener must not keep the microphone open.
      }
    }
  };

  const release = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  };

  const halt = () => {
    endedAt ||= Date.now();
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        resolveStopped?.();
      }
    } else {
      resolveStopped?.();
    }
    release();
  };

  return {
    async start() {
      if (!canCaptureDictationAudio()) {
        throw captureError(
          'unsupported',
          'This browser cannot record audio (no MediaRecorder).',
        );
      }
      stream = await navigator.mediaDevices.getUserMedia(
        options.constraints ?? { audio: true },
      );
      if (cancelled) {
        release();
        return;
      }
      const mimeType = pickDictationMimeType(options.mimeTypes);
      try {
        recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
      } catch (error) {
        release();
        throw error;
      }
      stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
      });
      recorder.addEventListener('dataavailable', (event: BlobEvent) => {
        if (!event.data || event.data.size === 0 || cancelled) return;
        chunks.push(event.data);
        bytes += event.data.size;
        if (bytes > maxBytes && !tooBig) {
          tooBig = true;
          chunks = [];
          emitLimit('size');
          halt();
        }
      });
      recorder.addEventListener('stop', () => resolveStopped?.());
      recorder.addEventListener('error', () => halt());
      // Hand over data every second so the size cap is checked as it grows.
      recorder.start(1000);
      startedAt = Date.now();
      timer = setTimeout(() => {
        reachedTimeLimit = true;
        emitLimit('time');
        halt();
      }, maxDurationMs);
    },

    async stop() {
      if (!recorder) {
        release();
        throw captureError('unsupported', 'Recording never started.');
      }
      halt();
      await stopped;
      const type =
        recorder.mimeType || pickDictationMimeType(options.mimeTypes);
      const recording: DictationRecording = {
        audio: new Blob(chunks, type ? { type } : undefined),
        mimeType: type || 'audio/webm',
        durationMs: Math.max(0, (endedAt || Date.now()) - startedAt),
        reachedTimeLimit,
      };
      chunks = [];
      if (tooBig || recording.audio.size > maxBytes) {
        throw captureError('too-long', 'The recording is too large to send.');
      }
      return recording;
    },

    cancel() {
      cancelled = true;
      chunks = [];
      halt();
    },

    onLimit(callback) {
      limitListeners.add(callback);
      return () => limitListeners.delete(callback);
    },
  };
};
