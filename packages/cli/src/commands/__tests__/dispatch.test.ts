/**
 * Unit tests for dispatch commands
 *
 * Exercises the dispatch:list/process/retry/cleanup/subscriptions/subscribe/
 * unsubscribe command handlers against a real in-memory-on-disk SQLite
 * DispatchBus. Only the config boundary (getPackageConfig) is mocked so the
 * handler resolves a real temp-file SQLite database; the DispatchBus, the
 * _smrt_dispatch tables, and every query run for real (per testing rules:
 * never mock the database).
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';

const { getPackageConfigMock } = vi.hoisted(() => ({
  getPackageConfigMock: vi.fn(),
}));

vi.mock('@happyvertical/smrt-config', () => ({
  getPackageConfig: getPackageConfigMock,
}));

import { createDispatchBus } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { dispatchCommands } from '../dispatch.js';

describe('dispatch commands', () => {
  let dbPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `smrt-dispatch-cli-${randomUUID().slice(0, 8)}.db`);
    getPackageConfigMock.mockReturnValue({
      database: { type: 'sqlite', url: dbPath },
    });
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      _code?: number,
    ) => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    process.exitCode = undefined;
    if (existsSync(dbPath)) {
      rmSync(dbPath, { force: true });
    }
  });

  // Helper: open a real bus against the same temp db to seed/inspect data.
  async function openBus() {
    const db = await getDatabase({ type: 'sqlite', url: dbPath });
    const bus = await createDispatchBus({ db });
    return { db, bus };
  }

  const allOutput = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');

  // Helper: insert a raw dispatch row (lease and reason shapes included).
  async function insertRow(
    db: Awaited<ReturnType<typeof openBus>>['db'],
    row: {
      id: string;
      status?: string;
      attempts?: number;
      leaseToken?: string;
      claimedUntil?: string;
      lastError?: string;
    },
  ) {
    const at = new Date(Date.now() - 7_200_000).toISOString();
    await db.query(
      `INSERT INTO _smrt_dispatch
         (id, type, source, payload, status, attempts, last_error, lease_token,
          claimed_until, metadata, created_at, updated_at)
       VALUES ($1, 'job.run', 'test', '{}', $2, $3, $4, $5, $6, '{}', $7, $8)`,
      row.id,
      row.status ?? 'pending',
      row.attempts ?? 0,
      row.lastError ?? null,
      row.leaseToken ?? null,
      row.claimedUntil ?? null,
      at,
      at,
    );
  }

  describe('dispatch:list', () => {
    it('reports when no dispatches are found', async () => {
      await requireCommandHandler(dispatchCommands['dispatch:list'])([], {});
      expect(allOutput()).toContain('No dispatches found.');
    });

    it('renders a table of dispatches', async () => {
      const { db, bus } = await openBus();
      await bus.emit('campaign.completed', { x: 1 }, { source: 'suasor' });
      await bus.emit('order.created', { y: 2 }, { source: 'commerce' });
      await db.close?.();

      await requireCommandHandler(dispatchCommands['dispatch:list'])([], {});

      const out = allOutput();
      expect(out).toContain('Found 2 dispatch(es)');
      expect(out).toContain('campaign.completed');
      expect(out).toContain('order.created');
    });

    it('supports JSON output and status filtering', async () => {
      const { db, bus } = await openBus();
      await bus.emit('a.event', {}, { source: 's1' });
      await db.close?.();

      await requireCommandHandler(dispatchCommands['dispatch:list'])([], {
        json: true,
        status: 'pending',
        limit: 10,
      });

      const out = allOutput();
      const parsed = JSON.parse(out);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
    });

    it('sets exit code on error (bad db config)', async () => {
      getPackageConfigMock.mockReturnValueOnce({ database: {} });
      await requireCommandHandler(dispatchCommands['dispatch:list'])([], {});
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('dispatch:process', () => {
    it('exits when subscriber is missing', async () => {
      await expect(
        requireCommandHandler(dispatchCommands['dispatch:process'])([], {}),
      ).rejects.toThrow('process.exit called');
    });

    it('dry-run lists subscriptions and matching dispatches', async () => {
      const { db, bus } = await openBus();
      await bus.subscribe({
        signalType: 'campaign.*',
        subscriber: 'fiscus',
        handler: 'handleCampaign',
      });
      await bus.emit('campaign.completed', {}, { source: 'suasor' });
      await db.close?.();

      await requireCommandHandler(dispatchCommands['dispatch:process'])([], {
        subscriber: 'fiscus',
        dry: true,
      });

      const out = allOutput();
      expect(out).toContain('Subscriptions for "fiscus"');
      expect(out).toContain('campaign.* → handleCampaign()');
      expect(out).toContain('would be processed');
    });

    it('processes pending dispatches for a subscriber', async () => {
      const { db, bus } = await openBus();
      await bus.subscribe({
        signalType: 'campaign.completed',
        subscriber: 'fiscus',
      });
      await bus.emit('campaign.completed', {}, { source: 'suasor' });
      await db.close?.();

      await requireCommandHandler(dispatchCommands['dispatch:process'])([], {
        subscriber: 'fiscus',
      });

      const out = allOutput();
      expect(out).toContain('Processing dispatches for "fiscus"');
      expect(out).toMatch(/Processed \d+ dispatch/);
    });

    it('sets exit code on error', async () => {
      getPackageConfigMock.mockReturnValueOnce({ database: {} });
      await requireCommandHandler(dispatchCommands['dispatch:process'])([], {
        subscriber: 'fiscus',
      });
      expect(process.exitCode).toBe(1);
    });

    it('process --dry shows an expired lease with its phase; the live CLI needs --include-expired to take it', async () => {
      const { db, bus } = await openBus();
      await bus.subscribe({ signalType: 'job.run', subscriber: 'worker' });
      const past = new Date(Date.now() - 3_600_000).toISOString();
      await insertRow(db, {
        id: 'expired-row',
        status: 'processing',
        leaseToken: 'gone',
        claimedUntil: past,
      });
      await insertRow(db, { id: 'pending-row' });
      await db.close?.();

      await requireCommandHandler(dispatchCommands['dispatch:process'])([], {
        subscriber: 'worker',
        dry: true,
      });
      const preview = allOutput();
      expect(preview).toMatch(/expired-row.*\[expired\]/);
      expect(preview).toMatch(/pending-row.*\[dated\]/);
      expect(preview).toContain('would be processed: 1');
      expect(preview).toContain('processed only with --include-expired: 1');

      logSpy.mockClear();
      await requireCommandHandler(dispatchCommands['dispatch:process'])([], {
        subscriber: 'worker',
      });
      expect(allOutput()).toContain('Processed 1 dispatch');
      const after = await openBus();
      const rows = await after.db.query(
        'SELECT id, status, lease_token FROM _smrt_dispatch ORDER BY id',
      );
      expect(rows.rows).toEqual([
        { id: 'expired-row', status: 'processing', lease_token: 'gone' },
        {
          id: 'pending-row',
          status: 'completed',
          lease_token: expect.any(String),
        },
      ]);
      await after.db.close?.();

      logSpy.mockClear();
      await requireCommandHandler(dispatchCommands['dispatch:process'])([], {
        subscriber: 'worker',
        'include-expired': true,
      });
      expect(allOutput()).toContain('Processed 1 dispatch');
    });
  });

  describe('dispatch:release-leases', () => {
    it('releases expired leases by default, legacy rows with --legacy, every lease with --after-drain', async () => {
      const { db } = await openBus();
      const past = new Date(Date.now() - 3_600_000).toISOString();
      const future = new Date(Date.now() + 3_600_000).toISOString();
      await insertRow(db, {
        id: 'expired',
        status: 'processing',
        leaseToken: 'a',
        claimedUntil: past,
      });
      await insertRow(db, {
        id: 'live',
        status: 'processing',
        leaseToken: 'b',
        claimedUntil: future,
      });
      await insertRow(db, { id: 'legacy', status: 'processing' });
      await db.close?.();

      const release = requireCommandHandler(
        dispatchCommands['dispatch:release-leases'],
      );
      await release([], { dry: true });
      expect(allOutput()).toContain('Would release 1 lease');
      await release([], {});
      expect(allOutput()).toContain('Released 1 lease');
      await release([], { legacy: true });
      await release([], { 'after-drain': true });

      const after = await openBus();
      const rows = await after.db.query(
        `SELECT id, status, lease_token FROM _smrt_dispatch
          WHERE status = 'processing' AND lease_token IS NOT NULL`,
      );
      // Rollback check: no leased processing row remains.
      expect(rows.rows).toEqual([]);
      const statuses = await after.db.query(
        'SELECT id, status FROM _smrt_dispatch ORDER BY id',
      );
      expect(statuses.rows).toEqual([
        { id: 'expired', status: 'pending' },
        { id: 'legacy', status: 'pending' },
        { id: 'live', status: 'pending' },
      ]);
      await after.db.close?.();
    });

    it('rejects --legacy together with --after-drain', async () => {
      await requireCommandHandler(dispatchCommands['dispatch:release-leases'])(
        [],
        { legacy: true, 'after-drain': true },
      );
      expect(process.exitCode).toBe(1);
    });
  });

  describe('dispatch:list --reason', () => {
    it('filters by an exact framework reason code', async () => {
      const { db } = await openBus();
      await insertRow(db, {
        id: 'exhausted',
        status: 'failed',
        lastError: '[smrt:DISPATCH_ATTEMPTS_EXHAUSTED] after 5 claims',
      });
      await insertRow(db, {
        id: 'forged',
        status: 'failed',
        lastError: 'handler: [smrt:DISPATCH_ATTEMPTS_EXHAUSTED] x',
      });
      await insertRow(db, {
        id: 'lookalike',
        status: 'failed',
        lastError: '[smrt:DISPATCH-ATTEMPTS-EXHAUSTED] x',
      });
      await db.close?.();

      await requireCommandHandler(dispatchCommands['dispatch:list'])([], {
        reason: 'DISPATCH_ATTEMPTS_EXHAUSTED',
        json: true,
      });
      const listed = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Array<{
        id: string;
      }>;
      expect(listed.map((row) => row.id)).toEqual(['exhausted']);
    });

    it('rejects an unknown reason code', async () => {
      await requireCommandHandler(dispatchCommands['dispatch:list'])([], {
        reason: 'NOPE',
      });
      expect(process.exitCode).toBe(1);
    });
  });

  describe('dispatch:retry', () => {
    it('defaults to the claim budget and revives exhausted rows with --reset-attempts', async () => {
      const { db } = await openBus();
      // Under the default budget (5) but over the old CLI default (3).
      await insertRow(db, { id: 'three', status: 'failed', attempts: 3 });
      await insertRow(db, {
        id: 'spent',
        status: 'failed',
        attempts: 5,
        lastError: '[smrt:DISPATCH_ATTEMPTS_EXHAUSTED] after 5 claims',
      });
      await db.close?.();

      const retry = requireCommandHandler(dispatchCommands['dispatch:retry']);
      await retry([], {});
      expect(allOutput()).toContain('Reset 1 failed dispatch');
      await retry([], { 'reset-attempts': true });
      expect(allOutput()).toContain(
        'Reset 1 failed dispatch(es) to pending (attempts reset)',
      );

      const after = await openBus();
      const rows = await after.db.query(
        'SELECT id, status, attempts FROM _smrt_dispatch ORDER BY id',
      );
      expect(rows.rows).toEqual([
        { id: 'spent', status: 'pending', attempts: 0 },
        { id: 'three', status: 'pending', attempts: 3 },
      ]);
      await after.db.close?.();
    });

    it('resets failed dispatches to pending', async () => {
      await requireCommandHandler(dispatchCommands['dispatch:retry'])([], {
        'max-attempts': 5,
        type: 'campaign.completed',
      });
      expect(allOutput()).toMatch(/Reset \d+ failed dispatch/);
    });

    it('uses defaults when options omitted', async () => {
      await requireCommandHandler(dispatchCommands['dispatch:retry'])([], {});
      expect(allOutput()).toMatch(/Reset \d+ failed dispatch/);
    });

    it('sets exit code on error', async () => {
      getPackageConfigMock.mockReturnValueOnce({ database: {} });
      await requireCommandHandler(dispatchCommands['dispatch:retry'])([], {});
      expect(process.exitCode).toBe(1);
    });
  });

  describe('dispatch:cleanup', () => {
    it('cleanup --dry counts exactly what the live cleanup deletes', async () => {
      // Cleanup half of P6 T32: the preview counts exactly the rows the live
      // cleanup deletes, and deletes nothing.
      const { db, bus } = await openBus();
      await bus.emit('a.event', {}, { source: 's1' });
      const daysAgo = (n: number) =>
        new Date(Date.now() - n * 86_400_000).toISOString();
      const seed = async (id: string, status: string, at: string) =>
        db.query(
          `INSERT INTO _smrt_dispatch (id, type, source, payload, status, attempts, processed_at, metadata, created_at, updated_at)
           VALUES ($1, 'a.event', 's1', '{}', $2, 1, $3, '{}', $4, $5)`,
          id,
          status,
          status === 'completed' ? at : null,
          at,
          at,
        );
      await seed('old-completed', 'completed', daysAgo(20));
      await seed('new-completed', 'completed', daysAgo(2));
      await seed('old-failed', 'failed', daysAgo(10));
      await seed('new-failed', 'failed', daysAgo(1));
      const total = async () => {
        const { rows } = await db.query(
          'SELECT COUNT(*) AS n FROM _smrt_dispatch',
        );
        return Number((rows[0] as { n: unknown }).n);
      };
      expect(await total()).toBe(5);

      await requireCommandHandler(dispatchCommands['dispatch:cleanup'])([], {
        dry: true,
        'completed-older-than': 15,
        'failed-older-than': 7,
      });

      const out = allOutput();
      expect(out).toContain('Would delete completed older than 15 days: 1');
      expect(out).toContain('Would delete failed older than 7 days: 1');
      expect(await total()).toBe(5);

      logSpy.mockClear();
      await requireCommandHandler(dispatchCommands['dispatch:cleanup'])([], {
        'completed-older-than': 15,
        'failed-older-than': 7,
      });
      expect(allOutput()).toContain('Completed deleted: 1');
      expect(allOutput()).toContain('Failed deleted: 1');
      expect(await total()).toBe(3);
      await db.close?.();
    });

    it('performs cleanup and reports deleted counts', async () => {
      await requireCommandHandler(dispatchCommands['dispatch:cleanup'])([], {});
      const out = allOutput();
      expect(out).toContain('Cleanup complete');
      expect(out).toContain('Completed deleted:');
      expect(out).toContain('Failed deleted:');
    });

    it('sets exit code on error', async () => {
      getPackageConfigMock.mockReturnValueOnce({ database: {} });
      await requireCommandHandler(dispatchCommands['dispatch:cleanup'])([], {});
      expect(process.exitCode).toBe(1);
    });
  });

  describe('dispatch:subscriptions', () => {
    it('reports when no subscriptions exist', async () => {
      await requireCommandHandler(dispatchCommands['dispatch:subscriptions'])(
        [],
        {},
      );
      expect(allOutput()).toContain('No subscriptions found.');
    });

    it('renders a subscriptions table', async () => {
      const { db, bus } = await openBus();
      await bus.subscribe({
        signalType: 'campaign.*',
        subscriber: 'fiscus',
        handler: 'handleCampaign',
      });
      await db.close?.();

      await requireCommandHandler(dispatchCommands['dispatch:subscriptions'])(
        [],
        {},
      );

      const out = allOutput();
      expect(out).toContain('Found 1 subscription(s)');
      expect(out).toContain('fiscus');
      expect(out).toContain('campaign.*');
    });

    it('supports JSON output', async () => {
      const { db, bus } = await openBus();
      await bus.subscribe({ signalType: 'x.y', subscriber: 's1' });
      await db.close?.();

      await requireCommandHandler(dispatchCommands['dispatch:subscriptions'])(
        [],
        {
          json: true,
        },
      );

      const parsed = JSON.parse(allOutput());
      expect(parsed).toHaveLength(1);
    });

    it('sets exit code on error', async () => {
      getPackageConfigMock.mockReturnValueOnce({ database: {} });
      await requireCommandHandler(dispatchCommands['dispatch:subscriptions'])(
        [],
        {},
      );
      expect(process.exitCode).toBe(1);
    });
  });

  describe('dispatch:subscribe', () => {
    it('exits when args are missing', async () => {
      await expect(
        requireCommandHandler(dispatchCommands['dispatch:subscribe'])(
          ['only-one'],
          {},
        ),
      ).rejects.toThrow('process.exit called');
    });

    it('creates a subscription', async () => {
      await requireCommandHandler(dispatchCommands['dispatch:subscribe'])(
        ['campaign.*', 'fiscus'],
        { handler: 'handleCampaign' },
      );

      expect(allOutput()).toContain('Created subscription');

      const { db, bus } = await openBus();
      const subs = await bus.listSubscriptions('fiscus');
      await db.close?.();
      expect(subs).toHaveLength(1);
      expect(subs[0].signalType).toBe('campaign.*');
      expect(subs[0].handler).toBe('handleCampaign');
    });

    it('sets exit code on error', async () => {
      getPackageConfigMock.mockReturnValueOnce({ database: {} });
      await requireCommandHandler(dispatchCommands['dispatch:subscribe'])(
        ['campaign.*', 'fiscus'],
        { handler: 'handleDispatch' },
      );
      expect(process.exitCode).toBe(1);
    });
  });

  describe('dispatch:unsubscribe', () => {
    it('exits when args are missing', async () => {
      await expect(
        requireCommandHandler(dispatchCommands['dispatch:unsubscribe'])(
          ['only-one'],
          {},
        ),
      ).rejects.toThrow('process.exit called');
    });

    it('removes a subscription', async () => {
      const { db, bus } = await openBus();
      await bus.subscribe({ signalType: 'campaign.*', subscriber: 'fiscus' });
      await db.close?.();

      await requireCommandHandler(dispatchCommands['dispatch:unsubscribe'])(
        ['campaign.*', 'fiscus'],
        {},
      );

      expect(allOutput()).toContain('Removed subscription');

      const probe = await openBus();
      const subs = await probe.bus.listSubscriptions('fiscus');
      await probe.db.close?.();
      expect(subs).toHaveLength(0);
    });

    it('sets exit code on error', async () => {
      getPackageConfigMock.mockReturnValueOnce({ database: {} });
      await requireCommandHandler(dispatchCommands['dispatch:unsubscribe'])(
        ['campaign.*', 'fiscus'],
        {},
      );
      expect(process.exitCode).toBe(1);
    });
  });
});
