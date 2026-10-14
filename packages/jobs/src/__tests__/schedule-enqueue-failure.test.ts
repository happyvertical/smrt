/**
 * Regression test for the #1401 (Tier T2) jobs remediation, finding #4:
 *
 * `triggerSchedule` used to advance `next_run` and increment `running_count`
 * BEFORE enqueuing the job. A transient `enqueueJob` failure (tenant cap, DB
 * blip) then disabled the schedule (`status='error'`) without rolling `next_run`
 * back — permanently losing that run slot AND taking the schedule out of the
 * poll until manual re-activation.
 *
 * The fix enqueues first and only advances the slot on success. This test
 * induces a transient enqueue failure and asserts the schedule is preserved:
 * `next_run` unchanged, still `active`, slot not consumed.
 *
 * Real in-memory SQLite; nothing in the runner is mocked except a single
 * forced enqueue rejection (the transient-failure scenario under test).
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScheduleRunner } from '../schedule-runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

/**
 * Minimal `_smrt_agent_schedules` table covering the columns the ScheduleRunner
 * reads and writes. The full table is owned by `@happyvertical/smrt-agents`;
 * this package only touches it via raw SQL, so the test stands up just the
 * shape the runner needs (no cross-package dependency).
 */
async function createSchedulesTable(db: DatabaseInterface): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _smrt_agent_schedules (
      id TEXT PRIMARY KEY,
      agent_type TEXT,
      agent_id TEXT,
      tenant_id TEXT,
      agent_config TEXT,
      cron TEXT,
      timezone TEXT DEFAULT 'UTC',
      method TEXT,
      method_args TEXT,
      timeout INTEGER,
      enabled BOOLEAN DEFAULT TRUE,
      status TEXT DEFAULT 'active',
      next_run TEXT,
      running_count INTEGER DEFAULT 0,
      max_concurrent INTEGER DEFAULT 1,
      last_run TEXT,
      last_status TEXT,
      last_error TEXT,
      run_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0
    )
  `);
}

describe('ScheduleRunner triggerSchedule enqueue failure (#1401 #4)', () => {
  it('preserves next_run and keeps the schedule active when enqueue fails', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    // Provision _smrt_jobs (used by the collection) and the schedules table.
    await SmrtJobCollection.create({ db });
    await createSchedulesTable(db);

    const originalNextRun = '2026-06-22T00:00:00.000Z';
    await db.query(
      `INSERT INTO _smrt_agent_schedules
         (id, agent_type, agent_id, tenant_id, cron, method, next_run,
          enabled, status, running_count, max_concurrent)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, 'active', 0, 1)`,
      'sched-1',
      'SomeAgent',
      null,
      null,
      '0 0 * * *',
      'run',
      originalNextRun,
    );

    const runner = createScheduleRunner();
    await runner.initialize(db);

    // Force a transient enqueue failure on the runner's own collection.
    const jobCollection = (
      runner as unknown as { jobCollection: SmrtJobCollection }
    ).jobCollection;
    let enqueueCalled = false;
    jobCollection.enqueueJob = async () => {
      enqueueCalled = true;
      throw new Error('transient db blip');
    };

    const scheduleRow = {
      id: 'sched-1',
      agent_type: 'SomeAgent',
      agent_id: null,
      tenant_id: null,
      agent_config: null,
      cron: '0 0 * * *',
      method: 'run',
      method_args: null,
      timeout: null,
    };

    // Drive the private trigger directly (class under test).
    await (
      runner as unknown as {
        triggerSchedule(row: typeof scheduleRow): Promise<void>;
      }
    ).triggerSchedule(scheduleRow);

    expect(enqueueCalled).toBe(true);

    const result = await db.query(
      `SELECT next_run, status, running_count, last_error
         FROM _smrt_agent_schedules WHERE id = ?`,
      'sched-1',
    );
    const row = result.rows[0] as {
      next_run: string;
      status: string;
      running_count: number;
      last_error: string | null;
    };

    // The slot is preserved: next_run untouched, schedule still pollable.
    expect(row.next_run).toBe(originalNextRun);
    expect(row.status).toBe('active');
    expect(Number(row.running_count)).toBe(0);
    // The failure is recorded for visibility.
    expect(row.last_error).toContain('transient db blip');
  });

  it('advances next_run and consumes a slot when enqueue succeeds', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    await SmrtJobCollection.create({ db });
    await createSchedulesTable(db);

    const originalNextRun = '2026-06-22T00:00:00.000Z';
    await db.query(
      `INSERT INTO _smrt_agent_schedules
         (id, agent_type, agent_id, tenant_id, cron, method, next_run,
          enabled, status, running_count, max_concurrent)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, 'active', 0, 1)`,
      'sched-ok',
      'SomeAgent',
      null,
      null,
      '0 0 * * *',
      'run',
      originalNextRun,
    );

    const runner = createScheduleRunner();
    await runner.initialize(db);

    const scheduleRow = {
      id: 'sched-ok',
      agent_type: 'SomeAgent',
      agent_id: null,
      tenant_id: null,
      agent_config: null,
      cron: '0 0 * * *',
      method: 'run',
      method_args: null,
      timeout: null,
    };

    await (
      runner as unknown as {
        triggerSchedule(row: typeof scheduleRow): Promise<void>;
      }
    ).triggerSchedule(scheduleRow);

    const result = await db.query(
      `SELECT next_run, status, running_count
         FROM _smrt_agent_schedules WHERE id = ?`,
      'sched-ok',
    );
    const row = result.rows[0] as {
      next_run: string;
      status: string;
      running_count: number;
    };

    // On success the slot is consumed and next_run advances to the future.
    expect(row.next_run).not.toBe(originalNextRun);
    expect(new Date(row.next_run).getTime()).toBeGreaterThan(
      new Date(originalNextRun).getTime(),
    );
    expect(row.status).toBe('active');
    expect(Number(row.running_count)).toBe(1);

    // A job was actually enqueued.
    const jobs = await db.query(
      `SELECT COUNT(*) as count FROM _smrt_jobs WHERE queue = 'agents'`,
    );
    expect(Number((jobs.rows[0] as { count: number }).count)).toBe(1);
  });
});

describe('ScheduleRunner triggerSchedule re-arm time zone (#3859)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function rearm(
    timezone: string | null,
  ): Promise<{ next_run: string; status: string; last_error: string | null }> {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    await SmrtJobCollection.create({ db });
    await createSchedulesTable(db);
    await db.query(
      `INSERT INTO _smrt_agent_schedules
         (id, agent_type, cron, timezone, method, next_run,
          enabled, status, running_count, max_concurrent)
       VALUES (?, ?, ?, ?, ?, ?, TRUE, 'active', 0, 1)`,
      'sched-tz',
      'SomeAgent',
      '5 3 * * *',
      timezone,
      'run',
      '2025-06-01T00:00:00.000Z',
    );

    const runner = createScheduleRunner();
    await runner.initialize(db);

    // Fake only the clock so the in-memory database keeps real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2025-06-01T00:00:00Z'));

    const scheduleRow = {
      id: 'sched-tz',
      agent_type: 'SomeAgent',
      agent_id: null,
      tenant_id: null,
      agent_config: null,
      cron: '5 3 * * *',
      timezone,
      method: 'run',
      method_args: null,
      timeout: null,
    };
    await (
      runner as unknown as {
        triggerSchedule(row: typeof scheduleRow): Promise<void>;
      }
    ).triggerSchedule(scheduleRow);

    const result = await db.query(
      'SELECT next_run, status, last_error FROM _smrt_agent_schedules WHERE id = ?',
      'sched-tz',
    );
    return result.rows[0] as {
      next_run: string;
      status: string;
      last_error: string | null;
    };
  }

  it("re-arms next_run in the row's zone, not the process zone", async () => {
    // 03:05 in Edmonton (MDT, UTC-6) is 09:05Z regardless of the host TZ.
    expect((await rearm('America/Edmonton')).next_run).toBe(
      '2025-06-01T09:05:00.000Z',
    );
  });

  it('falls back to the UTC column default when the row has no zone', async () => {
    expect((await rearm(null)).next_run).toBe('2025-06-01T03:05:00.000Z');
    expect((await rearm('  ')).next_run).toBe('2025-06-01T03:05:00.000Z');
  });

  it('moves a row with an unknown zone to error instead of retrying it every poll', async () => {
    const row = await rearm('Mars/Olympus_Mons');
    expect(row.status).toBe('error');
    expect(row.last_error).toContain('Invalid cron timezone');
    // The due slot is left as-is; the row simply leaves the active poll.
    expect(row.next_run).toBe('2025-06-01T00:00:00.000Z');
  });
});
