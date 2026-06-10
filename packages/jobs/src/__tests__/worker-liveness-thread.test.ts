import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRunner } from '../runner.js';
import { SmrtWorkerCollection } from '../smrt-worker.js';
import { runLivenessTicker } from '../worker-liveness-ticker.js';

function tmpDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readLease(
  db: DatabaseInterface,
  workerKey: string,
): Promise<string | null> {
  const result = await db.query(
    'SELECT lease_expires_at FROM _smrt_workers WHERE worker_id = ?',
    workerKey,
  );
  const row = result.rows[0] as { lease_expires_at?: string } | undefined;
  return row?.lease_expires_at ?? null;
}

const dbPaths: string[] = [];
afterEach(() => {
  for (const path of dbPaths.splice(0)) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // best-effort temp cleanup
    }
  }
});

describe('off-loop liveness (Stage 2)', () => {
  it('runLivenessTicker renews the lease on its own connection and stops on stop()', async () => {
    const dbUrl = tmpDbUrl('liveness-ticker');
    dbPaths.push(dbUrl.replace('file:', ''));
    const seed = await getTestDatabase({ type: 'sqlite', url: dbUrl });
    const workers = await SmrtWorkerCollection.create({ db: seed });
    await workers.registerWorker({ workerKey: 'tick-w', leaseTtlMs: 10_000 });

    const before = await readLease(seed, 'tick-w');

    const ticker = await runLivenessTicker({
      url: dbUrl,
      type: 'sqlite',
      workerKey: 'tick-w',
      leaseTtlMs: 10_000,
      leaseTickMs: 40,
    });

    await sleep(180);
    const renewed = await readLease(seed, 'tick-w');
    expect(renewed).not.toBeNull();
    expect(renewed && before && renewed > before).toBe(true);

    await ticker.stop();
    const atStop = await readLease(seed, 'tick-w');
    await sleep(180);
    const afterStop = await readLease(seed, 'tick-w');
    // No further renewal once the ticker is stopped.
    expect(afterStop).toBe(atStop);
  });

  it('TaskRunner spawns the off-loop thread on a file database and renews off the main loop', async () => {
    const dbUrl = tmpDbUrl('liveness-runner');
    dbPaths.push(dbUrl.replace('file:', ''));
    const db = await getTestDatabase({ type: 'sqlite', url: dbUrl });

    const runner = createTaskRunner({
      pollInterval: 1_000,
      leaseTickMs: 40,
      leaseTtlMs: 10_000,
    });
    await runner.initialize(db);
    await runner.start();

    try {
      // The thread (not the main-loop fallback) should be the active renewer.
      expect(
        (runner as unknown as { livenessWorker: unknown }).livenessWorker,
      ).not.toBeNull();

      const workerKey = (runner as unknown as { workerKey: string }).workerKey;
      const before = await readLease(db, workerKey);
      await sleep(180);
      const after = await readLease(db, workerKey);
      expect(after && before && after > before).toBe(true);
    } finally {
      await runner.stop();
    }

    // After a clean stop the thread is gone.
    expect(
      (runner as unknown as { livenessWorker: unknown }).livenessWorker,
    ).toBeNull();
  });

  it('resolves the worker-thread entry to an existing built file', async () => {
    const resolved = (
      import.meta as unknown as { resolve(s: string): string }
    ).resolve('@happyvertical/smrt-jobs/worker-liveness-thread');
    expect(resolved).toContain('worker-liveness-thread');
    expect(existsSync(new URL(resolved))).toBe(true);
  });

  it('falls back to main-loop renewal when the liveness thread dies', async () => {
    const dbUrl = tmpDbUrl('liveness-fallback');
    dbPaths.push(dbUrl.replace('file:', ''));
    const db = await getTestDatabase({ type: 'sqlite', url: dbUrl });

    const runner = createTaskRunner({
      pollInterval: 1_000,
      leaseTickMs: 40,
      leaseTtlMs: 10_000,
    });
    await runner.initialize(db);
    await runner.start();

    try {
      const internals = runner as unknown as {
        livenessWorker: { terminate(): Promise<number> } | null;
        leaseTimer: unknown;
        workerKey: string;
      };
      expect(internals.livenessWorker).not.toBeNull();
      expect(internals.leaseTimer).toBeNull();

      // Simulate the thread dying: terminate it; the 'exit' handler should
      // start main-loop renewal.
      await internals.livenessWorker?.terminate();

      // Wait for the exit event + fallback to engage.
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && internals.leaseTimer === null) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(internals.livenessWorker).toBeNull();
      expect(internals.leaseTimer).not.toBeNull();

      // The lease keeps advancing under main-loop renewal.
      const before = await readLease(db, internals.workerKey);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const after = await readLease(db, internals.workerKey);
      expect(after && before && after > before).toBe(true);
    } finally {
      await runner.stop();
    }
  });
});
