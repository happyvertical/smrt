import type { Plan } from './commands.ts';

export type EngineErrorCode =
  | 'invalid'
  | 'not_found'
  | 'refused'
  | 'approval_required'
  | 'worker_crashed'
  | 'migration_failed';

/** A refusal or mistake the caller can act on (as opposed to a crash). */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  constructor(message: string, code: EngineErrorCode = 'invalid') {
    super(message);
    this.name = 'EngineError';
    this.code = code;
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
