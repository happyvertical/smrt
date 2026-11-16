/**
 * #4944: a stop() that overlaps start() must not leave anything running.
 *
 * start() awaits the liveness thread's handshake after it has marked the
 * runner running. A stop() in that window used to find no thread, release the
 * lease and resolve; start() then stored the thread (which kept renewing the
 * stopped runner's lease) and started polling, the heartbeat and the retention
 * sweeper after stop() had returned.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRunner, type TaskRunner } from '../runner.js';
import { isLiveWorker } from '../worker-liveness.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RunnerInternals {
  workerKey: string;
  livenessWorker: Worker | null;
  leaseTimer: unknown;
  pollTimer: unknown;
  heartbeatTimer: unknown;
  retentionSweeper: unknown;
  startLivenessThread: (plan: unknown) => Promise<unknown>;
  prepareTerminalOutcomeStorage: () => Promise<void>;
}

const dbPaths: string[] = [];
const runners: TaskRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  for (const path of dbPaths.splice(0)) {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        // best-effort temp cleanup
      }
    }
  }
});

async function fileRunner(name: string): Promise<{
  db: DatabaseInterface;
  runner: TaskRunner;
  internals: RunnerInternals;
}> {
  const path = join(tmpdir(), `${name}-${randomUUID()}.db`);
  dbPaths.push(path);
  // A file database, so start() takes the off-loop liveness thread path.
  const db = await getTestDatabase({ type: 'sqlite', url: `file:${path}` });
  const runner = createTaskRunner({
    pollInterval: 1_000,
    leaseTickMs: 40,
    leaseTtlMs: 10_000,
    // Keep the default sweeper on: it must not outlive stop() either.
  });
  await runner.initialize(db);
  runners.push(runner);
  return { db, runner, internals: runner as unknown as RunnerInternals };
}

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

/**
 * Wait until the stop resolves, or a bounded time when a correct stop() is
 * (rightly) waiting on the start that is held open below.
 */
async function settleOrWait(stopping: Promise<void>): Promise<void> {
  await Promise.race([stopping, sleep(500)]);
}

function expectFullyStopped(runner: TaskRunner, internals: RunnerInternals) {
  expect(runner.isRunning()).toBe(false);
  expect(internals.livenessWorker).toBeNull();
  expect(internals.leaseTimer).toBeNull();
  expect(internals.pollTimer).toBeNull();
  expect(internals.heartbeatTimer).toBeNull();
  expect(internals.retentionSweeper).toBeNull();
  expect(isLiveWorker(internals.workerKey)).toBe(false);
}

describe('stop() overlapping start() (#4944)', () => {
  it('a stop during the liveness handshake waits for it and retires the thread', async () => {
    const { db, runner, internals } = await fileRunner('start-stop-handshake');
    const startThread = internals.startLivenessThread.bind(runner);
    let stopping: Promise<void> | null = null;
    let spawned: Worker | null = null;
    internals.startLivenessThread = async (plan) => {
      // The stop lands after start() marked the runner running and before the
      // handshake settles; hold the handshake until that stop has had every
      // chance to finish on its own.
      stopping = runner.stop();
      await settleOrWait(stopping);
      const result = await startThread(plan);
      spawned = internals.livenessWorker;
      return result;
    };

    let started = 0;
    let stopped = 0;
    runner.on('runner:started', () => started++);
    runner.on('runner:stopped', () => stopped++);

    await runner.start();
    expect(stopping).not.toBeNull();
    await stopping;

    expect(spawned).not.toBeNull();
    const thread = spawned as unknown as Worker;
    expectFullyStopped(runner, internals);
    // The thread exited (threadId is -1 once a worker has stopped).
    expect(thread.threadId).toBe(-1);
    expect(started).toBe(0);
    expect(stopped).toBe(1);

    // Nothing renews the stopped runner's lease any more.
    const atStop = await readLease(db, internals.workerKey);
    await sleep(200);
    expect(await readLease(db, internals.workerKey)).toBe(atStop);

    // The runner can be started again afterwards (without the hook above).
    delete (internals as Partial<RunnerInternals>).startLivenessThread;
    await runner.start();
    expect(runner.isRunning()).toBe(true);
    await runner.stop();
    expectFullyStopped(runner, internals);
  });

  it('a stop before start() registers anything leaves nothing registered', async () => {
    const { db, runner, internals } = await fileRunner('start-stop-early');
    const prepare = internals.prepareTerminalOutcomeStorage.bind(runner);
    let stopping: Promise<void> | null = null;
    internals.prepareTerminalOutcomeStorage = async () => {
      stopping = runner.stop();
      await settleOrWait(stopping);
      await prepare();
    };

    await runner.start();
    await stopping;

    expectFullyStopped(runner, internals);
    // start() never registered this incarnation's lease row.
    expect(await readLease(db, internals.workerKey)).toBeNull();
  });

  it('overlapping start() calls share one start, overlapping stop() calls one stop', async () => {
    const { runner, internals } = await fileRunner('start-stop-shared');
    let threads = 0;
    const startThread = internals.startLivenessThread.bind(runner);
    internals.startLivenessThread = async (plan) => {
      threads++;
      return startThread(plan);
    };
    let started = 0;
    let stopped = 0;
    runner.on('runner:started', () => started++);
    runner.on('runner:stopped', () => stopped++);

    await Promise.all([runner.start(), runner.start()]);
    expect(threads).toBe(1);
    expect(started).toBe(1);

    const first = runner.stop();
    const second = runner.stop();
    // The second stop must not resolve before the first has torn down.
    await second;
    expectFullyStopped(runner, internals);
    await first;
    expect(stopped).toBe(1);
  });

  it('a start() while a stop() drains is refused, not run alongside it', async () => {
    const { runner, internals } = await fileRunner('start-during-stop');
    await runner.start();
    const stopping = runner.stop();
    await expect(runner.start()).rejects.toThrow(/still draining/);
    await stopping;
    expectFullyStopped(runner, internals);
  });
});
