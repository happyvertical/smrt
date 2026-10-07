/**
 * @happyvertical/smrt-jobs (Node entry)
 *
 * Under Node the `node` export condition on `.` resolves here, so
 * `import { TaskRunner } from '@happyvertical/smrt-jobs'` keeps working.
 * Bundler/browser resolution gets the browser-safe `src/index.ts`, which never
 * reaches `runner.ts` (node:worker_threads, child_process); the same names are
 * also available explicitly from `@happyvertical/smrt-jobs/runner` (#3615).
 *
 * @packageDocumentation
 */

export * from './index';
export {
  createTaskRunner,
  JobTimeoutError,
  TaskRunner,
  type TaskRunnerConfig,
  type TaskRunnerEvents,
} from './runner';
