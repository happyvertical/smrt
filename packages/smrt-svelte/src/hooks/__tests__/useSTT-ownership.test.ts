/**
 * R4 regression (T2 #1403): useSTT()/useTTS() attach onDestroy to the
 * Provider-level *singleton* manager. Before the fix, unmounting ANY hook
 * consumer that found the manager listening would call stopListening() —
 * aborting a recording another consumer had started. The fix tracks per-hook
 * ownership: a consumer only stops the singleton if it started the session.
 */
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import type { SmrtAppStateManager } from '../../state/app-state.svelte.js';
import type { UseSTTReturn } from '../useSTT.svelte.js';
import Harness from './stt-ownership-harness.svelte';

/**
 * Minimal fake manager exposing only what useSTT touches. `isListening`
 * flips true once any consumer calls startListening().
 */
function makeFakeManager() {
  const listening = { value: false };
  const startListening = vi.fn(async () => {
    listening.value = true;
  });
  const stopListening = vi.fn(async () => {
    listening.value = false;
  });
  const manager = {
    startListening,
    stopListening,
    initializeSTT: vi.fn(async () => ({})),
    get state() {
      return {
        ai: {
          stt: {
            get isListening() {
              return listening.value;
            },
          },
        },
      };
    },
  } as unknown as SmrtAppStateManager;
  return { manager, startListening, stopListening, listening };
}

describe('useSTT per-hook ownership (R4)', () => {
  it("unmounting a non-owning consumer does not stop another consumer's recording", async () => {
    const { manager, startListening, stopListening } = makeFakeManager();
    let sttA: UseSTTReturn | undefined;

    const { rerender, unmount } = render(Harness, {
      props: {
        manager,
        showA: true,
        showB: true,
        onReadyA: (s: UseSTTReturn) => {
          sttA = s;
        },
      },
    });

    // Consumer A starts the shared listening session.
    await sttA?.start();
    await tick();
    expect(startListening).toHaveBeenCalledTimes(1);

    // Unmount consumer B (which never started). It must NOT stop A's session.
    await rerender({ manager, showA: true, showB: false });
    await tick();
    expect(stopListening).not.toHaveBeenCalled();

    // Now unmount everything: the owning consumer A stops its own session.
    unmount();
    await tick();
    expect(stopListening).toHaveBeenCalledTimes(1);
  });

  it('an owning consumer stops the session it started on unmount', async () => {
    const { manager, startListening, stopListening } = makeFakeManager();
    let sttA: UseSTTReturn | undefined;

    const { unmount } = render(Harness, {
      props: {
        manager,
        showA: true,
        showB: false,
        onReadyA: (s: UseSTTReturn) => {
          sttA = s;
        },
      },
    });

    await sttA?.start();
    await tick();
    expect(startListening).toHaveBeenCalledTimes(1);

    unmount();
    await tick();
    expect(stopListening).toHaveBeenCalledTimes(1);
  });

  it('a consumer that never started does not stop a session on unmount', async () => {
    const { manager, stopListening, listening } = makeFakeManager();
    // Simulate the singleton already listening (started elsewhere).
    listening.value = true;

    const { unmount } = render(Harness, {
      props: { manager, showA: true, showB: false },
    });
    await tick();

    // Consumer A never called start(); unmounting must leave the session alone.
    unmount();
    await tick();
    expect(stopListening).not.toHaveBeenCalled();
  });
});
