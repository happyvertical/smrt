/**
 * Tests for job retention (issue #2375, assessment finding F2).
 *
 * `SmrtJobCollection.cleanup()` existed but nothing scheduled it, and
 * `_smrt_job_events` — one row per log line and progress tick — had no prune
 * path at all. These cover the two prunes themselves, their dry-run previews,
 * the tasks that contribute them to the framework retention sweep, and the
 * `(status, completed_at)` index the job predicate needs.
 *
 * Real in-memory SQLite throughout; no mocking.
 */

import {
  clearRetentionTasks,
  getTestDatabase,
  runRetentionSweep,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RETENTION_SWEEP_INTERVAL_MS,
  JOB_EVENTS_RETENTION_TASK,
  JOBS_RETENTION_TASK,
  registerJobRetentionTasks,
  startRetentionSweeper,
  unregisterJobRetentionTasks,
} from '../retention.js';
import { TaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';
import { SmrtJobEventCollection } from '../smrt-job-event.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The runner's sweeper handle is private state with no public accessor; the
 * observable behaviour under test is "a sweeper exists while the runner runs",
 * so the test reads the field rather than waiting six hours for a tick.
 */
function runnerSweeper(runner: TaskRunner): unknown {
  return (runner as unknown as { retentionSweeper: unknown }).retentionSweeper;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

async function seedTerminalJob(
  jobs: SmrtJobCollection,
  options: { status: string; completedAt: Date; objectType: string },
): Promise<void> {
  const job = await jobs.create({
    queue: 'retention',
    objectType: options.objectType,
    method: 'run',
  });
  job.status = options.status as never;
  job.completedAt = options.completedAt;
  await job.save();
}

async function countRows(
  db: DatabaseInterface,
  table: string,
): Promise<number> {
  const result = await db.query(`SELECT COUNT(*) AS total FROM ${table}`);
  return Number(result.rows[0]?.total ?? 0);
}

afterEach(() => {
  clearRetentionTasks();
});

describe('SmrtJobCollection.cleanup (#2375)', () => {
  it('deletes terminal jobs past their cutoff and keeps recent and live ones', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const jobs = await SmrtJobCollection.create({ db });

    await seedTerminalJob(jobs, {
      status: 'completed',
      completedAt: daysAgo(30),
      objectType: 'OldCompleted',
    });
    await seedTerminalJob(jobs, {
      status: 'completed',
      completedAt: daysAgo(1),
      objectType: 'RecentCompleted',
    });
    await jobs.create({
      queue: 'retention',
      objectType: 'StillPending',
      method: 'run',
    });

    const pruned = await jobs.cleanup({ completedBefore: daysAgo(7) });

    expect(pruned).toBe(1);
    const remaining = await jobs.list({ limit: 10 });
    expect(remaining.map((job) => job.objectType).sort()).toEqual([
      'RecentCompleted',
      'StillPending',
    ]);
  });

  it('counts without deleting under dryRun', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const jobs = await SmrtJobCollection.create({ db });

    await seedTerminalJob(jobs, {
      status: 'failed',
      completedAt: daysAgo(60),
      objectType: 'OldFailed',
    });

    const pruned = await jobs.cleanup({
      failedBefore: daysAgo(30),
      dryRun: true,
    });

    expect(pruned).toBe(1);
    expect(await countRows(db, '_smrt_jobs')).toBe(1);
  });

  it('returns 0 when no cutoff is supplied rather than deleting everything', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const jobs = await SmrtJobCollection.create({ db });

    await seedTerminalJob(jobs, {
      status: 'completed',
      completedAt: daysAgo(90),
      objectType: 'Ancient',
    });

    expect(await jobs.cleanup({})).toBe(0);
    expect(await countRows(db, '_smrt_jobs')).toBe(1);
  });

  it('creates the (status, completed_at) index its predicate needs', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    await SmrtJobCollection.create({ db });

    const result = await db.query(
      `SELECT name FROM sqlite_master WHERE type = 'index'`,
    );
    expect(result.rows.map((row) => String(row.name))).toContain(
      'idx_smrt_jobs_status_completed_at',
    );
  });
});

describe('SmrtJobEventCollection.cleanup (#2375)', () => {
  it('deletes events older than the cutoff and keeps newer ones', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const events = await SmrtJobEventCollection.create({ db });

    await events.append({
      jobId: 'job-1',
      message: 'old',
      createdAt: daysAgo(60),
    });
    await events.append({
      jobId: 'job-1',
      message: 'new',
      createdAt: daysAgo(1),
    });

    const pruned = await events.cleanup({ before: daysAgo(30) });

    expect(pruned).toBe(1);
    const remaining = await events.listByJob('job-1', { tenantId: null });
    expect(remaining.map((event) => event.message)).toEqual(['new']);
  });

  it('counts without deleting under dryRun', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const events = await SmrtJobEventCollection.create({ db });

    await events.append({
      jobId: 'job-1',
      message: 'old',
      createdAt: daysAgo(60),
    });

    expect(await events.cleanup({ before: daysAgo(30), dryRun: true })).toBe(1);
    expect(await countRows(db, '_smrt_job_events')).toBe(1);
  });
});

describe('job retention tasks (#2375)', () => {
  it('are driven by the framework retention sweep', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const jobs = await SmrtJobCollection.create({ db });
    const events = await SmrtJobEventCollection.create({ db });

    await seedTerminalJob(jobs, {
      status: 'completed',
      completedAt: daysAgo(30),
      objectType: 'OldCompleted',
    });
    await events.append({
      jobId: 'job-1',
      message: 'old',
      createdAt: daysAgo(60),
    });

    registerJobRetentionTasks();
    const result = await runRetentionSweep(db);

    expect(result.failed).toBe(false);
    expect(
      result.tasks.find((task) => task.task === JOBS_RETENTION_TASK)?.pruned,
    ).toBe(1);
    expect(
      result.tasks.find((task) => task.task === JOB_EVENTS_RETENTION_TASK)
        ?.pruned,
    ).toBe(1);
    expect(await countRows(db, '_smrt_jobs')).toBe(0);
    expect(await countRows(db, '_smrt_job_events')).toBe(0);
  });

  it('honours configured windows', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const jobs = await SmrtJobCollection.create({ db });

    await seedTerminalJob(jobs, {
      status: 'completed',
      completedAt: daysAgo(10),
      objectType: 'TenDaysOld',
    });

    registerJobRetentionTasks({ completedOlderThanDays: 30 });
    const result = await runRetentionSweep(db);

    expect(
      result.tasks.find((task) => task.task === JOBS_RETENTION_TASK)?.pruned,
    ).toBe(0);
    expect(await countRows(db, '_smrt_jobs')).toBe(1);
  });

  it('can be unregistered', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    await SmrtJobCollection.create({ db });

    registerJobRetentionTasks();
    unregisterJobRetentionTasks();
    const result = await runRetentionSweep(db);

    expect(result.tasks.some((task) => task.task === JOBS_RETENTION_TASK)).toBe(
      false,
    );
  });
});

describe('startRetentionSweeper (#2375)', () => {
  it('registers the job tasks and does not sweep before the first interval', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const jobs = await SmrtJobCollection.create({ db });

    await seedTerminalJob(jobs, {
      status: 'completed',
      completedAt: daysAgo(90),
      objectType: 'OldCompleted',
    });

    const sweeper = startRetentionSweeper(db);
    try {
      // Nothing is deleted at start — a crash-looping worker must not become a
      // delete loop.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await countRows(db, '_smrt_jobs')).toBe(1);

      const result = await sweeper.sweepNow();
      expect(result.failed).toBe(false);
      expect(await countRows(db, '_smrt_jobs')).toBe(0);
    } finally {
      sweeper.stop();
    }
  });

  it('does not unregister its tasks on stop — the package import owns that contract', async () => {
    // `index.ts` registers these tasks unconditionally on import, so "this
    // process loaded @happyvertical/smrt-jobs" is what contributes them, not
    // "a sweeper happens to be running". If `stop()` unregistered, a second,
    // independent `runRetentionSweep()` call elsewhere in the same long-lived
    // process — or simply restarting the runner later — would silently lose
    // job retention the moment one sweeper stopped.
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    await SmrtJobCollection.create({ db });

    const sweeper = startRetentionSweeper(db);
    sweeper.stop();

    const result = await runRetentionSweep(db);
    expect(result.tasks.some((task) => task.task === JOBS_RETENTION_TASK)).toBe(
      true,
    );

    // The explicit opt-out still works for callers that want a clean
    // registry (tests, teardown).
    unregisterJobRetentionTasks();
    const afterExplicitUnregister = await runRetentionSweep(db);
    expect(
      afterExplicitUnregister.tasks.some(
        (task) => task.task === JOBS_RETENTION_TASK,
      ),
    ).toBe(false);
  });

  it('stopping one sweeper never disarms another sweeper in the same process', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    await SmrtJobCollection.create({ db });

    const first = startRetentionSweeper(db);
    const second = startRetentionSweeper(db);
    try {
      first.stop();
      const stillArmed = await runRetentionSweep(db);
      expect(
        stillArmed.tasks.some((task) => task.task === JOBS_RETENTION_TASK),
      ).toBe(true);
    } finally {
      second.stop();
    }

    // Neither stop() unregisters — the tasks are still armed after both.
    const stillArmedAfterBoth = await runRetentionSweep(db);
    expect(
      stillArmedAfterBoth.tasks.some(
        (task) => task.task === JOBS_RETENTION_TASK,
      ),
    ).toBe(true);
  });

  it('defaults to a six-hour cadence', () => {
    expect(DEFAULT_RETENTION_SWEEP_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });
});

describe('TaskRunner retention wiring (#2375)', () => {
  it('arms a sweeper on start and disarms it on stop', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    await SmrtJobCollection.create({ db });

    const runner = new TaskRunner({ pollInterval: 60_000 });
    await runner.initialize(db);
    await runner.start();
    try {
      expect(runnerSweeper(runner)).not.toBeNull();
    } finally {
      await runner.stop();
    }

    expect(runnerSweeper(runner)).toBeNull();
  });

  it('arms nothing when retention is opted out', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    await SmrtJobCollection.create({ db });

    const runner = new TaskRunner({ pollInterval: 60_000, retention: false });
    await runner.initialize(db);
    await runner.start();
    try {
      expect(runnerSweeper(runner)).toBeNull();
    } finally {
      await runner.stop();
    }
  });
});
