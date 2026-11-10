import { describe, expect, it } from 'vitest';
import { HEAR_ICON, SPEAK_ICON, THINK_ICON } from '../src/lib/ai/icons.ts';
import { deriveCapabilities } from '../src/lib/ai/status.ts';

describe('capability icons', () => {
  it('has a distinct path and an accessible name per capability', () => {
    expect(new Set([THINK_ICON, HEAR_ICON, SPEAK_ICON]).size).toBe(3);
    const names = deriveCapabilities({
      think: {
        status: 'ready',
        model: 'Qwen3 1.7B',
        progress: 1,
        downloaded: true,
      },
      hear: { status: 'browser', mic: true },
      speak: { supported: true, readAloud: false },
    }).map((c) => c.label);
    expect(names[0]).toBe('Think: Qwen3 1.7B ready');
    expect(
      names.every((n, i) => n.startsWith(['Think', 'Hear', 'Speak'][i] ?? '')),
    ).toBe(true);
  });
});
