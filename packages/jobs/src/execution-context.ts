import { AsyncLocalStorage } from 'node:async_hooks';
import type { JobExecutionContext } from './logger-extension.js';

// Job rows are durable but untrusted transport. This marker is deliberately
// module-private: a JSON task invocation cannot synthesize the runner-owned
// execution context that security-sensitive task targets receive. The
// registration helpers below are internal to the package (not re-exported from
// the root entry); only the TaskRunner (`./runner`) calls them.
const runnerExecutionContextIdentities = new WeakSet<object>();
const runnerExecutionContexts = new AsyncLocalStorage<JobExecutionContext>();

/** True only for an execution context constructed by the TaskRunner. */
export function isRunnerExecutionContext(
  value: unknown,
): value is JobExecutionContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    runnerExecutionContextIdentities.has(value)
  );
}

/** The runner-owned context for the currently executing task, if any. */
export function getActiveJobExecutionContext():
  | JobExecutionContext
  | undefined {
  return runnerExecutionContexts.getStore();
}

/** @internal Mark a context as runner-owned. Called only by the TaskRunner. */
export function markRunnerExecutionContext(context: object): void {
  runnerExecutionContextIdentities.add(context);
}

/** @internal Run `fn` with `context` as the active execution context. */
export function runWithExecutionContext<T>(
  context: JobExecutionContext,
  fn: () => T,
): T {
  return runnerExecutionContexts.run(context, fn);
}
