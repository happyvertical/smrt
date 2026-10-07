import { describe, expect, it, vi } from 'vitest';
import { PREFS_KEY } from '../src/lib/assistant/prefs.ts';
import { AssistantSession } from '../src/lib/assistant/session.svelte.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  } as unknown as Storage;
}

const engine = {
  chat: { completions: { create: vi.fn() } },
  interruptGenerate: vi.fn(),
};

describe('AssistantSession', () => {
  it('is unsupported without WebGPU and never loads', async () => {
    const createWorker = vi.fn();
    const session = new AssistantSession({
      store: recipeState,
      recipes,
      storage: null,
      webgpu: () => false,
      host: { createWorker, createEngine: vi.fn() },
    });
    expect(session.status).toBe('unsupported');
    await session.start();
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('downloads nothing until start, records consent, then is ready', async () => {
    const store = storage();
    const createWorker = vi.fn(
      () => ({ terminate: vi.fn() }) as unknown as Worker,
    );
    const session = new AssistantSession({
      store: recipeState,
      recipes,
      storage: store,
      webgpu: () => true,
      host: {
        createWorker,
        createEngine: async (_w, _id, onProgress) => {
          onProgress({ progress: 1, text: 'done' });
          return engine as never;
        },
      },
    });
    expect(session.status).toBe('idle');
    expect(session.consented).toBe(false);
    expect(createWorker).not.toHaveBeenCalled();
    await session.start();
    expect(session.status).toBe('ready');
    expect(session.consented).toBe(true);
    expect(JSON.parse(store.getItem(PREFS_KEY) ?? '{}').consented).toHaveLength(
      1,
    );
    session.unload();
    expect(session.status).toBe('idle');
  });

  it('returns to idle when the download is cancelled', async () => {
    const terminate = vi.fn();
    const session = new AssistantSession({
      store: recipeState,
      recipes,
      storage: null,
      webgpu: () => true,
      host: {
        createWorker: () => ({ terminate }) as unknown as Worker,
        createEngine: () => new Promise(() => {}),
      },
    });
    const started = session.start();
    expect(session.status).toBe('loading');
    session.cancel();
    await started;
    expect(session.status).toBe('idle');
    expect(terminate).toHaveBeenCalled();
  });

  it('shows an error when loading fails', async () => {
    const session = new AssistantSession({
      store: recipeState,
      recipes,
      storage: null,
      webgpu: () => true,
      host: {
        createWorker: () => ({ terminate: vi.fn() }) as unknown as Worker,
        createEngine: async () => {
          throw new Error('out of memory');
        },
      },
    });
    await session.start();
    expect(session.status).toBe('error');
    expect(session.error).toContain('out of memory');
  });
});
