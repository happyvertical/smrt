/**
 * Bounded, user-facing caption state for an assistant conversation (#3644).
 *
 * This module intentionally accepts only transcript and playback seams. It
 * does not consume chat messages, model tokens, tool calls, or reasoning.
 */
import type { DictationOptions } from '@happyvertical/smrt-ui/forms';

/** The playback subset of smrt-svelte's TTSAdapter; structural on purpose so
 * chat stays independent of the browser AI package. */
export interface CaptionTTSAdapter {
  speak(text: string, options?: unknown): Promise<void>;
  stop(): void;
  onStart(callback: () => void): () => void;
  onEnd(callback: () => void): () => void;
  onError(callback: (error: Error) => void): () => void;
  onBoundary(
    callback: (charIndex: number, charLength: number) => void,
  ): () => void;
}

/** One plain-text caption line. Svelte text interpolation escapes it. */
export interface CaptionLine {
  id: string;
  text: string;
  speaker: 'heard' | 'spoken';
  createdAt: number;
}

export interface CaptionChannelOptions {
  /** Maximum completed lines retained in the visible history. Default 3. */
  maxLines?: number;
  /** Remove a completed line after this duration. Omit to retain it. */
  ttlMs?: number;
  now?: () => number;
}

export interface CaptionChannel {
  readonly lines: CaptionLine[];
  readonly interim: string;
  setInterim(text: string): void;
  addFinal(text: string): void;
  clear(): void;
  dispose(): void;
}

const MAX_CAPTION_TEXT = 2_000;

function captionText(value: string): string {
  // Keep captions one visible line of ordinary text. This also prevents
  // terminal/control characters from becoming part of an accessibility name.
  return Array.from(value, (character) =>
    character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ? ' '
      : character,
  )
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CAPTION_TEXT);
}

export function createCaptionChannel(
  speaker: CaptionLine['speaker'],
  options: CaptionChannelOptions = {},
): CaptionChannel {
  return new CaptionChannelState(speaker, options);
}

class CaptionChannelState implements CaptionChannel {
  lines = $state<CaptionLine[]>([]);
  interim = $state('');
  #lineSequence = 0;
  #expiry = new Map<string, ReturnType<typeof setTimeout>>();
  #maxLines: number;
  #now: () => number;
  #speaker: CaptionLine['speaker'];
  #options: CaptionChannelOptions;

  constructor(speaker: CaptionLine['speaker'], options: CaptionChannelOptions) {
    this.#speaker = speaker;
    this.#options = options;
    this.#maxLines = Math.max(1, Math.floor(options.maxLines ?? 3));
    this.#now = options.now ?? Date.now;
  }

  setInterim(value: string) {
    this.interim = captionText(value);
  }
  addFinal(value: string) {
    const text = captionText(value);
    this.interim = '';
    if (!text) return;
    const id = `${this.#speaker}-${++this.#lineSequence}`;
    this.lines = [
      ...this.lines,
      {
        id,
        text,
        speaker: this.#speaker,
        createdAt: this.#now(),
      },
    ].slice(-this.#maxLines);
    // Eviction retires the line's deadline too, keeping timers bounded by
    // the retained history rather than by the lifetime of a conversation.
    const retained = new Set(this.lines.map((line) => line.id));
    for (const [expiredId, timer] of this.#expiry) {
      if (!retained.has(expiredId)) {
        clearTimeout(timer);
        this.#expiry.delete(expiredId);
      }
    }
    if (this.#options.ttlMs !== undefined) this.#scheduleExpiry(id);
  }
  clear() {
    this.interim = '';
    this.lines = [];
    for (const timer of this.#expiry.values()) clearTimeout(timer);
    this.#expiry.clear();
  }
  dispose() {
    this.clear();
  }
  #scheduleExpiry(id: string) {
    const timer = setTimeout(
      () => {
        // A cancelled callback may already be queued. It must not affect a
        // cleared/reused channel or any line created after that cancellation.
        if (this.#expiry.get(id) !== timer) return;
        this.#expiry.delete(id);
        this.lines = this.lines.filter((line) => line.id !== id);
      },
      Math.max(0, this.#options.ttlMs ?? 0),
    );
    this.#expiry.set(id, timer);
  }
}

/**
 * Pass these callbacks to the single host-owned Dictation instance. Doing so
 * observes the same recogniser the composer uses; it never starts or stops a
 * microphone and therefore cannot create a second recogniser.
 */
export function createHeardCaptionCallbacks(
  captions: CaptionChannel,
): Pick<DictationOptions, 'onText' | 'onInterim'> {
  return {
    onText: (text) => captions.addFinal(text),
    onInterim: (text) => captions.setInterim(text),
  };
}

/** Host-driven playback events, including SDK realtime audio transports. */
export interface SpokenCaptionCallbacks {
  /** Call only when audio starts playing, with its user-facing transcript. */
  onStart(playbackId: string, text: string): void;
  /** Character offsets refer to the original transcript supplied at start. */
  onBoundary(playbackId: string, charIndex: number, charLength: number): void;
  /** Call on completed playback, never merely on completed generation. */
  onEnd(playbackId: string): void;
  /** Cancel/error for this playback; late events are ignored. */
  onCancel(playbackId: string): void;
  dispose(): void;
}

/** Bridges existing playback signals without requiring a TTS adapter. */
export function createSpokenCaptionCallbacks(
  captions: CaptionChannel,
): SpokenCaptionCallbacks {
  let current: { id: string; text: string } | null = null;
  let disposed = false;
  return {
    onStart(id, text) {
      if (disposed) return;
      current = { id, text };
      captions.setInterim('');
    },
    onBoundary(id, index, length) {
      if (
        disposed ||
        current?.id !== id ||
        !Number.isFinite(index) ||
        !Number.isFinite(length) ||
        index < 0 ||
        length < 0
      )
        return;
      captions.setInterim(current.text.slice(0, index + length));
    },
    onEnd(id) {
      if (disposed || current?.id !== id) return;
      captions.addFinal(current.text);
      current = null;
    },
    onCancel(id) {
      if (disposed || current?.id !== id) return;
      captions.setInterim('');
      current = null;
    },
    dispose() {
      disposed = true;
      current = null;
      captions.setInterim('');
    },
  };
}

/**
 * Couples one TTS adapter invocation to captions of audio it actually plays.
 * Do not call this for model streaming text: `speak` is the playback boundary.
 */
export interface SpokenCaptionSession {
  speak(text: string, options?: unknown): Promise<void>;
  stop(): void;
  dispose(): void;
}

export function createSpokenCaptionSession(
  adapter: CaptionTTSAdapter,
  captions: CaptionChannel,
): SpokenCaptionSession {
  let generation = 0;
  let disposed = false;
  let pending: Promise<void> | null = null;
  let remove: (() => void)[] = [];

  function detach() {
    for (const unsubscribe of remove) unsubscribe();
    remove = [];
  }

  function stop() {
    generation++;
    detach();
    captions.setInterim('');
    adapter.stop();
  }

  return {
    async speak(text: string, options?: unknown) {
      if (disposed || !captionText(text)) return;
      // TTS events have no utterance id. Invalidate old listener closures,
      // cancel playback, and wait for its completion promise before attaching
      // the next utterance. A host must dedicate this adapter to this session.
      const previous = pending;
      stop();
      const current = generation;
      if (previous) await previous.catch(() => undefined);
      if (disposed || current !== generation) return;
      let started = false;
      const active = () => !disposed && current === generation;
      remove = [
        adapter.onStart(() => {
          if (active()) started = true;
        }),
        adapter.onBoundary((charIndex, charLength) => {
          if (!active() || !started) return;
          if (
            !Number.isFinite(charIndex) ||
            !Number.isFinite(charLength) ||
            charIndex < 0 ||
            charLength < 0
          )
            return;
          captions.setInterim(text.slice(0, charIndex + charLength));
        }),
        adapter.onEnd(() => {
          if (!active() || !started) return;
          captions.addFinal(text);
          generation++;
          detach();
        }),
        adapter.onError(() => {
          if (!active()) return;
          captions.setInterim('');
          generation++;
          detach();
        }),
      ];
      let playback: Promise<void> | null = null;
      try {
        // Preserve the exact playback string so boundary indices still refer
        // to what the adapter is speaking. Normalize only displayed text.
        playback = adapter.speak(text, options);
        pending = playback;
        await playback;
      } finally {
        if (pending === playback) pending = null;
        if (active()) {
          captions.setInterim('');
          generation++;
          detach();
        }
      }
    },
    stop,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      captions.dispose();
    },
  };
}
