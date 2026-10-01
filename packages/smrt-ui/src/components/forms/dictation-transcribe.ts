/**
 * Turning a recorded message into text, for dictation's recording fallback.
 *
 * `Dictation` records audio when the browser cannot recognise speech itself
 * and hands it to a `DictationTranscribe` function. The app decides where it
 * goes: normally its own server route, which holds the speech service's key
 * (never put a provider key in the browser). `createHttpTranscriber` is that
 * function for a route that takes the raw audio as the request body and
 * answers `{ text }`.
 */
import { DictationError } from './audio-capture.js';

export interface DictationTranscribeOptions {
  /** The recording's MIME type, e.g. `audio/webm;codecs=opus`. */
  mimeType: string;
  /** BCP-47 language the person speaks, e.g. `en-US`. */
  language: string;
  /** How long the recording is, in milliseconds. */
  durationMs: number;
  /** Aborted when the person cancels or the form goes away. */
  signal: AbortSignal;
}

/**
 * Writes down a recorded message. Resolve the text (empty when nothing was
 * said); reject to show an error. Throw a `DictationError` to pick the
 * message (`too-long`, `not-transcribed`, `unavailable`, …).
 */
export type DictationTranscribe = (
  audio: Blob,
  options: DictationTranscribeOptions,
) => Promise<string | { text: string }>;

export interface HttpTranscriberOptions {
  /** `fetch` to use (default `globalThis.fetch`). */
  fetch?: typeof fetch;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

/**
 * A `DictationTranscribe` that POSTs the audio to `url` as the raw request
 * body (`Content-Type` is the recording's type) with `language` and
 * `durationMs` in the query string, and reads `{ text }` back.
 *
 * Status codes become plain-words errors: 413 → `too-long`, 503 →
 * `unavailable` (not set up), 401/403 → `forbidden`, anything else →
 * `not-transcribed`. The server's `{ error }` text is kept as the error
 * message for logs, not shown.
 */
export function createHttpTranscriber(
  url: string | URL,
  options: HttpTranscriberOptions = {},
): DictationTranscribe {
  return async (audio, { mimeType, language, durationMs, signal }) => {
    const doFetch = options.fetch ?? globalThis.fetch;
    const base =
      typeof window !== 'undefined'
        ? window.location.href
        : 'http://localhost/';
    const target = new URL(String(url), base);
    if (language) target.searchParams.set('language', language);
    if (Number.isFinite(durationMs)) {
      target.searchParams.set('durationMs', String(Math.round(durationMs)));
    }
    let response: Response;
    try {
      response = await doFetch(target.toString(), {
        method: 'POST',
        headers: { ...options.headers, 'Content-Type': mimeType },
        body: audio,
        credentials: 'same-origin',
        signal,
      });
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') throw error;
      throw new DictationError(
        'not-transcribed',
        `Could not reach the speech service: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'network',
      );
    }
    const body = (await response.json().catch(() => null)) as {
      text?: unknown;
      error?: unknown;
    } | null;
    if (!response.ok) {
      const message =
        typeof body?.error === 'string'
          ? body.error
          : `Speech service answered ${response.status}`;
      const kind =
        response.status === 413
          ? 'too-long'
          : response.status === 503
            ? 'unavailable'
            : response.status === 401 || response.status === 403
              ? 'forbidden'
              : 'not-transcribed';
      throw new DictationError(kind, message, `http-${response.status}`);
    }
    return typeof body?.text === 'string' ? body.text : '';
  };
}
