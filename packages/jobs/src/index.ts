/**
 * @happyvertical/smrt-jobs
 *
 * Background job execution for SMRT objects.
 * Provides persistence, retries, and scheduling for any SmrtObject method.
 *
 * @example
 * ```typescript
 * import { withBackgroundJobs, TaskRunner } from '@happyvertical/smrt-jobs';
 *
 * // Add background capabilities to your class
 * const BackgroundDocument = withBackgroundJobs(Document);
 * const doc = new BackgroundDocument({ ... });
 *
 * // Simple background execution
 * const handle = await doc.bg('generateSummary', { format: 'md' });
 *
 * // Fluent builder for advanced options
 * const handle = await doc.background('generateSummary', { format: 'md' })
 *   .delay('5m')
 *   .retries(5)
 *   .priority('high')
 *   .enqueue();
 *
 * // Wait for result
 * const result = await handle.wait();
 *
 * // Start a task runner to process jobs
 * const runner = new TaskRunner({ concurrency: 5 });
 * await runner.initialize(db);
 * await runner.start();
 * ```
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

// Fluent job builder and utilities
export {
  JobBuilder,
  type Priority,
  parseDelay,
  priorityToNumber,
} from './job-builder.js';

// Job handle for tracking
export {
  JobHandle,
  type JobResult,
  type WaitOptions,
} from './job-handle.js';
// Logger extension
export {
  type JobContext,
  JobContextLogger,
} from './logger-extension.js';
// Object extension (mixin)
export {
  type BackgroundCapable,
  type BgOptions,
  withBackgroundJobs,
} from './object-extension.js';
// Task runner
export {
  createTaskRunner,
  TaskRunner,
  type TaskRunnerConfig,
  type TaskRunnerEvents,
} from './runner.js';

// Schedule runner (for cron-based agent scheduling)
export {
  createScheduleRunner,
  type ScheduleInfo,
  ScheduleRunner,
  type ScheduleRunnerConfig,
  type ScheduleRunnerEvents,
} from './schedule-runner.js';
// Core job model
export {
  type JobStatus,
  type ListReadyOptions,
  SmrtJob,
  SmrtJobCollection,
  type SmrtJobData,
  type TimeoutBehavior,
} from './smrt-job.js';
