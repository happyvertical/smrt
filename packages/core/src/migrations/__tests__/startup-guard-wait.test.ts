/**
 * #5530: opt-in wait mode for the startup migration guard. The check itself is
 * mocked at the migrate-record read, so these run in-process with no database.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseError } from '../../errors.js';

const { warn, info, readLast } = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  readLast: vi.fn(),
}));
vi.mock('@happyvertical/logger', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@happyvertical/logger')>();
  return {
    ...original,
    createLogger: (...args: Parameters<typeof original.createLogger>) =>
      Object.assign(original.createLogger(...args), { warn, info }),
  };
});
vi.mock('../migrate-record.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../migrate-record.js')>()),
  readLastMigrateRecord: readLast,
}));
vi.mock('../build-schema.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../build-schema.js')>()),
  resolveBuildSchema: () => ({
    fingerprint: 'a'.repeat(64),
    source: 'test',
  }),
  registeredBuildSchema: () => undefined,
}));

import {
  assertDatabaseMigratedForBuild,
  MIGRATION_WAIT_TIMEOUT_ENV,
  migrationWaitFromEnv,
} from '../startup-guard.js';

const MATCH = {
  state: 'recorded',
  record: { fingerprint: 'a'.repeat(64) },
};
const STALE = { state: 'none' };

let dbCount = 0;
const newDb = () =>
  ({
    __wait_test: ++dbCount,
    config: { url: `test://${dbCount}` },
  }) as never as DatabaseInterface;

function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

describe('assertDatabaseMigratedForBuild wait mode (#5530)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SMRT_ALLOW_UNMIGRATED_START', '');
    vi.stubEnv(MIGRATION_WAIT_TIMEOUT_ENV, '');
    readLast.mockReset();
    warn.mockClear();
    info.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('default stays fail-fast: one read, no retry', async () => {
    readLast.mockResolvedValue(STALE);
    await expect(assertDatabaseMigratedForBuild(newDb())).rejects.toMatchObject(
      { code: 'DB_MIGRATION_REQUIRED' },
    );
    expect(readLast).toHaveBeenCalledTimes(1);
  });

  it('passes immediately without sleeping or logging', async () => {
    readLast.mockResolvedValue(MATCH);
    const c = clock();
    await assertDatabaseMigratedForBuild(newDb(), {
      wait: { timeoutMs: 60_000, ...c },
    });
    expect(c.sleeps).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  });

  it('waits with doubling backoff capped at maxDelayMs, then lands', async () => {
    readLast
      .mockResolvedValueOnce(STALE)
      .mockResolvedValueOnce(STALE)
      .mockResolvedValueOnce(STALE)
      .mockResolvedValueOnce(STALE)
      .mockResolvedValue(MATCH);
    const c = clock();
    await assertDatabaseMigratedForBuild(newDb(), {
      wait: { timeoutMs: 600_000, maxDelayMs: 5_000, ...c },
    });
    expect(c.sleeps).toEqual([2_000, 4_000, 5_000, 5_000]);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[1][1]).toMatchObject({
      attempt: 2,
      retryInMs: 4_000,
      waitedMs: 2_000,
      timeoutMs: 600_000,
    });
    expect(warn.mock.calls[0][1].reason).toContain('Database migration check');
    expect(info).toHaveBeenCalledWith(expect.any(String), {
      attempts: 5,
      waitedMs: 16_000,
    });
  });

  it('rethrows the same original error once the timeout would be exceeded', async () => {
    readLast.mockResolvedValue(STALE);
    const c = clock();
    const error = await assertDatabaseMigratedForBuild(newDb(), {
      wait: { timeoutMs: 7_000, ...c },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error.code).toBe('DB_MIGRATION_REQUIRED');
    expect(error.message).toContain('Run smrt db:migrate');
    expect(c.sleeps).toEqual([2_000, 4_000]);
    expect(readLast).toHaveBeenCalledTimes(3);
  });

  it('does not retry other errors', async () => {
    const boom = new DatabaseError('connection refused', 'DB_CONNECTION', {});
    readLast.mockRejectedValue(boom);
    const c = clock();
    await expect(
      assertDatabaseMigratedForBuild(newDb(), {
        wait: { timeoutMs: 60_000, ...c },
      }),
    ).rejects.toBe(boom);
    expect(readLast).toHaveBeenCalledTimes(1);
    expect(c.sleeps).toEqual([]);
  });

  it('is enabled by SMRT_MIGRATION_WAIT_TIMEOUT_MS', async () => {
    vi.stubEnv(MIGRATION_WAIT_TIMEOUT_ENV, '60000');
    readLast.mockResolvedValueOnce(STALE).mockResolvedValue(MATCH);
    vi.useFakeTimers();
    try {
      const done = assertDatabaseMigratedForBuild(newDb());
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(done).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(readLast).toHaveBeenCalledTimes(2);
  });

  it('an invalid explicit timeout fails fast instead of waiting forever', async () => {
    readLast.mockResolvedValue(STALE);
    const c = clock();
    for (const timeoutMs of [Number.NaN, 0, -1])
      await expect(
        assertDatabaseMigratedForBuild(newDb(), { wait: { timeoutMs, ...c } }),
      ).rejects.toMatchObject({ code: 'DB_MIGRATION_REQUIRED' });
    expect(c.sleeps).toEqual([]);
  });

  it('a timeout shorter than the first delay rethrows without sleeping', async () => {
    readLast.mockResolvedValue(STALE);
    const c = clock();
    await expect(
      assertDatabaseMigratedForBuild(newDb(), {
        wait: { timeoutMs: 1_000, ...c },
      }),
    ).rejects.toMatchObject({ code: 'DB_MIGRATION_REQUIRED' });
    expect(c.sleeps).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('an explicit wait overrides the env value', async () => {
    vi.stubEnv(MIGRATION_WAIT_TIMEOUT_ENV, '600000');
    readLast.mockResolvedValue(STALE);
    const c = clock();
    await expect(
      assertDatabaseMigratedForBuild(newDb(), {
        wait: { timeoutMs: 3_000, ...c },
      }),
    ).rejects.toMatchObject({ code: 'DB_MIGRATION_REQUIRED' });
    expect(c.sleeps).toEqual([2_000]);
  });

  it('concurrent callers each wait and each land', async () => {
    const db = newDb();
    let stale = 2;
    readLast.mockImplementation(async () => (stale-- > 0 ? STALE : MATCH));
    const c = clock();
    await expect(
      Promise.all([
        assertDatabaseMigratedForBuild(db, {
          wait: { timeoutMs: 60_000, ...c },
        }),
        assertDatabaseMigratedForBuild(db, {
          wait: { timeoutMs: 60_000, ...c },
        }),
      ]),
    ).resolves.toBeDefined();
  });

  it('parses the env value strictly', () => {
    const at = (v?: string) =>
      migrationWaitFromEnv({ [MIGRATION_WAIT_TIMEOUT_ENV]: v });
    expect(at('90000')).toEqual({ timeoutMs: 90_000 });
    for (const v of [undefined, '', '0', '-5', 'abc', '1.5', '10s'])
      expect(at(v)).toBeUndefined();
  });
});
