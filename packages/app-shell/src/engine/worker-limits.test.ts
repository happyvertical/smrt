import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import { AppHost, DEFAULT_WORKER_LIMITS, MemoryVersionStore } from './index.ts';
import { resourceLimitsFor } from './worker-handle.ts';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'engine-limits-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('worker memory limits (#5212)', () => {
  it('caps the young generation by default, next to the old generation', () => {
    expect(resourceLimitsFor()).toEqual({
      maxOldGenerationSizeMb: 512,
      maxYoungGenerationSizeMb: DEFAULT_WORKER_LIMITS.youngMb,
    });
    expect(DEFAULT_WORKER_LIMITS.youngMb).toBe(16);
  });

  it('is host-configurable, and null leaves V8 its own sizing', () => {
    expect(resourceLimitsFor({ youngMb: 4, oldMb: 256 })).toEqual({
      maxOldGenerationSizeMb: 256,
      maxYoungGenerationSizeMb: 4,
    });
    expect(resourceLimitsFor({ youngMb: null })).toEqual({
      maxOldGenerationSizeMb: 512,
    });
  });

  it('refuses a limit that is not a whole number of MiB', () => {
    expect(() => resourceLimitsFor({ youngMb: 0 })).toThrow(RangeError);
    expect(() => resourceLimitsFor({ oldMb: 1.5 })).toThrow(RangeError);
  });

  it('refuses a statement timeout that is not a whole number of ms, and leaves the V8 limits alone', () => {
    expect(() => resourceLimitsFor({ statementTimeoutMs: 0 })).toThrow(
      RangeError,
    );
    expect(() => resourceLimitsFor({ statementTimeoutMs: 2.5 })).toThrow(
      RangeError,
    );
    expect(resourceLimitsFor({ statementTimeoutMs: 5000 })).toEqual(
      resourceLimitsFor(),
    );
  });

  it('a SQLite app takes a statement timeout and ignores it', async () => {
    const host = await AppHost.open(tmp(), {
      store: new MemoryVersionStore(),
      workerLimits: { statementTimeoutMs: 1000 },
    });
    await host.execute(
      hostOwner(host),
      { type: 'defineModel', name: 'Note', fields: { t: { type: 'text' } } },
      { author: 't' },
    );
    await host.create(hostOwner(host), 'Note', { t: 'ok' });
    expect((await host.list(hostOwner(host), 'Note')).length).toBe(1);
    await host.close();
  });

  it('runs an app under configured limits', async () => {
    const host = await AppHost.open(tmp(), {
      store: new MemoryVersionStore(),
      workerLimits: { youngMb: 4, oldMb: 256 },
    });
    try {
      await host.execute(
        hostOwner(host),
        {
          type: 'defineModel',
          name: 'Chore',
          fields: { title: { type: 'text' } },
        },
        { author: 't' },
      );
      await host.create(hostOwner(host), 'Chore', { title: 'kept' });
      expect(await host.list(hostOwner(host), 'Chore')).toHaveLength(1);
    } finally {
      await host.close();
    }
  });
});
