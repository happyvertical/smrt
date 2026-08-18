/**
 * Job retention — bounded growth for `_smrt_jobs` and `_smrt_job_events`
 * (issue #2375, assessment finding F2).
 *
 * `SmrtJobCollection.cleanup()` has always existed but nothing ever called it,
 * and `_smrt_job_events` — one row per log line, progress tick and lifecycle
 * transition — had no prune path at all. This module contributes both to the
 * framework retention sweep so `smrt db:prune` and the `TaskRunner`'s periodic
 * sweep drive them like every other framework-owned table.
 *
 * Registration is explicit: importing this module does not schedule anything.
 * {@link registerJobRetentionTasks} is called by {@link startRetentionSweeper}
 * (which the runner starts) and can be called directly by an application that
 * schedules the sweep itself.
 *
 * @see https://github.com/happyvertical/smrt/issues/2375
 * @packageDocumentation
 */

import { createLogger } from '@happyvertical/logger';
import {
  type RetentionPolicy,
  type RetentionSweepResult,
  registerRetentionTask,
  runRetentionSweep,
  unregisterRetentionTask,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { SmrtJobCollection } from './smrt-job.js';
import { SmrtJobEventCollection } from './smrt-job-event.js';

const logger = createLogger({ level: 'info' });

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Retention task name for terminal rows in `_smrt_jobs`. */
export const JOBS_RETENTION_TASK = 'jobs';

/** Retention task name for `_smrt_job_events`. */
export const JOB_EVENTS_RETENTION_TASK = 'job-events';

/** Windows applied by the job retention tasks. */
export interface JobRetentionOptions {
  /** Delete completed jobs finished more than this many days ago (default 7). */
  completedAfterDays?: number;
  /** Delete cancelled jobs finished more than this many days ago (default 7). */
  cancelledAfterDays?: number;
  /** Delete failed jobs finished more than this many days ago (default 30). */
  failedAfterDays?: number;
  /** Delete job events recorded more than this many days ago (default 30). */
  eventsAfterDays?: number;
  /** Maximum job rows removed per sweep (default 10 000). */
  batchSize?: number;
}

/**
 * Documented job retention defaults.
 *
 * Completed and cancelled work is the bulk of the table and is uninteresting
 * within a week; failures are kept a month because that is how long anyone
 * looks at them. Events outlive the jobs they describe by design — a job row
 * deleted at 7 days can still have its log read for another three weeks.
 */
export const DEFAULT_JOB_RETENTION: Required<JobRetentionOptions> = {
  completedAfterDays: 7,
  cancelledAfterDays: 7,
  failedAfterDays: 30,
  eventsAfterDays: 30,
  batchSize: 10_000,
};

/**
 * Register the job and job-event retention tasks with the framework sweep.
 *
 * Idempotent: re-registering replaces the previous tasks, so repeated calls
 * (multiple runners in one process, module re-evaluation) do not duplicate
 * work.
 */
export function registerJobRetentionTasks(
  options: JobRetentionOptions = {},
): void {
  const config = { ...DEFAULT_JOB_RETENTION, ...options };

  registerRetentionTask({
    name: JOBS_RETENTION_TASK,
    description: 'Prune terminal job rows (_smrt_jobs)',
    run: async (db, context) => {
      const jobs = await SmrtJobCollection.create({ db });
      const cutoff = (days: number) =>
        new Date(context.now.getTime() - days * MS_PER_DAY);

      return jobs.cleanup({
        completedBefore: cutoff(config.completedAfterDays),
        cancelledBefore: cutoff(config.cancelledAfterDays),
        failedBefore: cutoff(config.failedAfterDays),
        limit: config.batchSize,
        dryRun: context.dryRun,
      });
    },
  });

  registerRetentionTask({
    name: JOB_EVENTS_RETENTION_TASK,
    description: 'Prune job event history (_smrt_job_events)',
    run: async (db, context) => {
      const events = await SmrtJobEventCollection.create({ db });
      return events.cleanup({
        before: new Date(
          context.now.getTime() - config.eventsAfterDays * MS_PER_DAY,
        ),
        dryRun: context.dryRun,
      });
    },
  });
}

/** Remove the job retention tasks from the framework sweep. */
export function unregisterJobRetentionTasks(): void {
  unregisterRetentionTask(JOBS_RETENTION_TASK);
  unregisterRetentionTask(JOB_EVENTS_RETENTION_TASK);
}

/** Configuration for {@link startRetentionSweeper}. */
export interface RetentionSweeperOptions {
  /** How often to sweep, in milliseconds (default 6 hours). */
  intervalMs?: number;
  /** Policy handed to `runRetentionSweep` on each tick. */
  policy?: RetentionPolicy;
  /** Windows for the job retention tasks this sweeper registers. */
  jobs?: JobRetentionOptions;
}

/** Handle returned by {@link startRetentionSweeper}. */
export interface RetentionSweeper {
  /** Stop sweeping and unregister the job retention tasks. */
  stop(): void;
  /** Run one sweep immediately (used by tests and by manual triggers). */
  sweepNow(): Promise<RetentionSweepResult>;
}

/** Default sweep cadence: four times a day is ample for day-scale windows. */
export const DEFAULT_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Start a periodic retention sweep on an interval.
 *
 * The first sweep runs one full interval after start, never at start: a worker
 * process restarting in a crash loop must not turn into a delete loop, and a
 * short-lived process (a test, a one-shot worker) should exit without having
 * deleted anything it was not asked to.
 *
 * The timer is `unref`'d where the runtime supports it, so a pending sweep
 * never keeps a process alive.
 *
 * @param db - Database holding the system tables.
 * @param options - Cadence and policy overrides.
 * @returns A handle that stops the sweeper and unregisters its tasks.
 */
export function startRetentionSweeper(
  db: DatabaseInterface,
  options: RetentionSweeperOptions = {},
): RetentionSweeper {
  registerJobRetentionTasks(options.jobs);

  const intervalMs = options.intervalMs ?? DEFAULT_RETENTION_SWEEP_INTERVAL_MS;
  let stopped = false;

  const sweepNow = async (): Promise<RetentionSweepResult> =>
    runRetentionSweep(db, options.policy);

  const timer = setInterval(() => {
    if (stopped) return;
    sweepNow().catch((error) => {
      logger.warn(
        `[smrt-jobs] retention sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, intervalMs);

  if (typeof timer === 'object' && typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      unregisterJobRetentionTasks();
    },
    sweepNow,
  };
}
