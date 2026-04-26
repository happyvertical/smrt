/**
 * Issue #1161 — TaskRunner must resolve lazy / env-derived `agent_config`
 * fields at execute time, not return whatever was snapshotted at sync time.
 *
 * The dashboard previously had to add a hand-rolled `overlayPraecoEnvStorage`
 * shim that re-resolved env-derived storage every time a Praeco schedule
 * fired (anytown.ai PR #270, apps/dashboard/src/lib/server/agent-schedules.ts).
 * Native lazy resolution removes that workaround.
 */
import {
  getTestDatabase,
  ObjectRegistry,
  registerConfigResolver,
  resetConfigResolvers,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

@smrt()
class LazyConfigProbe extends SmrtObject {
  // Capture the constructor options for the test to assert against.
  static lastConstructorOptions: Record<string, unknown> | null = null;

  // Per-class lazy resolver that always reflects the live env value.
  static configResolvers = {
    classOverlay: () => process.env.LAZY_AGENT_CLASS_VAR ?? null,
  };

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    LazyConfigProbe.lastConstructorOptions = { ...options };
  }

  async ping(): Promise<string> {
    return 'pong';
  }
}

afterEach(() => {
  ObjectRegistry.clearCollectionCache?.();
  resetConfigResolvers();
  delete process.env.LAZY_AGENT_ENV_VAR;
  delete process.env.LAZY_AGENT_CLASS_VAR;
  LazyConfigProbe.lastConstructorOptions = null;
});

describe('TaskRunner — lazy agent_config resolution (issue #1161)', () => {
  it('resolves $env sentinels at execute time using the live registry', async () => {
    process.env.LAZY_AGENT_ENV_VAR = 'live-storage';
    registerConfigResolver(
      'sharedAssetStorage',
      () => process.env.LAZY_AGENT_ENV_VAR,
    );

    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const jobs = await SmrtJobCollection.create({ db });

    // Simulate a stale persisted agent_config: a sentinel that points at the
    // resolver instead of a snapshotted env value.
    await jobs.create({
      objectType: 'LazyConfigProbe',
      method: 'ping',
      args: {
        _agentConfig: {
          assetStorage: { $env: 'sharedAssetStorage' },
          unrelated: 'persisted',
        },
      },
    });

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);

    const completed = new Promise<void>((resolve, reject) => {
      runner.once('job:completed', () => resolve());
      runner.once('job:failed', (_job, error) => reject(error));
    });

    await runner.start();
    try {
      // Rotate the env between persistence and execution to prove freshness.
      process.env.LAZY_AGENT_ENV_VAR = 'rotated-storage';
      await completed;
    } finally {
      await runner.stop();
    }

    const observed = LazyConfigProbe.lastConstructorOptions ?? {};
    expect(observed.assetStorage).toBe('rotated-storage');
    expect(observed.unrelated).toBe('persisted');
  });

  it('overlays static configResolvers on top of persisted values', async () => {
    process.env.LAZY_AGENT_CLASS_VAR = 'class-live';

    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const jobs = await SmrtJobCollection.create({ db });

    await jobs.create({
      objectType: 'LazyConfigProbe',
      method: 'ping',
      args: {
        _agentConfig: {
          classOverlay: 'persisted-stale',
          keepThis: 'persisted-keep',
        },
      },
    });

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);

    const completed = new Promise<void>((resolve, reject) => {
      runner.once('job:completed', () => resolve());
      runner.once('job:failed', (_job, error) => reject(error));
    });

    await runner.start();
    try {
      await completed;
    } finally {
      await runner.stop();
    }

    const observed = LazyConfigProbe.lastConstructorOptions ?? {};
    expect(observed.classOverlay).toBe('class-live');
    expect(observed.keepThis).toBe('persisted-keep');
  });

  it('leaves persisted values untouched when no resolver is registered', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const jobs = await SmrtJobCollection.create({ db });

    await jobs.create({
      objectType: 'LazyConfigProbe',
      method: 'ping',
      args: {
        _agentConfig: { plain: 'value' },
      },
    });

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);

    const completed = new Promise<void>((resolve, reject) => {
      runner.once('job:completed', () => resolve());
      runner.once('job:failed', (_job, error) => reject(error));
    });

    await runner.start();
    try {
      await completed;
    } finally {
      await runner.stop();
    }

    expect(LazyConfigProbe.lastConstructorOptions?.plain).toBe('value');
  });
});
