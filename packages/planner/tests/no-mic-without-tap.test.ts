import { Dictation } from '@happyvertical/smrt-ui/forms';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_PREFS_KEY, AiState } from '../src/lib/ai/state.svelte.ts';
import {
  type LocalSpeechModel,
  VOICE_PREFS_KEY,
} from '../src/lib/assistant/voice.svelte.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

// Privacy: the microphone opens only after a tap on the composer's mic. The
// hands-free preference means "once I tap, keep listening", never "listen on
// load".

function storage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  } as unknown as Storage;
}

function stubMicrophone() {
  const getUserMedia = vi.fn(async () => {
    throw new Error('the microphone must not open without a tap');
  });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  return getUserMedia;
}

afterEach(() => vi.unstubAllGlobals());

describe('microphone access', () => {
  it('hydrating with hands-free on, cached model and ready voice never opens the microphone', async () => {
    const getUserMedia = stubMicrophone();
    const model = {
      estimateSize: () => 45_000_000,
      isCached: async () => true,
      load: vi.fn(async () => {}),
      dispose: vi.fn(),
    } as unknown as LocalSpeechModel;
    const state = new AiState({
      storage: storage({
        [AI_PREFS_KEY]: '{"handsFree":true,"sendOnPause":true}',
        [VOICE_PREFS_KEY]: '{"local":true}',
      }),
      session: { store: recipeState, recipes, webgpu: () => true },
      voice: {
        createModel: () => model,
        probe: async () => 'unreliable',
        localSource: () => async () => {
          throw new Error('unused');
        },
      },
      synth: null,
      mic: true,
    });
    state.hydrate(false);
    await vi.waitFor(() => expect(state.voice.status).toBe('ready'));
    expect(state.handsFreeActive).toBe(true);
    state.setHandsFree(false);
    state.setHandsFree(true);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('a hands-free dictation does nothing with the microphone until start() is called', async () => {
    const getUserMedia = stubMicrophone();
    const handsFreeCapture = vi.fn(() => {
      throw new Error('capture must not be created before a tap');
    });
    const source = vi.fn(async () => {
      throw new Error('source must not be resolved before a tap');
    });
    const dictation = new Dictation({
      source,
      mode: 'hands-free',
      handsFreeCapture,
      onText: () => {},
    });
    dictation.setOptions({ mode: 'hands-free', handsFreeCapture });
    // What the composer does on mount and when a reply is read aloud.
    dictation.suspend();
    dictation.resume();
    await Promise.resolve();
    expect(dictation.active).toBe(false);
    expect(source).not.toHaveBeenCalled();
    expect(handsFreeCapture).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    dictation.dispose();
  });
});
