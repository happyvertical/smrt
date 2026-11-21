import type { Plan } from './commands.ts';

export type EngineErrorCode =
  | 'invalid'
  | 'not_found'
  | 'refused'
  | 'approval_required'
  | 'worker_crashed'
  | 'stale_fence'
  | 'migration_failed';

/** A refusal or mistake the caller can act on (as opposed to a crash). */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  /** Extra JSON a route returns beside `error` and `code` (e.g. the blockers that refused Apply). */
  readonly details?: Record<string, unknown>;
  constructor(
    message: string,
    code: EngineErrorCode = 'invalid',
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.details = details;
  }
}

/**
 * A risky command or tool call was made without `approved: true`. The shell's
 * approval model sets that only after the owner decided in its own UI.
 */
export class ApprovalRequiredError extends EngineError {
  readonly plan: Plan;
  constructor(plan: Plan) {
    super(`approval required: ${plan.summary}`, 'approval_required');
    this.name = 'ApprovalRequiredError';
    this.plan = plan;
  }
}

/** The app's worker thread is gone. `restartApp()` starts a new one. */
export class WorkerCrashedError extends EngineError {
  constructor(message = 'the app stopped; restart it to continue') {
    super(message, 'worker_crashed');
    this.name = 'WorkerCrashedError';
  }
}

/** A mistake by the caller inside the app runtime (bad field, missing record). */
export class AppError extends EngineError {
  constructor(message: string) {
    super(message, 'invalid');
    this.name = 'AppError';
  }
}

/**
 * This host (or one of its workers) no longer owns the app: the ownership
 * generation stored in the app's database moved on (another host opened the
 * app, or a publish or restore swapped its schema). Nothing was written.
 * Reopen the app to take ownership again; never retry the same call blindly.
 */
export class StaleFenceError extends EngineError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(`stale fence: ${message}`, 'stale_fence', details);
    this.name = 'StaleFenceError';
  }
}

/** Is `e` (or a cause of it) a stale-fence refusal, even if a library wrapped it? */
export function isStaleFence(e: unknown): boolean {
  for (let i = 0, x = e as any; x && i < 6; i++, x = x.cause)
    if (x.code === 'stale_fence' || x.name === 'StaleFenceError') return true;
  return false;
}
