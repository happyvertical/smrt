import { describe, expect, it, vi } from 'vitest';
import { cancelsSpeech } from '../src/lib/ai/echo-gate.ts';
import { AiState, type Synth } from '../src/lib/ai/state.svelte.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

class Utterance {
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  } as unknown as Storage;
}

function setup() {
  const spoken: Utterance[] = [];
  const synth: Synth = {
    speak: vi.fn((u) => void spoken.push(u as unknown as Utterance)),
    cancel: vi.fn(),
  };
  const state = new AiState({
    storage: storage(),
    session: { store: recipeState, recipes, webgpu: () => true },
    voice: {
      createModel: () =>
        ({
          estimateSize: () => 1,
          isCached: async () => false,
          load: vi.fn(),
          dispose: vi.fn(),
        }) as never,
      probe: async () => 'missing',
      browserSource: () => () => Promise.reject(new Error('unused')),
    },
    synth,
    mic: true,
  });
  state.hydrate(false);
  state.setReadAloud(true);
  return { state, synth, spoken };
}

describe('speaking signal', () => {
  it('is true from queueing until the last utterance ends', () => {
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    try {
      const { state, spoken } = setup();
      expect(state.speaking).toBe(false);
      state.speak('First paragraph.\n\nSecond paragraph.\n\nThird.');
      expect(spoken).toHaveLength(3);
      expect(state.speaking).toBe(true);
      spoken[0]?.onend?.();
      spoken[1]?.onend?.();
      expect(state.speaking).toBe(true);
      spoken[2]?.onend?.();
      expect(state.speaking).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('an error counts as the end of that utterance', () => {
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    try {
      const { state, spoken } = setup();
      state.speak('One.\n\nTwo.');
      spoken[0]?.onerror?.();
      spoken[1]?.onerror?.();
      expect(state.speaking).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cancelSpeech clears it at once and ignores late events', () => {
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    try {
      const { state, synth, spoken } = setup();
      state.speak('One.\n\nTwo.');
      state.cancelSpeech();
      expect(state.speaking).toBe(false);
      expect(synth.cancel).toHaveBeenCalled();
      state.speak('New reply.');
      // A cancelled utterance's late `end` must not clear the new reply.
      spoken[0]?.onend?.();
      spoken[1]?.onend?.();
      expect(state.speaking).toBe(true);
      spoken[2]?.onend?.();
      expect(state.speaking).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a new reply replaces the one being read and switching read-aloud off stops it', () => {
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    try {
      const { state } = setup();
      state.speak('Hello.');
      state.setReadAloud(false);
      expect(state.speaking).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not speak, or claim to, when read-aloud is off', () => {
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    try {
      const { state, synth } = setup();
      state.setReadAloud(false);
      state.speak('Hello.');
      expect(synth.speak).not.toHaveBeenCalled();
      expect(state.speaking).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('cancelsSpeech', () => {
  /** A stand-in element: the tag it is, and the classes it sits inside. */
  const el = (tag: string, inside: string[] = []) =>
    ({
      matches: (selector: string) =>
        selector.split(',').some((part) => {
          const p = part.trim();
          return p === tag || (tag === 'input' && p.startsWith('input'));
        }),
      closest: (selector: string) =>
        inside.includes(selector.replace(/^\./, '')) ? {} : null,
    }) as unknown as EventTarget;

  it('typing in the message box cancels', () => {
    expect(cancelsSpeech({ type: 'input', target: el('textarea') })).toBe(true);
  });
  it('pressing the microphone (or its icon) cancels', () => {
    const inside = ['smrt-dictation-button'];
    expect(cancelsSpeech({ type: 'click', target: el('button', inside) })).toBe(
      true,
    );
    expect(cancelsSpeech({ type: 'click', target: el('svg', inside) })).toBe(
      true,
    );
  });
  it('other clicks and unrelated events do not', () => {
    expect(cancelsSpeech({ type: 'click', target: el('button') })).toBe(false);
    expect(cancelsSpeech({ type: 'input', target: el('button') })).toBe(false);
    expect(cancelsSpeech({ type: 'keydown', target: el('textarea') })).toBe(
      false,
    );
    expect(cancelsSpeech({ type: 'click', target: null })).toBe(false);
  });
});
