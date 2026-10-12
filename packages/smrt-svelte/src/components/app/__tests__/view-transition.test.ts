import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOnNavigateViewTransition,
  runViewTransition,
  VIEW_TRANSITION_ATTRIBUTE,
} from '../view-transition.js';

type DocWithVT = { startViewTransition?: unknown };

function setReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
  }));
  window.matchMedia = globalThis.matchMedia;
}

afterEach(() => {
  delete (document as DocWithVT).startViewTransition;
  document.documentElement.removeAttribute(VIEW_TRANSITION_ATTRIBUTE);
  vi.unstubAllGlobals();
});

describe('runViewTransition', () => {
  it('just awaits the update when the API is absent', async () => {
    setReducedMotion(false);
    const update = vi.fn(async () => {});
    await runViewTransition(update);
    expect(update).toHaveBeenCalledOnce();
  });

  it('skips the transition under reduced motion or skip', async () => {
    const start = vi.fn();
    (document as DocWithVT).startViewTransition = start;
    setReducedMotion(true);
    const update = vi.fn();
    await runViewTransition(update);
    setReducedMotion(false);
    await runViewTransition(update, { skip: true });
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('runs the update inside startViewTransition and flags the document', async () => {
    setReducedMotion(false);
    let flagged: string | null = null;
    let finish: () => void = () => {};
    (document as DocWithVT).startViewTransition = (cb: () => Promise<void>) => {
      flagged = document.documentElement.getAttribute(
        VIEW_TRANSITION_ATTRIBUTE,
      );
      const updateCallbackDone = Promise.resolve(cb());
      return {
        ready: Promise.resolve(),
        updateCallbackDone,
        finished: new Promise<void>((resolve) => {
          finish = resolve;
        }),
      };
    };
    const update = vi.fn();
    await runViewTransition(update);
    expect(update).toHaveBeenCalledOnce();
    expect(flagged).toBe('');
    expect(
      document.documentElement.hasAttribute(VIEW_TRANSITION_ATTRIBUTE),
    ).toBe(true);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      document.documentElement.hasAttribute(VIEW_TRANSITION_ATTRIBUTE),
    ).toBe(false);
  });

  it('does not throw when the transition is aborted', async () => {
    setReducedMotion(false);
    const abort = () =>
      Promise.reject(new DOMException('skipped', 'AbortError'));
    (document as DocWithVT).startViewTransition = (cb: () => void) => {
      cb();
      return {
        ready: abort(),
        updateCallbackDone: Promise.resolve(),
        finished: abort(),
      };
    };
    const update = vi.fn();
    await expect(runViewTransition(update)).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(update).toHaveBeenCalledOnce();
    expect(
      document.documentElement.hasAttribute(VIEW_TRANSITION_ATTRIBUTE),
    ).toBe(false);
  });

  it('falls back to a plain update when startViewTransition throws', async () => {
    setReducedMotion(false);
    (document as DocWithVT).startViewTransition = () => {
      throw new Error('nope');
    };
    const update = vi.fn();
    await runViewTransition(update);
    expect(update).toHaveBeenCalledOnce();
    expect(
      document.documentElement.hasAttribute(VIEW_TRANSITION_ATTRIBUTE),
    ).toBe(false);
  });

  it('still surfaces an error thrown by the update itself', async () => {
    setReducedMotion(false);
    await expect(
      runViewTransition(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('createOnNavigateViewTransition', () => {
  it('resolves when the update starts and awaits navigation.complete inside it', async () => {
    setReducedMotion(false);
    let completed = false;
    const complete = new Promise<void>((resolve) =>
      setTimeout(() => {
        completed = true;
        resolve();
      }, 5),
    );
    const onNavigate = createOnNavigateViewTransition();
    await onNavigate({ complete });
    // No API: the fallback path resolves as soon as the update begins.
    expect(completed).toBe(false);
    await complete;
  });

  it('ignores unloading navigations and swallows a rejected complete', async () => {
    setReducedMotion(false);
    const onNavigate = createOnNavigateViewTransition();
    expect(
      onNavigate({ complete: Promise.resolve(), willUnload: true }),
    ).toBeUndefined();
    await expect(
      onNavigate({ complete: Promise.reject(new Error('cancelled')) }),
    ).resolves.toBeUndefined();
  });
});
