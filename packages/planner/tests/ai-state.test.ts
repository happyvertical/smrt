import { describe, expect, it, vi } from 'vitest';
import {
  AI_PREFS_KEY,
  AiState,
  loadAiPrefs,
  type Synth,
} from '../src/lib/ai/state.svelte.ts';
import {
  type CapabilityInput,
  deriveCapabilities,
  needsFirstRunSetup,
} from '../src/lib/ai/status.ts';
import { PREFS_KEY } from '../src/lib/assistant/prefs.ts';
import {
  type LocalSpeechModel,
  VOICE_PREFS_KEY,
} from '../src/lib/assistant/voice.svelte.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

function storage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  } as unknown as Storage;
}

const base: CapabilityInput = {
  think: {
    status: 'idle',
    model: 'Qwen3 1.7B',
    progress: 0,
    downloaded: false,
  },
  hear: { status: 'offer', mic: true },
  speak: { supported: true, readAloud: false },
};

const by = (input: CapabilityInput) =>
  Object.fromEntries(deriveCapabilities(input).map((c) => [c.id, c]));

describe('deriveCapabilities', () => {
  it('names each capability and its state for assistive tech', () => {
    const c = by({
      ...base,
      think: { ...base.think, status: 'ready' },
      hear: { status: 'browser', mic: true },
      speak: { supported: true, readAloud: true },
    });
    expect(c.think).toMatchObject({
      state: 'ready',
      label: 'Think: Qwen3 1.7B ready',
    });
    expect(c.hear?.state).toBe('ready');
    expect(c.hear?.label).toMatch(/^Hear: /);
    expect(c.speak?.state).toBe('ready');
    expect(c.speak?.label).toMatch(/^Speak: /);
  });

  it('is available, not ready, before anything is set up', () => {
    const c = by(base);
    expect(c.think).toMatchObject({
      state: 'available',
      label: 'Think: not set up',
    });
    expect(c.hear?.state).toBe('available');
    expect(c.speak?.state).toBe('available');
  });

  it('reports a downloaded but unloaded model and loading progress', () => {
    expect(
      by({ ...base, think: { ...base.think, downloaded: true } }).think?.label,
    ).toBe('Think: Qwen3 1.7B downloaded, not loaded');
    expect(
      by({
        ...base,
        think: { ...base.think, status: 'loading', progress: 0.4 },
      }).think?.label,
    ).toBe('Think: Qwen3 1.7B loading, 40%');
  });

  it('is off where the browser cannot do it', () => {
    const c = by({
      think: { ...base.think, status: 'unsupported' },
      hear: { status: 'offer', mic: false },
      speak: { supported: false, readAloud: false },
    });
    expect(c.think?.state).toBe('off');
    expect(c.hear?.state).toBe('off');
    expect(c.speak?.state).toBe('off');
  });

  it('counts a downloaded speech model as ready', () => {
    expect(
      by({ ...base, hear: { status: 'ready', mic: true } }).hear?.state,
    ).toBe('ready');
    expect(
      by({ ...base, hear: { status: 'downloading', mic: true } }).hear?.state,
    ).toBe('available');
  });
});

describe('needsFirstRunSetup', () => {
  const none = {
    thinkDownloaded: false,
    hearDownloaded: false,
    readAloud: false,
    dismissed: false,
    built: false,
  };

  it('leads with setup for a visitor who set nothing up', () => {
    expect(needsFirstRunSetup(none)).toBe(true);
  });

  it('does not once dismissed, built on, or any capability is set up', () => {
    expect(needsFirstRunSetup({ ...none, dismissed: true })).toBe(false);
    expect(needsFirstRunSetup({ ...none, built: true })).toBe(false);
    expect(needsFirstRunSetup({ ...none, thinkDownloaded: true })).toBe(false);
    expect(needsFirstRunSetup({ ...none, hearDownloaded: true })).toBe(false);
    expect(needsFirstRunSetup({ ...none, readAloud: true })).toBe(false);
  });
});

function fakeModel(): LocalSpeechModel {
  return {
    estimateSize: () => 45_000_000,
    isCached: async () => false,
    load: vi.fn(),
    dispose: vi.fn(),
  } as unknown as LocalSpeechModel;
}

function makeState(
  store: Storage,
  options: { synth?: Synth | null; probe?: 'works' | 'missing' } = {},
) {
  return new AiState({
    storage: store,
    session: { store: recipeState, recipes, webgpu: () => true },
    voice: {
      createModel: fakeModel,
      probe: async () => options.probe ?? 'missing',
      browserSource: () => () => Promise.reject(new Error('unused')),
    },
    synth: options.synth === undefined ? null : options.synth,
    mic: true,
  });
}

describe('AiState', () => {
  it('shows capabilities as not set up before hydration, then reads the browser', async () => {
    const state = makeState(storage(), { probe: 'works' });
    expect(state.capabilities.map((c) => c.state)).toEqual([
      'available',
      'available',
      'available',
    ]);
    state.hydrate(false);
    await vi.waitFor(() => expect(state.voice.status).toBe('browser'));
    expect(state.capabilities[1]?.state).toBe('ready');
  });

  it('decides the first visit once, and keeps the form while a download completes', () => {
    const store = storage();
    const state = makeState(store);
    state.hydrate(false);
    expect(state.firstRun).toBe(true);
    // A download completing mid-flow must not pull the form away.
    state.session.prefs = { ...state.session.prefs, consented: ['x'] };
    expect(state.firstRun).toBe(true);
  });

  it('skips the form on later visits: dismissed, downloaded, or built', () => {
    const dismissed = makeState(
      storage({ [AI_PREFS_KEY]: JSON.stringify({ dismissed: true }) }),
    );
    dismissed.hydrate(false);
    expect(dismissed.firstRun).toBe(false);

    const downloaded = makeState(
      storage({
        [PREFS_KEY]: JSON.stringify({
          modelId: 'Qwen3-1.7B-q4f16_1-MLC',
          consented: ['Qwen3-1.7B-q4f16_1-MLC'],
        }),
      }),
    );
    downloaded.hydrate(false);
    expect(downloaded.firstRun).toBe(false);

    const speech = makeState(
      storage({ [VOICE_PREFS_KEY]: JSON.stringify({ local: true }) }),
    );
    speech.hydrate(false);
    expect(speech.firstRun).toBe(false);

    const built = makeState(storage());
    built.hydrate(true);
    expect(built.firstRun).toBe(false);
  });

  it('remembers "I don\'t need AI" and Continue only for this visit', () => {
    const store = storage();
    const a = makeState(store);
    a.hydrate(false);
    a.continueFirstRun();
    expect(a.firstRun).toBe(false);
    const b = makeState(store);
    b.hydrate(false);
    expect(b.firstRun).toBe(true);
    b.dismissFirstRun();
    expect(b.firstRun).toBe(false);
    expect(loadAiPrefs(store).dismissed).toBe(true);
    const c = makeState(store);
    c.hydrate(false);
    expect(c.firstRun).toBe(false);
  });

  it('tolerates unavailable or corrupt storage', () => {
    expect(loadAiPrefs(null)).toEqual({
      dismissed: false,
      readAloud: false,
      handsFree: false,
      sendOnPause: false,
    });
    expect(loadAiPrefs(storage({ [AI_PREFS_KEY]: '{nope' }))).toEqual({
      dismissed: false,
      readAloud: false,
      handsFree: false,
      sendOnPause: false,
    });
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    const state = makeState(throwing);
    state.hydrate(false);
    state.dismissFirstRun();
    expect(state.prefs.dismissed).toBe(true);
  });

  it('remembers hands-free, and only acts on it once the downloaded model is on', async () => {
    const store = storage();
    const state = makeState(store);
    state.hydrate(false);
    expect(state.prefs.handsFree).toBe(false);
    state.setHandsFree(true);
    expect(loadAiPrefs(store).handsFree).toBe(true);
    // Saved, but the browser's own recogniser cannot write sentences down.
    expect(state.handsFreeActive).toBe(false);
    state.voice.status = 'ready';
    expect(state.handsFreeActive).toBe(true);
    state.setHandsFree(false);
    expect(state.handsFreeActive).toBe(false);
    expect(loadAiPrefs(store).handsFree).toBe(false);

    const later = makeState(storage({ [AI_PREFS_KEY]: '{"handsFree":true}' }));
    later.hydrate(false);
    expect(later.prefs.handsFree).toBe(true);
  });

  it('sends on pause only with hands-free active, and persists the choice', () => {
    const store = storage();
    const state = makeState(store);
    state.hydrate(false);
    expect(state.prefs.sendOnPause).toBe(false);
    state.setSendOnPause(true);
    expect(loadAiPrefs(store).sendOnPause).toBe(true);
    // Saved, but hands-free is off: nothing is sent automatically.
    expect(state.sendOnPauseActive).toBe(false);
    state.setHandsFree(true);
    state.voice.status = 'ready';
    expect(state.sendOnPauseActive).toBe(true);
    state.setHandsFree(false);
    expect(state.sendOnPauseActive).toBe(false);
    state.setHandsFree(true);
    state.setSendOnPause(false);
    expect(state.sendOnPauseActive).toBe(false);
    expect(loadAiPrefs(store).sendOnPause).toBe(false);

    const later = makeState(
      storage({ [AI_PREFS_KEY]: '{"handsFree":true,"sendOnPause":true}' }),
    );
    later.hydrate(false);
    expect(later.prefs.sendOnPause).toBe(true);
  });

  it('reads replies aloud only when switched on, and persists the choice', () => {
    class Utterance {
      constructor(readonly text: string) {}
    }
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    try {
      const store = storage();
      const synth = { speak: vi.fn(), cancel: vi.fn() };
      const state = makeState(store, { synth });
      state.hydrate(false);
      state.speak('hello');
      expect(synth.speak).not.toHaveBeenCalled();
      state.setReadAloud(true);
      expect(state.capabilities[2]?.state).toBe('ready');
      state.speak('hello');
      expect(synth.speak).toHaveBeenCalledTimes(1);
      expect(loadAiPrefs(store).readAloud).toBe(true);
      state.setReadAloud(false);
      expect(synth.cancel).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cannot switch read-aloud on without speech synthesis', () => {
    const state = makeState(storage(), { synth: null });
    state.hydrate(false);
    state.setReadAloud(true);
    expect(state.prefs.readAloud).toBe(false);
    expect(state.capabilities[2]?.state).toBe('off');
  });
});
