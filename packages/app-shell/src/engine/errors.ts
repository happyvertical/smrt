import type { Plan } from './commands.ts';

export type EngineErrorCode =
  | 'invalid'
  | 'not_found'
  | 'refused'
  | 'approval_required'
  | 'worker_crashed'
  | 'stale_fence'
  | 'migration_failed';

/** What an owner is told instead of an {@link EngineError.untrusted} message. */
export const UNTRUSTED_MESSAGE =
  'the app could not do that right now; try again in a moment';

/**
 * The message of an engine error that may be shown to an owner: its own text,
 * or the fixed sentence when the text came from a worker or driver (the detail
 * is logged on the server).
 */
export function exposableMessage(e: EngineError): string {
  if (!e.untrusted) return e.message;
  // biome-ignore lint/suspicious/noConsole: message only, never a stack or body
  console.error('engine error hidden from the owner:', e.code, e.message);
  return UNTRUSTED_MESSAGE;
}

/** A refusal or mistake the caller can act on (as opposed to a crash). */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  /** Extra JSON a route returns beside `error` and `code` (e.g. the blockers that refused Apply). */
  readonly details?: Record<string, unknown>;
  /**
   * The message came from a worker or a driver (a database host or user name
   * can be in it), not from engine code written for the caller. It is for the
   * server log; an owner is shown a fixed sentence instead (#5464).
   */
  readonly untrusted: boolean = false;
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

  /** An error whose text came from a worker or driver: see {@link untrusted}. */
  static untrusted(
    message: string,
    code: EngineErrorCode = 'invalid',
  ): EngineError {
    const e = new EngineError(message, code);
    (e as { untrusted: boolean }).untrusted = true;
    return e;
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
  constructor(
    message = 'the app stopped; restart it to continue',
    untrusted = false,
  ) {
    super(message, 'worker_crashed');
    (this as { untrusted: boolean }).untrusted = untrusted;
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

/** Is `e` (or a cause of it) a stale-fence refusal, even if a library wrapped it? */
export function isStaleFence(e: unknown): boolean {
  for (let i = 0, x = e as any; x && i < 6; i++, x = x.cause)
    if (x.code === 'stale_fence' || x.name === 'StaleFenceError') return true;
  return false;
}
