import { describe, expect, it, vi } from 'vitest';

/** Hide (or restore) `process.getBuiltinModule`, the Node-host probe. */
function setBuiltinModuleProbe(value: unknown): void {
  Object.defineProperty(process, 'getBuiltinModule', {
    value,
    configurable: true,
    writable: true,
  });
}

/**
 * A browser has no async-local state, so the queue cannot recognize a nested
 * write as re-entry. It must run writes unqueued there; queueing the nested
 * write behind its parent would deadlock (#2838).
 */
describe('withEmbeddedWriteQueue without async context', () => {
  it('runs a nested serialized write instead of deadlocking behind its parent', async () => {
    const real = process.getBuiltinModule;
    setBuiltinModuleProbe(undefined);
    vi.resetModules();
    try {
      const { withEmbeddedWriteQueue } = await import(
        './embedded-write-queue.js'
      );
      const db = { url: 'file:/tmp/no-async-context.db' };
      const order: string[] = [];
      const result = await Promise.race([
        withEmbeddedWriteQueue(db, true, async () => {
          order.push('outer:start');
          await withEmbeddedWriteQueue(db, true, async () => {
            order.push('inner');
          });
          order.push('outer:end');
          return 'done';
        }),
        new Promise((resolve) => setTimeout(() => resolve('deadlock'), 2_000)),
      ]);
      expect(result).toBe('done');
      expect(order).toEqual(['outer:start', 'inner', 'outer:end']);
    } finally {
      setBuiltinModuleProbe(real);
    }
  });
});
