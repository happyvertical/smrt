/**
 * PostgreSQL lane for the claim limit (#3145, #3105).
 *
 * The old claim was `UPDATE … WHERE id IN (SELECT … LIMIT ? FOR UPDATE SKIP
 * LOCKED)`. With planner statistics that show no pending rows (the normal
 * state of a drained queue) PostgreSQL picks a nested-loop semi join and
 * rescans the LIMIT subquery for every outer pending row. Each rescan skips the
 * row the statement just updated and yields the next one, so one claim took
 * the whole FIFO backlog: a `concurrency: 1` runner started every ready job at
 * once. SQLite never plans it that way, so only this lane can prove the fix.
 *
 * Each test first proves the hazard is live in this database (the legacy
 * statement over-claims here), then that the shipped claims do not.
 */
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backgroundEligible } from '../background-policy.js';
import { ForgeDeliveryCollection } from '../forge-projection.js';
import { createTaskRunner, type TaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

const BACKLOG = 5;
const TENANT = '33333333-3333-4333-8333-333333333333';

let active = 0;
let peak = 0;
let probeDb: DatabaseInterface | null = null;
let peakRunningRows = 0;

@smrt()
class ClaimLimitProbe extends SmrtObject {
  @backgroundEligible()
  async build(): Promise<string> {
    active += 1;
    peak = Math.max(peak, active);
    try {
      if (probeDb) {
        const running = await probeDb.query(
          "SELECT COUNT(*) AS count FROM _smrt_jobs WHERE status = 'running'",
        );
        peakRunningRows = Math.max(
          peakRunningRows,
          Number((running.rows[0] as { count: number | string }).count),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      return 'built';
    } finally {
      active -= 1;
    }
  }
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

async function count(db: DatabaseInterface, sql: string): Promise<number> {
  const [row] = rows<{ count: number | string }>(await db.query(sql));
  return Number(row?.count ?? 0);
}

describePostgres('claim limit on PostgreSQL (#3145, #3105)', () => {
  const connections: DatabaseInterface[] = [];
  const runners: TaskRunner[] = [];
  let admin: DatabaseInterface | undefined;
  let baseUrl = '';
  let databaseName = '';
  let db: DatabaseInterface;
  let jobs: SmrtJobCollection;
  const objectType = () =>
    ObjectRegistry.getClass('ClaimLimitProbe')?.qualifiedName ||
    'ClaimLimitProbe';

  beforeEach(async () => {
    baseUrl = process.env.DATABASE_URL ?? '';
    admin = await getTestDatabase({
      type: 'postgres',
      url: baseUrl,
      classes: [],
      includeSystemTables: false,
    });
    // Runners commit across connections (the liveness ticker opens its own),
    // so each test gets a database of its own.
    databaseName = `smrt_claim_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(baseUrl);
    url.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = url.toString();
    db = await getTestDatabase({
      type: 'postgres',
      url: url.toString(),
      classes: [
        'ClaimLimitProbe',
        'ForgeDelivery',
        'SmrtJob',
        'SmrtJobEvent',
        'SmrtWorker',
      ],
    });
    connections.push(db);
    jobs = await SmrtJobCollection.create({ db });
    active = 0;
    peak = 0;
    peakRunningRows = 0;
    probeDb = db;
  });

  afterEach(async () => {
    for (const runner of runners.splice(0)) await runner.stop();
    probeDb = null;
    for (const conn of connections.splice(0)) {
      await (conn as { close?: () => Promise<void> }).close?.();
    }
    process.env.DATABASE_URL = baseUrl;
    await admin?.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await (admin as { close?: () => Promise<void> } | undefined)?.close?.();
  });

  /**
   * History, then planner stats with zero pending rows, then a FIFO backlog
   * enqueued one row at a time — the production shape that yields the
   * nested-loop semi join.
   */
  async function seedBacklog(queue: string): Promise<void> {
    for (let i = 0; i < 40; i += 1) {
      const done = await jobs.create({
        queue,
        objectType: objectType(),
        method: 'build',
        runAt: new Date(Date.now() - 86_400_000),
      });
      await done.save();
    }
    await db.query(`UPDATE _smrt_jobs SET status = 'completed'`);
    await db.query('ANALYZE _smrt_jobs');
    const start = Date.now() - 60_000;
    for (let i = 0; i < BACKLOG; i += 1) {
      const job = await jobs.create({
        queue,
        objectType: objectType(),
        method: 'build',
        runAt: new Date(start + i * 1_000),
        priority: 80,
        maxAttempts: 3,
      });
      await job.save();
    }
  }

  /**
   * Run the pre-fix claim statement, count what it took, then undo it. (Not a
   * BEGIN/ROLLBACK: the adapter pools connections, so a transaction opened by
   * one `query()` is not guaranteed to hold the next.)
   */
  async function legacyClaimCount(queue: string): Promise<number> {
    const claimed = await db.query(
      `UPDATE _smrt_jobs
          SET status = 'running', worker_id = 'legacy', attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM _smrt_jobs
           WHERE status = 'pending' AND run_at <= $1 AND queue IN ($2)
           ORDER BY priority DESC, run_at ASC, created_at ASC, id ASC
           LIMIT 1 FOR UPDATE SKIP LOCKED)
          AND status = 'pending'
        RETURNING id`,
      new Date().toISOString(),
      queue,
    );
    await db.query(
      `UPDATE _smrt_jobs
          SET status = 'pending', worker_id = NULL, attempts = attempts - 1
        WHERE worker_id = 'legacy'`,
    );
    return rows(claimed).length;
  }

  it('claims at most `limit` jobs from a FIFO backlog', async () => {
    await seedBacklog('deploys');
    expect(await legacyClaimCount('deploys')).toBeGreaterThan(1);

    const first = await jobs.claimReady({
      workerId: 'worker-a',
      queues: ['deploys'],
      limit: 1,
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe('running');
    expect(first[0]?.attempts).toBe(1);

    const next = await jobs.claimReady({
      workerId: 'worker-b',
      queues: ['deploys'],
      limit: 2,
    });
    expect(next).toHaveLength(2);
    expect(next.map((job) => job.id)).not.toContain(first[0]?.id);

    expect(
      await count(
        db,
        "SELECT COUNT(*) AS count FROM _smrt_jobs WHERE status = 'running'",
      ),
    ).toBe(3);
    expect(
      await count(
        db,
        "SELECT COUNT(*) AS count FROM _smrt_jobs WHERE status = 'pending'",
      ),
    ).toBe(BACKLOG - 3);
  });

  it('never runs more than `concurrency` jobs, including across a restart', async () => {
    await seedBacklog('deploys');
    expect(await legacyClaimCount('deploys')).toBeGreaterThan(1);

    const startRunner = async () => {
      const runner = createTaskRunner({
        concurrency: 1,
        queues: ['deploys'],
        pollInterval: 20,
        retention: false,
      });
      runners.push(runner);
      await runner.initialize(db);
      await runner.start();
      return runner;
    };
    const completedCount = () =>
      count(
        db,
        "SELECT COUNT(*) AS count FROM _smrt_jobs WHERE status = 'completed' AND attempts > 0",
      );
    const waitFor = async (predicate: () => Promise<boolean>) => {
      const deadline = Date.now() + 20_000;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error('timed out');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };

    const first = await startRunner();
    await waitFor(async () => (await completedCount()) >= 2);
    await first.stop();
    runners.splice(runners.indexOf(first), 1);

    // A new incarnation (a pod restart) must resume one job at a time.
    await startRunner();
    await waitFor(async () => (await completedCount()) >= BACKLOG);

    expect(peak).toBe(1);
    expect(peakRunningRows).toBe(1);
    const [attempts] = rows<{ max: number | string }>(
      await db.query(
        'SELECT MAX(attempts) AS max FROM _smrt_jobs WHERE attempts > 0',
      ),
    );
    expect(Number(attempts?.max)).toBe(1);
  });

  it('releases rows a claim returns beyond the free slots', async () => {
    await seedBacklog('deploys');
    const runner = createTaskRunner({
      concurrency: 1,
      queues: ['deploys'],
      pollInterval: 60_000,
      retention: false,
    });
    runners.push(runner);
    await runner.initialize(db);
    // Stand in for a claim that over-returns (the pre-fix PostgreSQL
    // behaviour) to prove the runner cap does not depend on the claim SQL.
    const collection = (runner as unknown as { collection: SmrtJobCollection })
      .collection;
    const realClaim = collection.claimReady.bind(collection);
    collection.claimReady = (options) =>
      realClaim({ ...options, limit: BACKLOG });
    const errors: Error[] = [];
    runner.on('runner:error', (error) => errors.push(error));
    await runner.start();
    const deadline = Date.now() + 20_000;
    while (
      peak === 0 ||
      (await count(
        db,
        "SELECT COUNT(*) AS count FROM _smrt_jobs WHERE status = 'pending'",
      )) !==
        BACKLOG - 1
    ) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(peak).toBe(1);
    expect(runner.activeJobCount()).toBeLessThanOrEqual(1);
    expect(
      await count(
        db,
        "SELECT COUNT(*) AS count FROM _smrt_jobs WHERE status = 'pending' AND attempts = 0 AND worker_id IS NULL AND started_at IS NULL",
      ),
    ).toBe(BACKLOG - 1);
    expect(
      errors.some((error) =>
        /beyond the concurrency limit/.test(error.message),
      ),
    ).toBe(true);
  });

  it('retries a failed surplus release on the next poll', async () => {
    await seedBacklog('deploys');
    const runner = createTaskRunner({
      concurrency: 1,
      queues: ['deploys'],
      pollInterval: 20,
      retention: false,
    });
    runners.push(runner);
    await runner.initialize(db);
    const collection = (runner as unknown as { collection: SmrtJobCollection })
      .collection;
    const realClaim = collection.claimReady.bind(collection);
    collection.claimReady = (options) =>
      realClaim({ ...options, limit: BACKLOG });
    const realQuery = db.query.bind(db);
    let failedOnce = false;
    const spy = vi.spyOn(db, 'query').mockImplementation(((
      sql: string,
      ...params: unknown[]
    ) => {
      if (!failedOnce && /SET status = 'pending'/.test(sql)) {
        failedOnce = true;
        return Promise.reject(new Error('injected release failure'));
      }
      return realQuery(sql, ...params);
    }) as typeof db.query);
    const errors: Error[] = [];
    runner.on('runner:error', (error) => errors.push(error));
    try {
      await runner.start();
      const deadline = Date.now() + 20_000;
      while (
        (await count(
          db,
          "SELECT COUNT(*) AS count FROM _smrt_jobs WHERE status = 'completed' AND attempts > 0",
        )) < BACKLOG
      ) {
        if (Date.now() > deadline) throw new Error('timed out');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      spy.mockRestore();
    }

    expect(failedOnce).toBe(true);
    expect(
      errors.some((error) => error.message === 'injected release failure'),
    ).toBe(true);
    expect(peak).toBe(1);
    const [attempts] = rows<{ max: number | string }>(
      await db.query(
        'SELECT MAX(attempts) AS max FROM _smrt_jobs WHERE attempts > 0',
      ),
    );
    expect(Number(attempts?.max)).toBe(1);
  });

  it('leases exactly one forge delivery per claim from a backlog', async () => {
    const inbox = await ForgeDeliveryCollection.create({ db });
    for (let i = 0; i < 40; i += 1) {
      await withTenant({ tenantId: TENANT }, () =>
        inbox.accept({
          provider: 'github',
          deliveryId: `history-${i}`,
          installationKey: 'installation:42',
          repositoryKey: 'happyvertical/example',
          eventName: 'push',
          payload: { i },
        }),
      );
    }
    await db.query(`UPDATE _smrt_forge_deliveries SET status = 'completed'`);
    await db.query('ANALYZE _smrt_forge_deliveries');
    const start = Date.now() - 60_000;
    for (let i = 0; i < BACKLOG; i += 1) {
      await withTenant({ tenantId: TENANT }, () =>
        inbox.accept({
          provider: 'github',
          deliveryId: `backlog-${i}`,
          installationKey: 'installation:42',
          repositoryKey: 'happyvertical/example',
          eventName: 'push',
          payload: { i },
          receivedAt: new Date(start + i * 1_000),
        }),
      );
    }

    const claimed = await inbox.claimReady({
      workerId: 'forge-a',
      leaseMs: 60_000,
    });
    expect(claimed?.leaseToken).toBeTruthy();
    expect(
      await count(
        db,
        "SELECT COUNT(*) AS count FROM _smrt_forge_deliveries WHERE status = 'leased'",
      ),
    ).toBe(1);
  });
});
