import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHmacDurableJobPayloadSigner,
  type DurableJobPayloadSigner,
} from '../durable-payload-integrity.js';
import { verifyScheduleAdmission } from '../schedule-admission.js';
import {
  ScheduleRunner,
  type ScheduleRunnerConfig,
} from '../schedule-runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const scheduleId = '33333333-3333-4333-8333-333333333333';
const signer = createHmacDurableJobPayloadSigner({
  keyId: 'old-key',
  key: 'synthetic-schedule-admission-key-old-32-bytes',
});

for (const type of ['sqlite', 'duckdb'] as const) {
  describe(`schedule occurrence admission integrity (${type})`, () => {
    let db: DatabaseInterface;
    afterEach(async () => {
      vi.restoreAllMocks();
      await db?.close?.();
    });
    async function fixture(
      occurrenceSigner: DurableJobPayloadSigner | null = signer,
    ) {
      db = await getTestDatabase({ type, url: ':memory:' });
      await SmrtJobCollection.create({ db });
      await db.query(`CREATE TABLE _smrt_agent_schedules (
        id ${type === 'duckdb' ? 'UUID' : 'TEXT'} PRIMARY KEY,
        tenant_id ${type === 'duckdb' ? 'UUID' : 'TEXT'}, agent_type TEXT,
        agent_id TEXT, agent_config TEXT, cron TEXT, timezone TEXT, method TEXT,
        method_args TEXT, timeout INTEGER, enabled BOOLEAN, status TEXT,
        next_run TEXT, running_count INTEGER, max_concurrent INTEGER, last_error TEXT)`);
      await db.query(
        `INSERT INTO _smrt_agent_schedules
        (id, tenant_id, agent_type, agent_config, cron, timezone, method, method_args,
         enabled, status, next_run, running_count, max_concurrent)
        VALUES (?, ?, 'Probe', ?, '* * * * *', 'UTC', 'run', ?, TRUE, 'active',
         '2026-01-01T00:00:00.000Z', 0, 1)`,
        scheduleId,
        tenant,
        JSON.stringify({ constructorConsent: { mode: 'synthetic' } }),
        JSON.stringify({
          staticConsent: {
            projectId: 'project-a',
            operatorId: 'operator-a',
            configuration: 'exact',
          },
        }),
      );
      const runner = new ScheduleRunner({
        occurrenceSigner,
      } as ScheduleRunnerConfig);
      await runner.initialize(db);
      return {
        runner,
        poll: () => (runner as unknown as { poll(): Promise<void> }).poll(),
      };
    }
    async function actualJob() {
      const jobs = await SmrtJobCollection.create({ db });
      const rows = await jobs.list({ limit: 10 });
      expect(rows).toHaveLength(1);
      return rows[0];
    }
    const policy = {
      version: 1,
      requireIntegrity: true,
      queue: 'protected',
      keyId: signer.keyId,
    };
    async function protect(value: unknown = policy) {
      await db.query(
        'UPDATE _smrt_agent_schedules SET method_args = ?, running_count = 7',
        JSON.stringify({ _scheduleAdmissionPolicy: value }),
      );
    }
    async function snapshot() {
      return (
        await db.query(
          'SELECT *, CAST(id AS VARCHAR) AS schedule_id_text, CAST(tenant_id AS VARCHAR) AS schedule_tenant_text FROM _smrt_agent_schedules',
        )
      ).rows;
    }
    for (const host of ['unsigned', 'wrong-key', 'wrong-queue'] as const) {
      it(`leaves all protected state untouched for ${host} host`, async () => {
        await fixture();
        await protect();
        const config = {
          occurrenceSigner:
            host === 'unsigned'
              ? null
              : host === 'wrong-key'
                ? { ...signer, keyId: 'other' }
                : signer,
          queue: host === 'wrong-queue' ? 'other' : 'protected',
        };
        const runner = new ScheduleRunner(config);
        await runner.initialize(db);
        const before = await snapshot();
        const blocked = vi.fn();
        runner.on('schedule:blocked', blocked);
        await (runner as unknown as { poll(): Promise<void> }).poll();
        expect(await snapshot()).toEqual(before);
        expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
          0,
        );
        expect(blocked).toHaveBeenCalled();
        expect(Object.keys(blocked.mock.calls[0][0]).sort()).toEqual([
          'reason',
          'scheduleId',
        ]);
      });
    }
    for (const bad of [
      null,
      {},
      { ...policy, version: 2 },
      { ...policy, requireIntegrity: false },
      { ...policy, extra: true },
    ]) {
      it(`blocks malformed policy ${JSON.stringify(bad)}`, async () => {
        const { poll } = await fixture();
        await protect(bad);
        const before = await snapshot();
        await poll();
        expect(await snapshot()).toEqual(before);
        expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
          0,
        );
      });
    }
    it('admits matching protected policy once and binds it in exact job args', async () => {
      await fixture();
      await protect();
      const runner = new ScheduleRunner({
        occurrenceSigner: signer,
        queue: 'protected',
      });
      await runner.initialize(db);
      const poll = () =>
        (runner as unknown as { poll(): Promise<void> }).poll();
      await poll();
      await poll();
      const job = await actualJob();
      expect(job.queue).toBe('protected');
      expect(job.args._scheduleAdmissionPolicy).toEqual(policy);
      expect(verifyScheduleAdmission(job, signer)).toBe(true);
      expect(Number((await snapshot())[0].running_count)).toBe(1);
    });
    it('retains exact protected retry integrity across trusted key rotation', async () => {
      await fixture();
      await protect();
      const runner = new ScheduleRunner({
        occurrenceSigner: signer,
        queue: 'protected',
      });
      await runner.initialize(db);
      await (runner as unknown as { poll(): Promise<void> }).poll();
      const job = await actualJob();
      const original = JSON.stringify(job.args);
      await job.cancel();
      await job.retry();
      expect(JSON.stringify((await actualJob()).args)).toBe(original);
      const next = createHmacDurableJobPayloadSigner({
        keyId: 'new-key',
        key: 'synthetic-schedule-admission-key-new-32-bytes',
      });
      const keyring = {
        keyId: next.keyId,
        sign: next.sign,
        verify: (
          payload: unknown,
          integrity: Parameters<typeof signer.verify>[1],
        ) =>
          integrity.keyId === signer.keyId
            ? signer.verify(payload, integrity)
            : next.verify(payload, integrity),
      };
      expect(verifyScheduleAdmission(job, keyring)).toBe(true);
      expect(verifyScheduleAdmission(job, next)).toBe(false);
      const changed = {
        ...job,
        args: {
          ...job.args,
          _scheduleAdmissionPolicy: { ...policy, queue: 'other' },
        },
      };
      expect(verifyScheduleAdmission(changed, keyring)).toBe(false);
    });
    it('rechecks a policy changed after selection before any admission mutation', async () => {
      const { runner } = await fixture();
      const candidate = (await snapshot())[0];
      await protect();
      const before = await snapshot();
      await (
        runner as unknown as { triggerSchedule(row: unknown): Promise<void> }
      ).triggerSchedule(candidate);
      expect(await snapshot()).toEqual(before);
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        0,
      );
    });
    it('preserves ordinary unsigned schedule behavior', async () => {
      const { poll } = await fixture(null);
      await poll();
      const job = await actualJob();
      expect(job.args).not.toHaveProperty('_scheduleAdmission');
    });
  });
}
