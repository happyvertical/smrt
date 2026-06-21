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

  describe('dispatch:list', () => {
    it('reports when no dispatches are found', async () => {
      await dispatchCommands['dispatch:list'].handler([], {});
      expect(allOutput()).toContain('No dispatches found.');
    });

    it('renders a table of dispatches', async () => {
      const { db, bus } = await openBus();
      await bus.emit('campaign.completed', { x: 1 }, { source: 'suasor' });
      await bus.emit('order.created', { y: 2 }, { source: 'commerce' });
      await db.close?.();

      await dispatchCommands['dispatch:list'].handler([], {});

      const out = allOutput();
      expect(out).toContain('Found 2 dispatch(es)');
      expect(out).toContain('campaign.completed');
      expect(out).toContain('order.created');
    });

    it('supports JSON output and status filtering', async () => {
      const { db, bus } = await openBus();
      await bus.emit('a.event', {}, { source: 's1' });
      await db.close?.();

      await dispatchCommands['dispatch:list'].handler([], {
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
      await dispatchCommands['dispatch:list'].handler([], {});
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('dispatch:process', () => {
    it('exits when subscriber is missing', async () => {
      await expect(
        dispatchCommands['dispatch:process'].handler([], {}),
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

      await dispatchCommands['dispatch:process'].handler([], {
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

      await dispatchCommands['dispatch:process'].handler([], {
        subscriber: 'fiscus',
      });

      const out = allOutput();
      expect(out).toContain('Processing dispatches for "fiscus"');
      expect(out).toMatch(/Processed \d+ dispatch/);
    });

    it('sets exit code on error', async () => {
      getPackageConfigMock.mockReturnValueOnce({ database: {} });
      await dispatchCommands['dispatch:process'].handler([], {
        subscriber: 'fiscus',
      });
      expect(process.exitCode).toBe(1);
    });
  });

  describe('dispatch:retry', () => {
    it('resets failed dispatches to pending', async () => {
      await dispatchCommands['dispatch:retry'].handler([], {
        'max-attempts': 5,
        type: 'campaign.completed',
      });
      expect(allOutput()).toMatch(/Reset \d+ failed dispatch/);
    });

    it('uses defaults when options omitted', async () => {
      await dispatchCommands['dispatch:retry'].handler([], {});
      expect(allOutput()).toMatch(/Reset \d+ failed dispatch/);
    });

    it('sets exit code on error', async () => {
      getPackageConfigMock.mockReturnValueOnce({ database: {} });
      await dispatchCommands['dispatch:retry'].handler([], {});
      expect(process.exitCode).toBe(1);
    });
  });

  describe('dispatch:cleanup', () => {
    it('dry-run reports current counts', async () => {
      const { db, bus } = await openBus();
      await bus.emit('a.event', {}, { source: 's1' });
      await db.close?.();

      await dispatchCommands['dispatch:cleanup'].handler([], {
        dry: true,
        'completed-older-than': 15,
        'failed-older-than': 7,
      });

      const out = allOutput();
      expect(out).toContain('Current counts');
      expect(out).toContain('Would delete completed older than 15 days');
      expect(out).toContain('Would delete failed older than 7 days');
    });

    it('performs cleanup and reports deleted counts', async () => {
      await dispatchCommands['dispatch:cleanup'].handler([], {});
      const out = allOutput();
      expect(out).toContain('Cleanup complete');
      expect(out).toContain('Completed deleted:');
      expect(out).toContain('Failed deleted:');
    });

    it('sets exit code on error', async () => {
      getPackageConfigMock.mockReturnValueOnce({ database: {} });
      await dispatchCommands['dispatch:cleanup'].handler([], {});
      expect(process.exitCode).toBe(1);
    });
  });

  describe('dispatch:subscriptions', () => {
    it('reports when no subscriptions exist', async () => {
      await dispatchCommands['dispatch:subscriptions'].handler([], {});
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

      await dispatchCommands['dispatch:subscriptions'].handler([], {});

      const out = allOutput();
      expect(out).toContain('Found 1 subscription(s)');
      expect(out).toContain('fiscus');
      expect(out).toContain('campaign.*');
    });

    it('supports JSON output', async () => {
      const { db, bus } = await openBus();
      await bus.subscribe({ signalType: 'x.y', subscriber: 's1' });
      await db.close?.();

      await dispatchCommands['dispatch:subscriptions'].handler([], {
        json: true,
      });

      const parsed = JSON.parse(allOutput());
      expect(parsed).toHaveLength(1);
    });

    it('sets exit code on error', async () => {
      getPackageConfigMock.mockReturnValueOnce({ database: {} });
      await dispatchCommands['dispatch:subscriptions'].handler([], {});
      expect(process.exitCode).toBe(1);
    });
  });

  describe('dispatch:subscribe', () => {
    it('exits when args are missing', async () => {
      await expect(
        dispatchCommands['dispatch:subscribe'].handler(['only-one'], {}),
      ).rejects.toThrow('process.exit called');
    });

    it('creates a subscription', async () => {
      await dispatchCommands['dispatch:subscribe'].handler(
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
      await dispatchCommands['dispatch:subscribe'].handler(
        ['campaign.*', 'fiscus'],
        { handler: 'handleDispatch' },
      );
      expect(process.exitCode).toBe(1);
    });
  });

  describe('dispatch:unsubscribe', () => {
    it('exits when args are missing', async () => {
      await expect(
        dispatchCommands['dispatch:unsubscribe'].handler(['only-one'], {}),
      ).rejects.toThrow('process.exit called');
    });

    it('removes a subscription', async () => {
      const { db, bus } = await openBus();
      await bus.subscribe({ signalType: 'campaign.*', subscriber: 'fiscus' });
      await db.close?.();

      await dispatchCommands['dispatch:unsubscribe'].handler(
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
      await dispatchCommands['dispatch:unsubscribe'].handler(
        ['campaign.*', 'fiscus'],
        {},
      );
      expect(process.exitCode).toBe(1);
    });
  });
});
