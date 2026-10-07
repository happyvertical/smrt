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
  #expiry: ReturnType<typeof setTimeout> | null = null;
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
    this.lines = [
      ...this.lines,
      {
        id: `${this.#speaker}-${++this.#lineSequence}`,
        text,
        speaker: this.#speaker,
        createdAt: this.#now(),
      },
    ].slice(-this.#maxLines);
    if (this.#options.ttlMs !== undefined) this.#scheduleExpiry();
  }
  clear() {
    this.interim = '';
    this.lines = [];
    if (this.#expiry) clearTimeout(this.#expiry);
    this.#expiry = null;
  }
  dispose() {
    this.clear();
  }
  #scheduleExpiry() {
    if (this.#expiry) clearTimeout(this.#expiry);
    this.#expiry = setTimeout(
      () => this.clear(),
      Math.max(0, this.#options.ttlMs ?? 0),
    );
  }
}

/*
  const maxLines = Math.max(1, Math.floor(options.maxLines ?? 3));
  const now = options.now ?? Date.now;
  let lineSequence = 0;
  let expiry: ReturnType<typeof setTimeout> | null = null;

  const channel = {
    lines: $state<CaptionLine[]>([]),
    interim: $state(''),
    setInterim(value: string) {
      channel.interim = captionText(value);
    },
    addFinal(value: string) {
      const text = captionText(value);
      channel.interim = '';
      if (!text) return;
      channel.lines = [
        ...channel.lines,
        { id: `${speaker}-${++lineSequence}`, text, speaker, createdAt: now() },
      ].slice(-maxLines);
      if (options.ttlMs !== undefined) scheduleExpiry();
    },
    clear() {
      channel.interim = '';
      channel.lines = [];
      if (expiry) clearTimeout(expiry);
      expiry = null;
    },
    dispose() {
      channel.clear();
    },
  } satisfies CaptionChannel;

  function scheduleExpiry() {
    if (expiry) clearTimeout(expiry);
    const ttl = Math.max(0, options.ttlMs ?? 0);
    expiry = setTimeout(() => {
      channel.clear();
    }, ttl);
  }

  return channel;
}*/

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
  let current: { generation: number; text: string; started: boolean } | null =
    null;

  const remove = [
    adapter.onStart(() => {
      if (!current) return;
      current.started = true;
    }),
    adapter.onBoundary((charIndex, charLength) => {
      if (!current?.started) return;
      captions.setInterim(current.text.slice(0, charIndex + charLength));
    }),
    adapter.onEnd(() => {
      // An adapter has no utterance id. Requiring a start prevents the end
      // callback from a cancelled predecessor becoming a caption for the next
      // pending utterance.
      if (!current?.started) return;
      captions.addFinal(current.text);
      current = null;
    }),
    adapter.onError(() => {
      captions.setInterim('');
      current = null;
    }),
  ];

  return {
    async speak(text: string, options?: unknown) {
      const normalized = captionText(text);
      if (!normalized) return;
      const next = ++generation;
      current = { generation: next, text: normalized, started: false };
      try {
        await adapter.speak(normalized, options);
      } catch (error) {
        if (current?.generation === next) {
          captions.setInterim('');
          current = null;
        }
        throw error;
      }
    },
    stop() {
      generation++;
      current = null;
      captions.setInterim('');
      adapter.stop();
    },
    dispose() {
      generation++;
      current = null;
      captions.dispose();
      for (const unsubscribe of remove) unsubscribe();
    },
  };
}
