/**
 * BrowserSpeechSTTAdapter errors: every Web Speech error reaches `onError`
 * with its code (`speechError`), including an `aborted` the adapter did not
 * cause, and through smrt-ui's `Dictation` Brave's "starts, then `network`"
 * becomes a plain error instead of a silent stop.
 */
import { Dictation } from '@happyvertical/smrt-ui/forms';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BrowserSpeechError,
  BrowserSpeechSTTAdapter,
} from './browser-speech.js';
import { createSttDictationSource } from './dictation-source.js';

class FakeRecognition {
  static last: FakeRecognition | null = null;
  /** What the browser does after start(): Brave errors with `network`. */
  static afterStart: ((r: FakeRecognition) => void) | null = null;
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: unknown = null;
  onerror: ((event: { error: string; message: string }) => void) | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognition.last = this;
  }
  start = vi.fn(() => {
    this.onstart?.();
    FakeRecognition.afterStart?.(this);
  });
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn(() => {
    this.onerror?.({ error: 'aborted', message: '' });
    this.onend?.();
  });
  fail(code: string) {
    this.onerror?.({ error: code, message: '' });
    this.onend?.();
  }
}

function install() {
  (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition =
    FakeRecognition;
}

afterEach(() => {
  delete (window as { webkitSpeechRecognition?: unknown })
    .webkitSpeechRecognition;
  FakeRecognition.last = null;
  FakeRecognition.afterStart = null;
});

describe('BrowserSpeechSTTAdapter errors', () => {
  it.each([
    'network',
    'not-allowed',
    'service-not-allowed',
    'no-speech',
    'audio-capture',
    'aborted',
    'language-not-supported',
  ])('reports %s with its code', async (code) => {
    install();
    const adapter = new BrowserSpeechSTTAdapter();
    const errors: BrowserSpeechError[] = [];
    adapter.onError((error) => errors.push(error));
    await adapter.start({ continuous: true });
    FakeRecognition.last?.fail(code);
    expect(errors).toHaveLength(1);
    expect(errors[0].speechError).toBe(code);
  });

  it('does not report the abort it caused itself', async () => {
    install();
    const adapter = new BrowserSpeechSTTAdapter();
    const onError = vi.fn();
    adapter.onError(onError);
    await adapter.start();
    adapter.abort();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('Dictation over the browser adapter', () => {
  it("Brave: it beeps, then 'network' — shown as unavailable, not a silent stop", async () => {
    install();
    FakeRecognition.afterStart = (r) => queueMicrotask(() => r.fail('network'));
    const log = vi.fn();
    const beep = vi.fn(async () => true);
    const dictation = new Dictation({
      source: createSttDictationSource(),
      onText: () => {},
      beep,
      log,
      requestMicrophone: false,
    });
    await dictation.start();
    await vi.waitFor(() => expect(dictation.state).toBe('error'));
    expect(beep).toHaveBeenCalled();
    expect(dictation.errorKind).toBe('unsupported');
    expect(dictation.errorCode).toBe('network');
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unsupported', code: 'network' }),
    );
  });

  it('an end straight after starting with no error is a failure too', async () => {
    install();
    FakeRecognition.afterStart = (r) => queueMicrotask(() => r.onend?.());
    const dictation = new Dictation({
      source: createSttDictationSource(),
      onText: () => {},
      beep: false,
      log: () => {},
      requestMicrophone: false,
    });
    await dictation.start();
    await vi.waitFor(() => expect(dictation.state).toBe('error'));
    expect(dictation.errorKind).toBe('interrupted');
  });
});
