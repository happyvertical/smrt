import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ScheduleRunner,
  type ScheduleRunnerConfig,
} from '../schedule-runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

for (const type of ['sqlite', 'duckdb'] as const) {
  describe(`atomic schedule occurrences (${type})`, () => {
    let db: DatabaseInterface;
    afterEach(async () => {
      vi.restoreAllMocks();
      await db?.close?.();
    });
    async function fixture(config: ScheduleRunnerConfig = {}) {
      db = await getTestDatabase({ type, url: ':memory:' });
      await SmrtJobCollection.create({ db });
      await db.query(`CREATE TABLE _smrt_agent_schedules (
        id ${type === 'duckdb' ? 'UUID' : 'TEXT'} PRIMARY KEY, agent_type TEXT, agent_id TEXT, tenant_id ${type === 'duckdb' ? 'UUID' : 'TEXT'},
        agent_config TEXT, cron TEXT, timezone TEXT, method TEXT, method_args TEXT,
        timeout INTEGER, enabled BOOLEAN, status TEXT, next_run TEXT,
        running_count INTEGER, max_concurrent INTEGER, last_error TEXT,
        last_run TEXT, last_status TEXT, run_count INTEGER, success_count INTEGER,
        failure_count INTEGER)`);
      await db.query(`INSERT INTO _smrt_agent_schedules
        (id, agent_type, cron, timezone, method, enabled, status, next_run,
         running_count, max_concurrent) VALUES ('33333333-3333-4333-8333-333333333333', 'Probe', '* * * * *',
         'America/Edmonton', 'run', TRUE, 'active', '2026-01-01T00:00:00.000Z', 0, 1)`);
      const runner = new ScheduleRunner(config);
      await runner.initialize(db);
      return runner as unknown as {
        triggerSchedule(row: Record<string, unknown>): Promise<void>;
        poll(): Promise<void>;
        start(): Promise<void>;
        stop(): Promise<void>;
      };
    }
    it('rejects a stale occurrence after another runner consumed it', async () => {
      const runner = await fixture();
      const row = (
        await db.query(
          'SELECT *, CAST(id AS VARCHAR) AS schedule_id_text, CAST(tenant_id AS VARCHAR) AS schedule_tenant_text FROM _smrt_agent_schedules',
        )
      ).rows[0];
      await runner.triggerSchedule(row);
      await runner.triggerSchedule(row);
      const jobs = await db.query('SELECT args FROM _smrt_jobs');
      expect(jobs.rows).toHaveLength(1);
      const args =
        typeof jobs.rows[0].args === 'string'
          ? JSON.parse(jobs.rows[0].args)
          : jobs.rows[0].args;
      expect(args._scheduledFor).toBe('2026-01-01T00:00:00.000Z');
    });
    it('rechecks disable and capacity instead of trusting the selected snapshot', async () => {
      const runner = await fixture();
      const row = (
        await db.query(
          'SELECT *, CAST(id AS VARCHAR) AS schedule_id_text, CAST(tenant_id AS VARCHAR) AS schedule_tenant_text FROM _smrt_agent_schedules',
        )
      ).rows[0];
      await db.query('UPDATE _smrt_agent_schedules SET enabled = FALSE');
      await runner.triggerSchedule(row);
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        0,
      );
    });
    it('preserves native UUID tenancy and UTC timestamp occurrence on a non-UTC host', async () => {
      await fixture();
      if (type === 'duckdb')
        await db.query(
          'ALTER TABLE _smrt_agent_schedules ALTER next_run TYPE TIMESTAMP',
        );
      const tenant = '11111111-1111-4111-8111-111111111111';
      await db.query('UPDATE _smrt_agent_schedules SET tenant_id = ?', tenant);
      const runner = new ScheduleRunner({
        tenantIds: [tenant],
        agentTypes: ['Probe'],
      });
      await runner.initialize(db);
      await (runner as unknown as { poll(): Promise<void> }).poll();
      const job = (
        await db.query(
          'SELECT CAST(tenant_id AS VARCHAR) AS tenant_id, args FROM _smrt_jobs',
        )
      ).rows[0];
      expect(job.tenant_id).toBe(tenant);
      const args =
        typeof job.args === 'string' ? JSON.parse(job.args) : job.args;
      expect(args._scheduledFor).toBe('2026-01-01T00:00:00.000Z');
      expect(args._scheduleId).toBe('33333333-3333-4333-8333-333333333333');
    });
    it('limits admission and reconciliation to configured scopes and queue', async () => {
      const runner = await fixture({
        agentTypes: ['Probe'],
        tenantIds: [null],
        queue: 'isolated',
      });
      await runner.poll();
      expect(
        (await db.query('SELECT queue FROM _smrt_jobs')).rows[0].queue,
      ).toBe('isolated');
      await db.query(
        "UPDATE _smrt_agent_schedules SET agent_type = 'Excluded', running_count = 7, next_run = '2026-01-01T00:00:00.000Z'",
      );
      await runner.poll();
      expect(
        Number(
          (await db.query('SELECT running_count FROM _smrt_agent_schedules'))
            .rows[0].running_count,
        ),
      ).toBe(7);
      const row = (
        await db.query(
          'SELECT *, CAST(id AS VARCHAR) AS schedule_id_text, CAST(tenant_id AS VARCHAR) AS schedule_tenant_text FROM _smrt_agent_schedules',
        )
      ).rows[0];
      await runner.triggerSchedule(row);
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        1,
      );
      const none = new ScheduleRunner({ agentTypes: [] });
      await none.initialize(db);
      await (none as unknown as { poll(): Promise<void> }).poll();
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        1,
      );
    });
    it('rolls back a persisted enqueue when later admission work fails', async () => {
      const runner = await fixture();
      const original = SmrtJobCollection.prototype.enqueueJob;
      vi.spyOn(SmrtJobCollection.prototype, 'enqueueJob').mockImplementation(
        async function (this: SmrtJobCollection, ...args) {
          await original.apply(this, args);
          throw new Error('synthetic failure after insert');
        },
      );
      await runner.poll();
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        0,
      );
      const row = (
        await db.query(
          'SELECT *, CAST(id AS VARCHAR) AS schedule_id_text, CAST(tenant_id AS VARCHAR) AS schedule_tenant_text FROM _smrt_agent_schedules',
        )
      ).rows[0];
      expect(row.next_run).toBe('2026-01-01T00:00:00.000Z');
      expect(Number(row.running_count)).toBe(0);
      expect(row.last_error).toContain('synthetic failure');
      vi.restoreAllMocks();
      await runner.poll();
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        1,
      );
    });
    it('does not admit a selected row after stop begins and drains the blocked poll', async () => {
      const runner = await fixture();
      let entered!: () => void;
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const query = db.query.bind(db);
      vi.spyOn(db, 'query').mockImplementation(async (sql, ...params) => {
        const result = await query(sql, ...params);
        if (
          sql.trimStart().startsWith('SELECT') &&
          sql.includes('AND next_run <=')
        ) {
          entered();
          await resume;
        }
        return result;
      });
      await runner.start();
      await blocked;
      let stopped = false;
      const stopping = runner.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        0,
      );
    });
    it('drains an admitted transaction before stop resolves', async () => {
      const runner = await fixture();
      let entered!: () => void;
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = SmrtJobCollection.prototype.enqueueJob;
      vi.spyOn(SmrtJobCollection.prototype, 'enqueueJob').mockImplementation(
        async function (this: SmrtJobCollection, ...args) {
          entered();
          await resume;
          return original.apply(this, args);
        },
      );
      await runner.start();
      await blocked;
      let stopped = false;
      const stopping = runner.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        1,
      );
    });
    it('rejects reserved occurrence arguments instead of accepting caller authority', async () => {
      const runner = await fixture();
      await db.query(
        'UPDATE _smrt_agent_schedules SET method_args = ?',
        JSON.stringify({ _scheduledFor: 'forged' }),
      );
      await runner.poll();
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        0,
      );
      expect(
        (await db.query('SELECT last_error FROM _smrt_agent_schedules')).rows[0]
          .last_error,
      ).toContain('reserved _scheduledFor');
    });
    it('counts pending jobs as occupied slots across subsequent polls', async () => {
      const runner = await fixture();
      await runner.poll();
      await db.query(
        "UPDATE _smrt_agent_schedules SET next_run = '2026-01-02T00:00:00.000Z'",
      );
      await runner.poll();
      expect((await db.query('SELECT id FROM _smrt_jobs')).rows).toHaveLength(
        1,
      );
      expect(
        Number(
          (await db.query('SELECT running_count FROM _smrt_agent_schedules'))
            .rows[0].running_count,
        ),
      ).toBe(1);
    });
  });
}
