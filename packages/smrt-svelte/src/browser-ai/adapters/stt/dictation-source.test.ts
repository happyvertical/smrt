/**
 * createSttDictationSource: the browser speech adapter, created once and
 * lazily, and rejected plainly where the browser has no speech recognition.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSttDictationSource } from './dictation-source.js';

class FakeRecognition {
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: unknown = null;
  onerror: unknown = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();
}

describe('createSttDictationSource', () => {
  afterEach(() => {
    delete (window as { SpeechRecognition?: unknown }).SpeechRecognition;
    delete (window as { webkitSpeechRecognition?: unknown })
      .webkitSpeechRecognition;
  });

  it('creates one browser speech adapter, on first use', async () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition =
      FakeRecognition;
    const provide = createSttDictationSource();
    const first = await provide();
    const second = await provide();
    expect(first).toBe(second);
    expect(first.type).toBe('browser-speech');
    const onStart = vi.fn();
    first.onStart(onStart);
    await first.start({
      language: 'en-CA',
      continuous: true,
      interimResults: true,
    });
    expect(onStart).toHaveBeenCalled();
  });

  it('rejects with CapabilityNotAvailableError without speech recognition, then can retry', async () => {
    const provide = createSttDictationSource();
    await expect(provide()).rejects.toMatchObject({
      name: 'CapabilityNotAvailableError',
    });
    (window as { SpeechRecognition?: unknown }).SpeechRecognition =
      FakeRecognition;
    await expect(provide()).resolves.toBeTruthy();
  });
});
