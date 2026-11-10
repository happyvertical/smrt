import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prefersReducedMotion,
  runViewTransition,
} from '../src/lib/motion/view-transition.ts';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

function install(options: { reduced?: boolean; supported?: boolean }) {
  const calls: Array<() => void | Promise<void>> = [];
  const attributes = new Map<string, string>();
  // The shell marks `<html data-smrt-view-transition>` while one runs.
  const doc: Record<string, unknown> = {
    documentElement: {
      setAttribute: (name: string, value: string) =>
        attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    },
  };
  if (options.supported) {
    doc.startViewTransition = (update: () => void | Promise<void>) => {
      calls.push(update);
      const updateCallbackDone = Promise.resolve().then(update);
      return {
        ready: updateCallbackDone,
        updateCallbackDone,
        finished: updateCallbackDone.then(() => {
          throw new Error('skipped');
        }),
      };
    };
  }
  const win: Record<string, unknown> = {
    matchMedia: (query: string) => ({
      matches: query.includes('reduce') && !!options.reduced,
    }),
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  return calls;
}

afterEach(() => {
  vi.stubGlobal('document', originalDocument);
  vi.stubGlobal('window', originalWindow);
});

describe('runViewTransition', () => {
  it('runs the update plainly where the browser has no view transitions', async () => {
    const calls = install({ supported: false });
    let ran = false;
    await runViewTransition(() => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('runs the update plainly when the visitor prefers reduced motion', async () => {
    const calls = install({ supported: true, reduced: true });
    let ran = false;
    await runViewTransition(() => {
      ran = true;
    });
    expect(prefersReducedMotion()).toBe(true);
    expect(ran).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('runs the update plainly when told to skip', async () => {
    const calls = install({ supported: true });
    let ran = false;
    await runViewTransition(
      () => {
        ran = true;
      },
      { skip: true },
    );
    expect(ran).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('wraps the update in a view transition and resolves once the DOM is updated', async () => {
    const calls = install({ supported: true });
    let ran = false;
    await runViewTransition(async () => {
      await Promise.resolve();
      ran = true;
    });
    expect(ran).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('does not reject when the transition itself is skipped', async () => {
    install({ supported: true });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    await runViewTransition(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
