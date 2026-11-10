/**
 * #2994 native PostgreSQL contract: observed cross-process slot contention,
 * tenant/global isolation, caller rollback and public terminal retry.
 * Requires built public Jobs/Core/Tenancy packages for plain Node children.
 * No lifecycle SQL, source loader, mocked transaction or arbitrary sleep proves overlap.
 */
import { type ChildProcess, fork } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtJobCollection } from '../smrt-job.js';
import { SmrtJobDedupeSlot } from '../smrt-job-dedupe-slot.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;
const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const timeout = 60_000;
const queue = 'dedupe-postgres-overlap';
const data = {
  objectType: 'DedupePostgresProbe',
  method: 'run',
  queue,
  dedupeKey: 'same-resource-in-flight',
  args: { original: 'first producer', revision: 1 },
};
interface Produced {
  type: 'done';
  id: string;
  tenantId: string;
  status: string;
  dedupeKey: string;
  args: Record<string, unknown>;
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Failures can occur while the parent is observing a physical database lock.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
interface Producer {
  child: ChildProcess;
  ready: Promise<void>;
  done: Promise<Produced>;
  go(): void;
  stop(): Promise<void>;
}
function producer(
  url: string,
  applicationName: string,
  args: Record<string, unknown>,
): Producer {
  const env: NodeJS.ProcessEnv = {};
  // No NODE_OPTIONS, Vitest hooks, loader args, credentials or ambient tenant state inherited.
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'CI_TEST_TMPDIR',
    'NODE_COMPILE_CACHE',
    'LD_LIBRARY_PATH',
    'TZ',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = fork(
    new URL('./job-dedupe-postgres-producer.mjs', import.meta.url),
    [],
    {
      execArgv: [],
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  const ready = deferred<void>(),
    done = deferred<Produced>(),
    exited = deferred<void>();
  let receivedDone = false,
    hasExited = false,
    exitCode: number | null = null;
  child.on('message', (message) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    if (message.type === 'ready') ready.resolve();
    else if (message.type === 'done') {
      receivedDone = true;
      done.resolve(message as Produced);
    } else if (message.type === 'fatal') {
      const detail = message as {
        phase?: string;
        name?: string;
        code?: string;
      };
      const failure = new Error(
        `Public producer failed (${detail.phase}/${detail.name}/${detail.code ?? 'no-code'})`,
      );
      ready.reject(failure);
      done.reject(failure);
    }
  });
  child.on('error', () => {
    const failure = new Error('Plain Node producer could not start');
    ready.reject(failure);
    done.reject(failure);
    hasExited = true;
    exited.resolve();
  });
  child.on('exit', (code, signal) => {
    hasExited = true;
    exitCode = code;
    exited.resolve();
    if (!receivedDone || code !== 0) {
      const failure = new Error(
        `Public producer exited before successful completion (${code}/${signal})`,
      );
      ready.reject(failure);
      done.reject(failure);
    }
  });
  const completed = Promise.all([done.promise, exited.promise]).then(
    ([result]) => {
      if (exitCode !== 0)
        throw new Error('Public producer did not exit cleanly');
      return result;
    },
  );
  void completed.catch(() => {});
  child.send({
    type: 'init',
    url,
    applicationName,
    tenantId: tenantA,
    queue,
    dedupeKey: data.dedupeKey,
    args,
  });
  return {
    child,
    ready: bounded(ready.promise, 15_000, 'Public producer never became ready'),
    done: completed,
    go: () => {
      child.send({ type: 'go' });
    },
    stop: async () => {
      if (hasExited) return;
      child.kill('SIGTERM');
      try {
        await bounded(
          exited.promise,
          1_000,
          'Producer needs forced termination',
        );
      } catch {
        child.kill('SIGKILL');
        await bounded(exited.promise, 2_000, 'Owned producer did not exit');
      }
    },
  };
}

describePostgres(
  'store dedupe across real PostgreSQL Node processes (#2994)',
  () => {
    let admin: DatabaseInterface | undefined,
      db: DatabaseInterface,
      blocker: DatabaseInterface;
    let jobs: SmrtJobCollection,
      databaseName = '',
      url = '';
    const children: Producer[] = [];
    beforeEach(async () => {
      // Make registration explicit before asking the public test-schema builder for its closure.
      expect(SmrtJobDedupeSlot).toBeDefined();
      const baseUrl = process.env.DATABASE_URL ?? '';
      admin = await getTestDatabase({
        type: 'postgres',
        url: baseUrl,
        classes: [],
        includeSystemTables: false,
      });
      const role = (
        await admin.query(
          'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
        )
      ).rows[0];
      expect(
        role.rolsuper,
        'Use the documented non-superuser CI PostgreSQL role',
      ).toBe(false);
      databaseName = `smrt_dedupe_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const target = new URL(baseUrl);
      target.pathname = `/${databaseName}`;
      url = target.toString();
      db = await getTestDatabase({
        type: 'postgres',
        url,
        classes: ['SmrtJob', 'SmrtJobDedupeSlot'],
      });
      jobs = await SmrtJobCollection.create({ db });
      target.searchParams.set(
        'application_name',
        `dedupe-parent-${databaseName}`,
      );
      blocker = await getTestDatabase({
        type: 'postgres',
        url: target.toString(),
        classes: [],
        includeSystemTables: false,
      });
    }, timeout);
    afterEach(async () => {
      const failures: unknown[] = [];
      for (const child of children.splice(0)) {
        try {
          await child.stop();
        } catch (error) {
          failures.push(error);
        }
      }
      for (const connection of [blocker, db]) {
        try {
          await connection?.close?.();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        if (admin && databaseName)
          await admin.query(
            `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
          );
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await admin?.close?.();
        } catch (error) {
          failures.push(error);
        }
      }
      databaseName = '';
      admin = undefined;
      if (failures.length)
        throw new AggregateError(
          failures,
          'Owned producer/database cleanup failed',
        );
    }, timeout);

    async function waitForLock(
      applicationName: string,
      advisory: boolean,
      owner?: number,
    ) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const result = await db.query(
          `SELECT pid, wait_event FROM pg_stat_activity
        WHERE datname=? AND application_name=? AND wait_event_type='Lock'
        ${advisory ? "AND wait_event='advisory'" : "AND query LIKE '%_smrt_job_dedupe_slots%' AND CAST(? AS INTEGER)=ANY(pg_blocking_pids(pid))"}`,
          databaseName,
          applicationName,
          ...(advisory ? [] : [owner]),
        );
        if (result.rows.length) return Number(result.rows[0].pid);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        advisory
          ? 'First producer never waited on the held advisory barrier'
          : 'Second producer never waited on the first producer dedupe-slot lock',
      );
    }
    const pointers = () =>
      db.query('SELECT job_id FROM _smrt_job_dedupe_slots ORDER BY job_id');

    it(
      'physically overlaps two plain Node enqueues and keeps the original row, args and pointer',
      async () => {
        if (!blocker.transaction)
          throw new Error('PostgreSQL transactions required');
        const barrierA = randomInt(1, 1_000_000_000),
          barrierB = randomInt(1, 1_000_000_000);
        await db.query(`CREATE FUNCTION smrt_dedupe_test_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.queue='${queue}' THEN PERFORM pg_advisory_xact_lock(${barrierA},${barrierB}); END IF;
      RETURN NEW; END $$`);
        await db.query(`CREATE TRIGGER smrt_dedupe_test_barrier BEFORE INSERT ON _smrt_jobs
      FOR EACH ROW EXECUTE FUNCTION smrt_dedupe_test_barrier()`);
        const firstName = `dedupe-first-${databaseName}`,
          secondName = `dedupe-second-${databaseName}`;
        const first = producer(url, firstName, data.args),
          second = producer(url, secondName, {
            original: 'later contender',
            revision: 99,
          });
        children.push(first, second);
        await Promise.all([first.ready, second.ready]);
        await blocker.transaction(async (tx) => {
          await tx.query(
            'SELECT pg_advisory_xact_lock(CAST(? AS INTEGER),CAST(? AS INTEGER))',
            barrierA,
            barrierB,
          );
          first.go();
          const firstBackend = await Promise.race([
            waitForLock(firstName, true),
            first.done.then(() => {
              throw new Error(
                'First producer completed before the barrier was observed',
              );
            }),
          ]);
          second.go();
          await Promise.race([
            waitForLock(secondName, false, firstBackend),
            second.done.then(() => {
              throw new Error(
                'Second producer completed before a dedupe-slot lock was observed',
              );
            }),
          ]);
        });
        const [left, right] = await bounded(
          Promise.all([first.done, second.done]),
          15_000,
          'Public producers did not finish after barrier release',
        );
        expect(left.id).toBe(right.id);
        expect(left.args).toEqual(data.args);
        expect(right.args).toEqual(data.args);
        expect(left).toMatchObject({
          tenantId: tenantA,
          status: 'pending',
          dedupeKey: data.dedupeKey,
        });
        const stored = await jobs.get({ id: left.id }, { cache: false });
        expect(stored?.args).toEqual(data.args);
        expect(stored?.status).toBe('pending');
        const rows = await db.query(
          'SELECT id,tenant_id,status,dedupe_key FROM _smrt_jobs',
        );
        expect(rows.rows).toEqual([
          expect.objectContaining({
            id: left.id,
            tenant_id: tenantA,
            status: 'pending',
            dedupe_key: data.dedupeKey,
          }),
        ]);
        expect((await pointers()).rows).toEqual([{ job_id: left.id }]);
      },
      timeout,
    );

    it(
      'partitions a caller key by canonical tenant and global namespace, denying a forged tenant',
      async () => {
        const a = await withTenant({ tenantId: tenantA }, () =>
          jobs.enqueueJob(data),
        );
        const b = await withTenant({ tenantId: tenantB }, () =>
          jobs.enqueueJob({ ...data, args: { tenant: 'B' } }),
        );
        const global = await jobs.enqueueJob({
          ...data,
          tenantId: null,
          args: { tenant: 'global' },
        });
        expect(new Set([a.id, b.id, global.id]).size).toBe(3);
        await expect(
          withTenant({ tenantId: tenantA }, () =>
            jobs.enqueueJob({ ...data, tenantId: tenantB }),
          ),
        ).rejects.toThrow();
        expect((await pointers()).rows.map((row) => row.job_id).sort()).toEqual(
          [a.id, b.id, global.id].sort(),
        );
        expect(
          (await jobs.list({ limit: 10 })).map((job) => job.id).sort(),
        ).toEqual([a.id, b.id, global.id].sort());
      },
      timeout,
    );

    it(
      'rolls back the slot and job on the same caller transaction, then admits a clean enqueue',
      async () => {
        if (!db.transaction)
          throw new Error('PostgreSQL transactions required');
        await expect(
          db.transaction(async (tx) => {
            const job = await withTenant({ tenantId: tenantA }, () =>
              jobs.enqueueJob(data, { transaction: tx }),
            );
            expect((await tx.query('SELECT id FROM _smrt_jobs')).rows).toEqual([
              { id: job.id },
            ]);
            expect(
              (await tx.query('SELECT job_id FROM _smrt_job_dedupe_slots'))
                .rows,
            ).toEqual([{ job_id: job.id }]);
            throw new Error('fixture caller rollback');
          }),
        ).rejects.toThrow('fixture caller rollback');
        expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toEqual([]);
        expect((await pointers()).rows).toEqual([]);
        const next = await withTenant({ tenantId: tenantA }, () =>
          jobs.enqueueJob(data),
        );
        expect((await pointers()).rows).toEqual([{ job_id: next.id }]);
      },
      timeout,
    );

    it(
      'denies retry while a newer keyed job is active and permits it after public cancellation',
      async () => {
        await withTenant({ tenantId: tenantA }, async () => {
          const old = await jobs.enqueueJob(data);
          await old.cancel();
          const newer = await jobs.enqueueJob({
            ...data,
            args: { original: 'newer active' },
          });
          await expect(old.retry()).rejects.toThrow('already reserves');
          const denied = await jobs.get({ id: old.id }, { cache: false });
          expect(denied?.status).toBe('cancelled');
          expect(denied?.args).toEqual(data.args);
          expect((await pointers()).rows).toEqual([{ job_id: newer.id }]);
          await newer.cancel();
          await old.retry();
          expect(
            (await jobs.enqueueJob({ ...data, args: { ignored: true } })).id,
          ).toBe(old.id);
          expect(
            (await jobs.get({ id: old.id }, { cache: false }))?.args,
          ).toEqual(data.args);
          expect((await pointers()).rows).toEqual([{ job_id: old.id }]);
          expect(
            (await jobs.list({ limit: 10 }))
              .filter((job) => ['pending', 'running'].includes(job.status))
              .map((job) => job.id),
          ).toEqual([old.id]);
        });
      },
      timeout,
    );
  },
);
