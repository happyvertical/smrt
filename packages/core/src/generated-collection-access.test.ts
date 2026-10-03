/**
 * Collection access for generated SvelteKit routes (#3416): the runtime
 * accessor, the deprecated legacy exports, and the fail-closed missing case.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SmrtClassOptions } from './class';

const warn = vi.hoisted(() => vi.fn());
vi.mock('@happyvertical/logger', () => ({
  createLogger: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const { createGeneratedCollectionAccess } = await import(
  './generated-collection-access'
);

function recordingRuntime() {
  let generation = 0;
  const calls: Array<{ method: string; className: string; db: unknown }> = [];
  return {
    calls,
    /** Simulates entering a new request: classOptions changes per call. */
    nextRequest() {
      generation += 1;
    },
    runtime: {
      classOptions(className: string): SmrtClassOptions {
        const db = { request: generation } as unknown as SmrtClassOptions['db'];
        calls.push({ method: 'classOptions', className, db });
        return { db };
      },
      async getCollection(className: string) {
        const db = { request: generation };
        calls.push({ method: 'getCollection', className, db });
        return { className, db } as never;
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  warn.mockClear();
});

describe('createGeneratedCollectionAccess', () => {
  it('resolves collections through the exported runtime on every call', async () => {
    const recorder = recordingRuntime();
    const access = createGeneratedCollectionAccess(
      { runtime: recorder.runtime },
      'src/lib/server/smrt.ts',
    );

    const first = (await access.getCollection('Item')) as unknown as {
      db: unknown;
    };
    recorder.nextRequest();
    const second = (await access.getCollection('Item')) as unknown as {
      db: unknown;
    };

    // Never cached: each call reaches the runtime with that call's context.
    expect(first.db).toEqual({ request: 0 });
    expect(second.db).toEqual({ request: 1 });
    expect(access.getSmrtConfig('Item').db).toEqual({ request: 1 });
    expect(recorder.calls.map((call) => call.method)).toEqual([
      'getCollection',
      'getCollection',
      'classOptions',
    ]);
  });

  it('honours a legacy getCollection/getSmrtConfig export with one deprecation note', async () => {
    const recorder = recordingRuntime();
    const legacyGetCollection = vi.fn(async (className: string) => ({
      legacy: className,
    }));
    const legacyGetSmrtConfig = vi.fn(() => ({ db: 'legacy' }));
    const access = createGeneratedCollectionAccess(
      {
        runtime: recorder.runtime,
        getCollection: legacyGetCollection,
        getSmrtConfig: legacyGetSmrtConfig,
      },
      'src/lib/server/legacy-smrt.ts',
    );

    expect(await access.getCollection('Item')).toEqual({ legacy: 'Item' });
    expect(await access.getCollection('Note')).toEqual({ legacy: 'Note' });
    expect(access.getSmrtConfig('Item')).toEqual({ db: 'legacy' });

    // Exact back-compat: the app's own functions decide, the runtime is not
    // consulted while they are exported.
    expect(legacyGetCollection).toHaveBeenCalledTimes(2);
    expect(legacyGetSmrtConfig).toHaveBeenCalledTimes(1);
    expect(recorder.calls).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /Deprecated.*src\/lib\/server\/legacy-smrt\.ts.*export const runtime/s,
    );
  });

  it('uses the runtime for getSmrtConfig when only getCollection is legacy', () => {
    const recorder = recordingRuntime();
    const access = createGeneratedCollectionAccess(
      { runtime: recorder.runtime, getCollection: async () => ({}) },
      'src/lib/server/partial.ts',
    );
    expect(access.getSmrtConfig('Item').db).toEqual({ request: 0 });
  });

  it('fails closed with an actionable error when the module exports neither', async () => {
    const access = createGeneratedCollectionAccess(
      // A `runtime` that is not an application runtime is not accepted.
      { runtime: { getCollection: 'nope' } },
      'src/lib/server/smrt.ts',
    );
    await expect(access.getCollection('Item')).rejects.toThrow(
      /src\/lib\/server\/smrt\.ts must export `runtime`/,
    );
    expect(() => access.getSmrtConfig('Item')).toThrow(
      /createSmrtSvelteKitRuntime/,
    );
    expect(() =>
      createGeneratedCollectionAccess(undefined, 'x.ts').getSmrtConfig('Item'),
    ).toThrow(/x\.ts must export/);
  });
});
