import type { JobExecutionContext } from './logger-extension.js';

/**
 * Named job handlers (#5005).
 *
 * A job targets either a model method (`objectType` is a registered class,
 * `method` one of its methods) or a handler registered here under a
 * namespaced name. A handler job is stored in `_smrt_jobs` in a reserved
 * form, with no schema change:
 *
 * - `object_type` = `handler:<name>` (see {@link JOB_HANDLER_TARGET_PREFIX})
 * - `method` = `handle` (see {@link JOB_HANDLER_METHOD})
 * - `object_id` = NULL
 * - `args` = the handler's JSON payload
 *
 * The `handler:` prefix keeps a handler name out of the model namespace: a
 * name such as `@happyvertical/smrt-workflows:workflow-run` has the grammar of
 * a qualified class name, and the registry's qualified-name fallback looks a
 * class up by that tail (`workflow-run` is not a class name today, but the
 * namespaces would overlap). `handler:@…` is not a qualified class name (its
 * package part does not start with `@`) and cannot be a class key.
 */

/** Prefix that marks a stored job target as a named handler. */
export const JOB_HANDLER_TARGET_PREFIX = 'handler:';

/** The fixed `method` value of every handler job row. */
export const JOB_HANDLER_METHOD = 'handle';

/**
 * Most handlers one process may register. A runner's claim names each of its
 * handlers as one bound parameter (#5005 claim filter), so the registry is
 * capped to keep that statement inside every engine's parameter limit.
 */
export const MAX_JOB_HANDLERS = 256;

/** Longest accepted handler name. */
const MAX_HANDLER_NAME_LENGTH = 200;

/**
 * `<package>:<name>`: an npm package name (scoped or not), a colon, and a
 * lowercase kebab-case local name, optionally dotted (`run.step`).
 */
const HANDLER_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*:[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

/** A job payload: a JSON object, exactly like a model job's `args`. */
export type JobHandlerPayload = Record<string, unknown>;

/**
 * A named job handler. It receives the job's payload and the same runner
 * execution context a model method receives: job id, attempt, tenant, queue,
 * logger, `signal`, `event`/`progress`/`log`, and — on a runner started with
 * `claimFencing: true` — the claim read by `getJobClaim(context)`.
 * `context.job.handler` names the handler. Lease renewal is per worker, not
 * per job: the runner renews its own lease while the handler runs.
 */
export type JobHandler<
  TPayload extends JobHandlerPayload = JobHandlerPayload,
  TResult = unknown,
> = (
  payload: TPayload,
  context: JobExecutionContext,
) => Promise<TResult> | TResult;

/** The stored target of a handler job. */
export interface JobHandlerTarget {
  objectType: string;
  method: string;
}

/** A handler name that is not `<package>:<name>`. */
export class JobHandlerNameError extends TypeError {
  constructor(readonly handler: unknown) {
    super(
      `Invalid job handler name ${JSON.stringify(handler)}: expected "<package>:<name>", e.g. "@happyvertical/smrt-workflows:workflow-run"`,
    );
    this.name = 'JobHandlerNameError';
  }
}

/** A second registration under a name that is already registered. */
export class JobHandlerAlreadyRegisteredError extends Error {
  constructor(readonly handler: string) {
    super(`Job handler already registered: ${handler}`);
    this.name = 'JobHandlerAlreadyRegisteredError';
  }
}

/** A registration past {@link MAX_JOB_HANDLERS}. */
export class JobHandlerLimitError extends RangeError {
  constructor(readonly handler: string) {
    super(
      `Cannot register job handler ${handler}: a process may register at most ${MAX_JOB_HANDLERS} job handlers`,
    );
    this.name = 'JobHandlerLimitError';
  }
}

/**
 * Registration or removal while a TaskRunner in this process is running.
 * Register every handler before `runner.start()`.
 */
export class JobHandlerRegistrationClosedError extends Error {
  constructor(readonly handler: string) {
    super(
      `Cannot change job handler ${handler} while a TaskRunner is running; register handlers before runner.start()`,
    );
    this.name = 'JobHandlerRegistrationClosedError';
  }
}

/**
 * The runner that claimed a handler job has no handler under its name. The
 * job fails terminally on that claim (failure kind `handler-unregistered`),
 * whatever its `maxAttempts`. A runner claims only the handler jobs it has
 * registered, so this is the backstop for a claim made without that filter.
 */
export class JobHandlerUnregisteredError extends Error {
  /** Read by the runner's retry hints: never retried. */
  readonly retryable = false;
  constructor(readonly handler: string) {
    super(`Job handler not registered: ${handler}`);
    this.name = 'JobHandlerUnregisteredError';
  }
}

/** A handler job row that is not in the canonical handler form. */
export class JobHandlerTargetError extends Error {
  /** Read by the runner's retry hints: never retried. */
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'JobHandlerTargetError';
  }
}

const REGISTRY_KEY = '__smrtJobHandlers';

interface JobHandlerRegistryState {
  handlers: Map<string, JobHandler>;
  /** Worker keys of running TaskRunners; registration is closed while any. */
  sealedBy: Set<string>;
}

type GlobalWithJobHandlers = typeof globalThis & {
  [REGISTRY_KEY]?: JobHandlerRegistryState;
};

function registry(): JobHandlerRegistryState {
  const g = globalThis as GlobalWithJobHandlers;
  let state = g[REGISTRY_KEY];
  if (!state) {
    // Process-wide singleton, like the live-worker set: it survives HMR and
    // a duplicated module instance (the runner is bundled into a chunk).
    state = { handlers: new Map(), sealedBy: new Set() };
    g[REGISTRY_KEY] = state;
  }
  return state;
}

/** True when `name` is a valid namespaced handler name. */
export function isJobHandlerName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length <= MAX_HANDLER_NAME_LENGTH &&
    HANDLER_NAME_PATTERN.test(name)
  );
}

/** Throw {@link JobHandlerNameError} unless `name` is a valid handler name. */
export function assertJobHandlerName(name: unknown): asserts name is string {
  if (!isJobHandlerName(name)) throw new JobHandlerNameError(name);
}

function assertRegistrationOpen(name: string): void {
  if (registry().sealedBy.size > 0)
    throw new JobHandlerRegistrationClosedError(name);
}

/**
 * Register a named job handler for this process. Call before any
 * `TaskRunner.start()`: a runner snapshots the registry when it starts, and
 * registration while one is running throws
 * {@link JobHandlerRegistrationClosedError}.
 *
 * @param name - Namespaced `<package>:<name>`, e.g. `@scope/pkg:workflow-run`.
 * @param handler - Called with the job payload and runner execution context.
 * @throws JobHandlerNameError, JobHandlerAlreadyRegisteredError,
 *   JobHandlerLimitError, JobHandlerRegistrationClosedError
 */
export function registerJobHandler<
  TPayload extends JobHandlerPayload = JobHandlerPayload,
>(name: string, handler: JobHandler<TPayload>): void {
  assertJobHandlerName(name);
  if (typeof handler !== 'function')
    throw new TypeError(`Job handler ${name} must be a function`);
  assertRegistrationOpen(name);
  const { handlers } = registry();
  if (handlers.has(name)) throw new JobHandlerAlreadyRegisteredError(name);
  if (handlers.size >= MAX_JOB_HANDLERS) throw new JobHandlerLimitError(name);
  handlers.set(name, handler as JobHandler);
}

/**
 * Remove a registered handler (tests and teardown). Closed while a runner is
 * running, like registration.
 * @returns Whether a handler was registered under `name`.
 */
export function unregisterJobHandler(name: string): boolean {
  assertRegistrationOpen(name);
  return registry().handlers.delete(name);
}

/** Names of the handlers registered in this process, sorted. */
export function listJobHandlers(): string[] {
  return [...registry().handlers.keys()].sort();
}

/** The stored job target for a handler name. */
export function jobHandlerTarget(name: string): JobHandlerTarget {
  assertJobHandlerName(name);
  return {
    objectType: `${JOB_HANDLER_TARGET_PREFIX}${name}`,
    method: JOB_HANDLER_METHOD,
  };
}

/** True when a stored `objectType` is in the reserved handler form. */
export function isJobHandlerTarget(objectType: unknown): boolean {
  return (
    typeof objectType === 'string' &&
    objectType.startsWith(JOB_HANDLER_TARGET_PREFIX)
  );
}

/**
 * The handler name of a stored `objectType`, or null for a model target. The
 * name is returned as stored; it may be invalid on a row not written through
 * the enqueue API.
 */
export function jobHandlerName(objectType: unknown): string | null {
  return isJobHandlerTarget(objectType)
    ? (objectType as string).slice(JOB_HANDLER_TARGET_PREFIX.length)
    : null;
}

/** @internal Close registration for a starting runner; returns its snapshot. */
export function sealJobHandlerRegistry(
  workerKey: string,
): ReadonlyMap<string, JobHandler> {
  const state = registry();
  state.sealedBy.add(workerKey);
  return new Map(state.handlers);
}

/** @internal Reopen registration when that runner has stopped. */
export function releaseJobHandlerRegistry(workerKey: string): void {
  registry().sealedBy.delete(workerKey);
}
