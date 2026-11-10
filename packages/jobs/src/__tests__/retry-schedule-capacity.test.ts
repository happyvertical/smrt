import { getTestDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmacDurableJobPayloadSigner } from '../durable-payload-integrity.js';
import {
  getScheduleAdmissionPayload,
  verifyScheduleAdmission,
} from '../schedule-admission.js';
import { ScheduleRunner } from '../schedule-runner.js';
import { type SmrtJob, SmrtJobCollection } from '../smrt-job.js';
import {
  terminalSnapshot,
  transitionTerminalJob,
} from '../terminal-outcome.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const foreign = '22222222-2222-4222-8222-222222222222';
const scheduleId = '33333333-3333-4333-8333-333333333333';
const signer = createHmacDurableJobPayloadSigner({
  keyId: 'retry-fixture',
  key: 'synthetic-retry-capacity-signing-key-32-bytes',
});
for (const type of ['sqlite', 'duckdb'] as const) {
  describe(`scheduled retry capacity (${type})`, () => {
    let db: DatabaseInterface;
    afterEach(async () => {
      vi.restoreAllMocks();
      await db?.close?.();
    });
    async function fixture({
      cap = 1,
      keyed = false,
      terminal = 'cancelled',
    } = {}) {
      db = await getTestDatabase({ type, url: ':memory:' });
      const jobs = await SmrtJobCollection.create({ db });
      await db.query(`CREATE TABLE _smrt_agent_schedules (
        id ${type === 'duckdb' ? 'UUID' : 'TEXT'} PRIMARY KEY,
        tenant_id ${type === 'duckdb' ? 'UUID' : 'TEXT'}, agent_type TEXT,
        agent_id TEXT, agent_config TEXT, cron TEXT, timezone TEXT, method TEXT,
        method_args TEXT, timeout INTEGER, enabled BOOLEAN, status TEXT,
        next_run TEXT, running_count INTEGER, max_concurrent INTEGER, last_error TEXT)`);
      await db.query(
        `INSERT INTO _smrt_agent_schedules
        (id, tenant_id, agent_type, cron, timezone, method, method_args,
         enabled, status, next_run, running_count, max_concurrent)
        VALUES (?, ?, 'Probe', '* * * * *', 'UTC', 'run', ?, TRUE, 'active',
        '2026-01-01T00:00:00.000Z', 0, ?)`,
        scheduleId,
        tenant,
        JSON.stringify({ consent: { projectId: 'original' } }),
        cap,
      );
      const runner = new ScheduleRunner({ occurrenceSigner: signer });
      await runner.initialize(db);
      const poll = () =>
        (runner as unknown as { poll(): Promise<void> }).poll();
      let old: SmrtJob;
      if (keyed) {
        // A public Run Now-style keyed job with a persisted schedule association.
        // The owning-store fixture's trusted signer binds the exact row; this is
        // not a downstream proof of actual ScheduleRunner admission.
        old = await jobs.enqueueJob({
          tenantId: tenant,
          dedupeKey: 'resource:original',
          queue: 'agents',
          objectType: 'Probe',
          method: 'run',
          args: {
            consent: { projectId: 'original' },
            _scheduleId: scheduleId,
            _scheduledFor: '2026-01-01T00:00:00.000Z',
          },
        });
        old.args = {
          ...old.args,
          _scheduleAdmission: signer.sign(
            getScheduleAdmissionPayload(old, signer.keyId),
          ),
        };
        await old.save();
      } else {
        await poll();
        old = (await jobs.list({ limit: 10 }))[0];
      }
      old.attempts = 2;
      await old.save();
      if (terminal === 'failed') {
        const snapshot = terminalSnapshot(old);
        if (!snapshot) throw new Error('persisted fixture job required');
        await transitionTerminalJob(db, {
          job: snapshot,
          status: 'failed',
          completedAt: new Date(),
          expectedStatuses: ['pending'],
          failureKind: 'execution',
        });
        old = (await jobs.get(
          { id: String(old.id) },
          { cache: false },
        )) as SmrtJob;
      } else await old.cancel();
      const fresh = (job: SmrtJob) =>
        jobs.get({ id: String(job.id) }, { cache: false });
      const active = async () =>
        (await jobs.list({ limit: 20 })).filter((job) =>
          ['pending', 'running'].includes(job.status),
        );
      const next = async (period = '2026-01-02T00:00:00.000Z') => {
        await db.query('UPDATE _smrt_agent_schedules SET next_run = ?', period);
        await poll();
        const found = (await active()).find(
          (job) => job.args._scheduledFor === period,
        );
        if (!found) throw new Error('new occurrence was not admitted');
        return found;
      };
      return { jobs, old, poll, next, fresh, active };
    }
    it.each([
      'failed',
      'cancelled',
    ])('denies an old %s occurrence when another period fills capacity, then retries after it frees', async (terminal) => {
      const { old, next, fresh, active } = await fixture({ terminal });
      const current = await next();
      const before = JSON.stringify((await fresh(old))?.args);
      await expect(old.retry()).rejects.toThrow(/capacity/i);
      expect((await fresh(old))?.status).toBe(terminal);
      expect((await fresh(old))?.attempts).toBe(2);
      expect((await active()).map((job) => job.id)).toEqual([current.id]);
      await current.cancel();
      await old.retry();
      expect(old.status).toBe('pending');
      expect(old.attempts).toBe(0);
      expect(JSON.stringify(old.args)).toBe(before);
      expect(verifyScheduleAdmission(old, signer)).toBe(true);
      expect((await active()).map((job) => job.id)).toEqual([old.id]);
      await old.retry(); // Its own pending slot must not count against itself.
      expect(await active()).toHaveLength(1);
    });
    it('respects cap2 and counts running as well as pending jobs', async () => {
      const { jobs, old, next, fresh, active } = await fixture({ cap: 2 });
      const first = await next();
      await jobs.claimReady({
        workerId: 'fixture-owner',
        queues: ['agents'],
        limit: 1,
      });
      const second = await next('2026-01-03T00:00:00.000Z');
      expect((await fresh(first))?.status).toBe('running');
      await expect(old.retry()).rejects.toThrow(/capacity/i);
      await second.cancel();
      await old.retry();
      expect(await active()).toHaveLength(2);
      await old.retry();
      expect(await active()).toHaveLength(2);
      await expect((await fresh(first))?.retry()).rejects.toThrow(/running/i);
    });
    it('takes canonical stored schedule/tenant/key and never saves caller-mutated business arguments', async () => {
      const { old, next, fresh } = await fixture({ keyed: true });
      const current = await next();
      const canonical = JSON.stringify(old.args);
      const slots = JSON.stringify(
        (await db.query('SELECT * FROM _smrt_job_dedupe_slots')).rows,
      );
      old.args = {
        _scheduleId: 'unrelated',
        consent: { projectId: 'tampered' },
      };
      old.tenantId = foreign;
      old.dedupeKey = 'tampered-key';
      await expect(
        withTenant({ tenantId: tenant }, () => old.retry()),
      ).rejects.toThrow(/capacity/i);
      expect((await fresh(old))?.status).toBe('cancelled');
      expect((await fresh(old))?.attempts).toBe(2);
      expect(
        JSON.stringify(
          (await db.query('SELECT * FROM _smrt_job_dedupe_slots')).rows,
        ),
      ).toBe(slots);
      await current.cancel();
      await withTenant({ tenantId: tenant }, () => old.retry());
      expect(old.tenantId).toBe(tenant);
      expect(old.dedupeKey).toBe('resource:original');
      expect(JSON.stringify(old.args)).toBe(canonical);
      expect(verifyScheduleAdmission(old, signer)).toBe(true);
      await old.save(); // Keyed raw retry must hydrate its authoritative revision.
      await old.cancel();
      expect((await fresh(old))?.status).toBe('cancelled');
    });
    it('checks persisted tenant ownership before acquiring schedule, dedupe or job write locks', async () => {
      const { old } = await fixture({ keyed: true });
      const writes: string[] = [];
      const query = db.query.bind(db);
      const transactions = vi.spyOn(db, 'transaction');
      vi.spyOn(db, 'query').mockImplementation(async (sql, ...params) => {
        if (/^\s*UPDATE\b/i.test(sql)) writes.push(sql);
        return query(sql, ...params);
      });
      old.tenantId = foreign;
      await expect(
        withTenant({ tenantId: foreign }, () => old.retry()),
      ).rejects.toThrow(/another tenant/);
      expect(writes).toEqual([]);
      expect(transactions).not.toHaveBeenCalled();
    });
    it('uses schedule then dedupe then job lock order and denies a missing or foreign schedule association', async () => {
      const { old, fresh } = await fixture({ keyed: true });
      const order: string[] = [];
      if (!db.transaction) throw new Error('transaction support required');
      const transaction = db.transaction.bind(db);
      db.transaction = async (work) =>
        transaction(async (tx) =>
          work(
            new Proxy(tx, {
              get(target, key) {
                if (key === 'query')
                  return async (sql: string, ...params: unknown[]) => {
                    if (/^\s*UPDATE\b/i.test(sql)) {
                      if (sql.includes('_smrt_agent_schedules'))
                        order.push('schedule');
                      else if (sql.includes('_smrt_job_dedupe_slots'))
                        order.push('dedupe');
                      else if (sql.includes('_smrt_jobs')) order.push('job');
                    }
                    return target.query(sql, ...params);
                  };
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ),
        );
      await old.retry();
      expect(order.slice(0, 3)).toEqual(['schedule', 'dedupe', 'job']);
      await old.cancel();
      await db.query('UPDATE _smrt_agent_schedules SET tenant_id = ?', foreign);
      await expect(old.retry()).rejects.toThrow(/association is unavailable/);
      expect((await fresh(old))?.status).toBe('cancelled');
    });
    it('serializes simultaneous retry and admission so only one capacity slot wins', async () => {
      const { old, poll, active } = await fixture();
      await db.query(
        "UPDATE _smrt_agent_schedules SET next_run='2026-01-02T00:00:00.000Z'",
      );
      await Promise.allSettled([old.retry(), poll()]);
      expect(await active()).toHaveLength(1);
    });
    it.each([
      1, 2,
    ])('counts matching legacy agent jobs at cap%s without occurrence markers', async (cap) => {
      const { jobs, old, fresh, active } = await fixture({ cap });
      const legacy: SmrtJob[] = [];
      for (let index = 0; index < cap; index++)
        legacy.push(
          await jobs.enqueueJob({
            tenantId: tenant,
            objectType: old.objectType,
            objectId: old.objectId,
            method: old.method,
            args: { _scheduleId: scheduleId, legacy: index },
          }),
        );
      await expect(old.retry()).rejects.toThrow(/capacity/i);
      expect((await fresh(old))?.status).toBe('cancelled');
      await legacy[0].cancel();
      await old.retry();
      expect((await active()).length).toBe(cap);
      expect(verifyScheduleAdmission(old, signer)).toBe(true);
    });
    it.each([
      { objectType: 'UnrelatedTarget', objectId: null, method: 'run' },
      { objectType: 'Probe', objectId: 'other-object', method: 'run' },
      { objectType: 'Probe', objectId: null, method: 'otherMethod' },
    ])('does not count unrelated legacy metadata as this agent target: %j', async (target) => {
      const { jobs, old, active } = await fixture();
      await jobs.enqueueJob({
        tenantId: tenant,
        ...target,
        args: { _scheduleId: scheduleId },
      });
      await old.retry();
      expect((await active()).length).toBe(2);
      expect(verifyScheduleAdmission(old, signer)).toBe(true);
    });
    it('keeps canonical earlier occurrences occupying a schedule after its target is retargeted', async () => {
      const { jobs, old, poll, next, active } = await fixture();
      await old.retry();
      await db.query(
        "UPDATE _smrt_agent_schedules SET agent_type='DifferentAgent', method='otherRun', next_run='2026-01-02T00:00:00.000Z'",
      );
      await poll();
      expect((await active()).map((job) => job.id)).toEqual([old.id]);
      await old.cancel();
      const newer = await next();
      expect(newer.objectType).toBe('DifferentAgent');
      await expect(old.retry()).rejects.toThrow(/capacity/i);
      await newer.cancel();
      await old.retry();
      expect(old.objectType).toBe('Probe');
      expect(old.method).toBe('run');
      expect(verifyScheduleAdmission(old, signer)).toBe(true);
      expect((await jobs.get({ id: old.id }, { cache: false }))?.args).toEqual(
        old.args,
      );
    });
    it.each([
      'table',
      'row',
    ])('fails closed when a genuine marked occurrence loses its canonical schedule %s', async (missing) => {
      const { old, fresh } = await fixture();
      if (missing === 'table')
        await db.query('DROP TABLE _smrt_agent_schedules');
      else await db.query('DELETE FROM _smrt_agent_schedules');
      await expect(old.retry()).rejects.toThrow(/association is unavailable/);
      expect((await fresh(old))?.status).toBe('cancelled');
    });
    it.each([
      'target',
      'arguments',
      'association',
    ])('rejects persisted %s changes between the initial read and the final job lock', async (changed) => {
      const { old, fresh } = await fixture({ keyed: true });
      if (!db.transaction) throw new Error('transaction support required');
      const original = JSON.stringify(old.args);
      const transaction = db.transaction.bind(db);
      db.transaction = async (work) =>
        transaction(async (tx) => {
          let injected = false;
          return work(
            new Proxy(tx, {
              get(target, key) {
                if (key === 'query')
                  return async (sql: string, ...params: unknown[]) => {
                    if (
                      !injected &&
                      /^\s*UPDATE _smrt_jobs SET id = id/.test(sql)
                    ) {
                      injected = true;
                      // Synthetic concurrent business-target/args write, never a job lifecycle change.
                      if (changed === 'target')
                        await target.query(
                          'UPDATE _smrt_jobs SET object_type = ? WHERE id = ?',
                          'DifferentAgent',
                          old.id,
                        );
                      else
                        await target.query(
                          'UPDATE _smrt_jobs SET args = ? WHERE id = ?',
                          JSON.stringify({
                            ...old.args,
                            ...(changed === 'arguments'
                              ? { consent: { projectId: 'changed' } }
                              : { _scheduleId: 'changed-association' }),
                          }),
                          old.id,
                        );
                    }
                    return target.query(sql, ...params);
                  };
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          );
        });
      await expect(old.retry()).rejects.toThrow(/association changed/);
      const stored = await fresh(old);
      expect(stored?.status).toBe('cancelled');
      expect(stored?.objectType).toBe('Probe');
      expect(JSON.stringify(stored?.args)).toBe(original);
    });
    it('joins the caller transaction without nesting and rolls back lifecycle/capacity/key changes', async () => {
      const { old, fresh } = await fixture({ keyed: true });
      if (!db.transaction) throw new Error('transaction support required');
      const before = JSON.stringify(
        (await db.query('SELECT * FROM _smrt_job_dedupe_slots')).rows,
      );
      const beforeSchedule = JSON.stringify(
        (
          await db.query(
            'SELECT running_count, next_run FROM _smrt_agent_schedules',
          )
        ).rows,
      );
      await expect(
        db.transaction(async (tx) => {
          await old.retry({ transaction: tx });
          throw new Error('rollback caller');
        }),
      ).rejects.toThrow('rollback caller');
      expect((await fresh(old))?.status).toBe('cancelled');
      expect((await fresh(old))?.attempts).toBe(2);
      expect(
        JSON.stringify(
          (await db.query('SELECT * FROM _smrt_job_dedupe_slots')).rows,
        ),
      ).toBe(before);
      expect(
        JSON.stringify(
          (
            await db.query(
              'SELECT running_count, next_run FROM _smrt_agent_schedules',
            )
          ).rows,
        ),
      ).toBe(beforeSchedule);
      await old.retry();
      expect((await fresh(old))?.status).toBe('pending');
      expect(verifyScheduleAdmission(old, signer)).toBe(true);
    });
  });
}
