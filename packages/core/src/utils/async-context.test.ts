import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncContext } from './async-context.js';

/** Hide (or restore) `process.getBuiltinModule`, the Node-host probe. */
function setBuiltinModuleProbe(value: unknown): void {
  Object.defineProperty(process, 'getBuiltinModule', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('createAsyncContext', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('carries the store through await on a Node host', async () => {
    const context = createAsyncContext<string>();
    expect(context.propagatesAcrossAwait).toBe(true);
    expect(context.getStore()).toBeUndefined();
    await context.run('outer', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(context.getStore()).toBe('outer');
      await context.run('inner', async () => {
        await Promise.resolve();
        expect(context.getStore()).toBe('inner');
      });
      expect(context.getStore()).toBe('outer');
    });
    expect(context.getStore()).toBeUndefined();
  });

  it('degrades to an empty store when the host has no async hooks', async () => {
    const real = process.getBuiltinModule;
    setBuiltinModuleProbe(undefined);
    vi.resetModules();
    try {
      const { createAsyncContext: fresh } = await import('./async-context.js');
      const context = fresh<string>();
      expect(context.propagatesAcrossAwait).toBe(false);
      expect(context.run('x', () => context.getStore())).toBeUndefined();
      expect(context.run('x', () => 42)).toBe(42);
    } finally {
      setBuiltinModuleProbe(real);
    }
  });

  it('degrades the same way when the host has no process global', async () => {
    vi.stubGlobal('process', undefined);
    const { createAsyncContext: fresh } = await import('./async-context.js');
    expect(fresh<string>().propagatesAcrossAwait).toBe(false);
  });
});
