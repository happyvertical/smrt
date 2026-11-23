import type { Plan } from './commands.ts';

export type EngineErrorCode =
  | 'invalid'
  | 'not_found'
  | 'refused'
  | 'unauthorized'
  | 'forbidden'
  | 'approval_required'
  | 'worker_crashed'
  | 'unavailable'
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

/** A call reached the engine with no valid principal, or one for another tenant (#5188). Nothing ran. */
export class NoPrincipalError extends EngineError {
  constructor(message = 'this call carries no valid principal') {
    super(message, 'unauthorized');
    this.name = 'NoPrincipalError';
  }
}

/**
 * A database handle was used after the operation it belonged to ended, or
 * outside any operation (#5188). Nothing ran: the transaction is gone.
 */
export class OperationEndedError extends EngineError {
  constructor(
    message = 'this database handle belongs to an operation that has ended',
  ) {
    super(message, 'refused');
    this.name = 'OperationEndedError';
  }
}

/** The principal is valid but does not hold the permission the operation needs (#5188). */
export class PermissionDeniedError extends EngineError {
  constructor(message = 'permission denied') {
    super(message, 'forbidden');
    this.name = 'PermissionDeniedError';
  }
}

/** The budget of database connections has no room: retry later. Never a verdict on the caller's data. */
export class CapacityError extends EngineError {
  constructor(message: string, code: EngineErrorCode = 'refused') {
    super(message, code);
    this.name = 'CapacityError';
  }
}

/**
 * The shared database pool is saturated (#5188): too many operations queued,
 * or one waited too long for a connection. The server's state, never a verdict
 * on the caller's request; routes answer 503 and the caller may retry.
 */
export class DatabaseBusyError extends CapacityError {
  constructor(message: string) {
    super(message, 'unavailable');
    this.name = 'DatabaseBusyError';
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
    super(
      message.startsWith('stale fence: ') ? message : `stale fence: ${message}`,
      'stale_fence',
      details,
    );
    this.name = 'StaleFenceError';
  }
}

/** The host's claim on its app is gone (its session ended); the app must be reopened (#5470). */
export class ClaimLostError extends StaleFenceError {
  constructor(message: string) {
    super(message, { resource: 'claim' });
    this.name = 'ClaimLostError';
  }
}

/** The version store's current version is not what the caller expected; nothing was written (#5470). */
export class StaleStoreError extends StaleFenceError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, { resource: 'store', ...details });
    this.name = 'StaleStoreError';
  }
}

/** Is `e` (or a cause of it) a stale-fence refusal, even if a library wrapped it? */
export function isStaleFence(e: unknown): boolean {
  for (let i = 0, x = e as any; x && i < 6; i++, x = x.cause)
    if (x.code === 'stale_fence' || x.name === 'StaleFenceError') return true;
  return false;
}
