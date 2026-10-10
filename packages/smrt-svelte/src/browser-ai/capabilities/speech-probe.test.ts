import { describe, expect, it } from 'vitest';
import { probeBrowserSpeech } from './speech-probe.js';

describe('probeBrowserSpeech', () => {
  it('is missing without SpeechRecognition (Firefox)', async () => {
    await expect(
      probeBrowserSpeech({ window: {}, navigator: { userAgent: 'Firefox' } }),
    ).resolves.toBe('missing');
  });

  it('is unreliable in Brave, which has the API but no speech service', async () => {
    await expect(
      probeBrowserSpeech({
        window: { webkitSpeechRecognition: class {} },
        navigator: { brave: { isBrave: async () => true } },
      }),
    ).resolves.toBe('unreliable');
  });

  it('is unreliable in Electron, which ships no vendor speech key', async () => {
    await expect(
      probeBrowserSpeech({
        window: { SpeechRecognition: class {} },
        navigator: { userAgent: 'Mozilla/5.0 Electron/30.0.0 Chrome/124' },
      }),
    ).resolves.toBe('unreliable');
  });

  it('works in Chrome-family browsers with the API', async () => {
    await expect(
      probeBrowserSpeech({
        window: { webkitSpeechRecognition: class {} },
        navigator: { userAgent: 'Mozilla/5.0 Chrome/124 Safari/537.36' },
      }),
    ).resolves.toBe('works');
  });

  it('reads the real globals by default (jsdom has no SpeechRecognition)', async () => {
    await expect(probeBrowserSpeech()).resolves.toBe('missing');
  });
});
