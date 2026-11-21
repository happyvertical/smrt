/**
 * The run a call belongs to, passed explicitly, and the tracked call
 * primitive (#5005; page sections 3 and 6.4).
 *
 * A call belongs to a run only when its caller hands it an
 * {@link AiRunContext}: on the call's options (`runContext`) or to
 * {@link runAiRunCall}. Nothing reads a run from a process-wide variable. A
 * background job carries {@link serializeAiRunContext}'s plain JSON in its
 * payload and rebuilds the context with {@link restoreAiRunContext} on the
 * database (and tenant) it runs against.
 */

import { createLogger } from '@happyvertical/logger';
import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  AI_OWN_CALL_ID_TAG,
  markAiRunSettledUsageEvent,
} from '../adapters/ai-usage.js';
import {
  type AiCallRate,
  type AiCallReservation,
  assertAiRunStillRunning,
  deferAiRunSettlement,
  releaseAiCall,
  reserveAiCall,
  settleAiCall,
} from './ai-run-accounting.js';
import { AiRunCallRoute, openAiRunCallRoute } from './ai-run-late-usage.js';
import { stopAiRunForChild } from './ai-run-lifecycle.js';
import {
  AiCallLimitError,
  type AiRunClaimFence,
  AiRunNotFoundError,
  type AiRunScopedTxOptions,
  type AiRunStatus,
  AiRunStoppedError,
  AiRunTransitionError,
  aiRunQuery,
  assertAiRunFence,
  expectedTenantOf,
  getAiRun,
  getRows,
  newAiRunId,
  rememberSettlementTenant,
  withAiRunTransaction,
} from './ai-run-model.js';

const logger = createLogger({ level: 'info' });

/** The step a call belongs to, carried onto its usage row. */
export interface AiRunCallStep {
  stepIndex?: number;
  stepName?: string;
  stepInstanceId?: string;
  attempt?: number;
}

/**
 * A reservation already made for the next call sent under a context: one
 * seat's share of a fusion's joint reservation (page section 6.3). The
 * first call actually sent takes it instead of reserving; a later call (an
 * alias-chain fallback of the same seat) reserves on its own.
 */
export interface AiRunHeldReservation {
  reservation: AiCallReservation;
  /**
   * Sent after the first stage (the judge): just before it is sent the
   * chain is checked to be still `running`; when it is not, the
   * reservation is released and the call is refused with the stop.
   */
  checkRunning?: boolean;
}

/** Where a context keeps its held reservations. */
export interface AiRunHeldReservations {
  /** The held reservation for the next call sent, at most once. */
  take(): AiRunHeldReservation | undefined;
}

/** The run a call belongs to, on one database. */
export interface AiRunContext extends AiRunCallStep {
  runId: string;
  /** The run's database; its tenant's data. */
  db: DatabaseInterface;
  tenantId?: string | null;
  /** The claim fence of the job running the nearest durable run. */
  fence?: AiRunClaimFence;
  /** Reservations made ahead of the calls (a fusion seat's share). */
  reservations?: AiRunHeldReservations;
}

/** {@link AiRunContext} as a job payload carries it: plain JSON. */
export interface SerializedAiRunContext extends AiRunCallStep {
  v: 1;
  runId: string;
  tenantId: string | null;
}

/** Plain JSON for a background job's payload: no database, no fence. */
export function serializeAiRunContext(
  context: AiRunContext,
): SerializedAiRunContext {
  return {
    v: 1,
    runId: context.runId,
    tenantId: context.tenantId ?? null,
    ...(context.stepIndex !== undefined
      ? { stepIndex: context.stepIndex }
      : {}),
    ...(context.stepName !== undefined ? { stepName: context.stepName } : {}),
    ...(context.stepInstanceId !== undefined
      ? { stepInstanceId: context.stepInstanceId }
      : {}),
    ...(context.attempt !== undefined ? { attempt: context.attempt } : {}),
  };
}

/**
 * Rebuild a run context in a job, on the database and tenant the job runs
 * against. The run must exist there and belong to that tenant, so a payload
 * cannot point a job at another tenant's run.
 */
export async function restoreAiRunContext(
  serialized: SerializedAiRunContext | unknown,
  scope: {
    db: DatabaseInterface;
    tenantId?: string | null;
    fence?: AiRunClaimFence;
  },
): Promise<AiRunContext> {
  const value = serialized as Partial<SerializedAiRunContext> | null;
  if (value?.v !== 1 || typeof value.runId !== 'string') {
    throw new TypeError('restoreAiRunContext: not a serialized AI run context');
  }
  const run = await getAiRun(scope.db, value.runId);
  if (!run) throw new AiRunNotFoundError(value.runId);
  const tenantId = scope.tenantId ?? null;
  if (
    (run.tenantId ?? null) !== tenantId ||
    (value.tenantId ?? null) !== tenantId
  ) {
    throw new AiRunNotFoundError(value.runId);
  }
  return {
    runId: run.id,
    db: scope.db,
    tenantId,
    ...(scope.fence ? { fence: scope.fence } : {}),
    ...(value.stepIndex !== undefined ? { stepIndex: value.stepIndex } : {}),
    ...(value.stepName !== undefined ? { stepName: value.stepName } : {}),
    ...(value.stepInstanceId !== undefined
      ? { stepInstanceId: value.stepInstanceId }
      : {}),
    ...(value.attempt !== undefined ? { attempt: value.attempt } : {}),
  };
}

/** Whether a value is an {@link AiRunContext}. */
export function isAiRunContext(value: unknown): value is AiRunContext {
  const context = value as Partial<AiRunContext> | null;
  return Boolean(
    context &&
      typeof context === 'object' &&
      typeof context.runId === 'string' &&
      context.db &&
      typeof (context.db as { query?: unknown }).query === 'function',
  );
}

/** The usage tags a tracked call carries. */
export function aiRunCallTags(
  context: AiRunContext,
  callId: string,
  entryCallId: string,
): Record<string, string> {
  return {
    [AI_OWN_CALL_ID_TAG]: callId,
    callId: entryCallId,
    runId: context.runId,
    ...(context.stepIndex !== undefined
      ? { stepIndex: String(context.stepIndex) }
      : {}),
    ...(context.stepName !== undefined ? { stepName: context.stepName } : {}),
    ...(context.stepInstanceId !== undefined
      ? { stepInstanceId: context.stepInstanceId }
      : {}),
    ...(context.attempt !== undefined
      ? { attempt: String(context.attempt) }
      : {}),
  };
}

/** What a tracked call's sender receives. */
export interface AiRunCallInvocation {
  callId: string;
  entryCallId: string;
  /** The output limit to send to the provider, or null to send none. */
  outputLimit: number | null;
  /** Merge into the call's usage tags. */
  usageTags: Record<string, string>;
  /** Aborted at the chain's `callTimeoutMs`. */
  signal: AbortSignal | undefined;
  /**
   * Hand the call's normalized usage event to the tracked call, which writes
   * it with the settlement; the handlers run only after that commits.
   */
  capture(event: SmrtAiUsageEvent): void;
}

/** Input of {@link runAiRunCall}. */
export interface AiRunCallRequest {
  /** The entry call this call belongs to (an alias chain, a fusion). */
  entryCallId?: string;
  /** Minted when absent: the call id exists before the call is sent. */
  callId?: string;
  inputTokens?: number;
  inputChars?: number;
  outputLimit?: number;
  expectedOutputTokens?: number;
  modelMaxOutput?: number;
  rate?: AiCallRate | null;
  name?: string | null;
  parentEventId?: string | null;
  /** The usage row written when the provider reports none. */
  fallbackUsage: Pick<SmrtAiUsageEvent, 'provider' | 'model' | 'operation'> &
    Partial<Pick<SmrtAiUsageEvent, 'className' | 'tenantId' | 'tags'>>;
  /**
   * Called once the call's settlement has committed, with its usage event:
   * the usage handlers (a settlement on the pending list calls it when it
   * is written).
   */
  afterSettle?: (event: SmrtAiUsageEvent) => Promise<void>;
  signal?: AbortSignal;
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

/**
 * The accounting options that carry the context's tenant into the run's
 * final lookups and locks (empty when the context names none): a run whose
 * id was pruned and reused by another tenant after the context was made is
 * never reserved, settled or released.
 */
function inContextTenant(context: AiRunContext): AiRunScopedTxOptions {
  return context.tenantId !== undefined
    ? { expectedTenant: context.tenantId ?? null }
    : {};
}

/**
 * A plain copy of a context with each of its properties read exactly once
 * by ordinary property access (an accessor included), so a getter cannot
 * answer one step of a call differently from the next.
 */
function readAiRunContextOnce(context: AiRunContext): AiRunContext {
  const {
    runId,
    db,
    tenantId,
    fence,
    reservations,
    stepIndex,
    stepName,
    stepInstanceId,
    attempt,
  } = context;
  return {
    runId,
    db,
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(fence ? { fence } : {}),
    ...(reservations ? { reservations } : {}),
    ...(stepIndex !== undefined ? { stepIndex } : {}),
    ...(stepName !== undefined ? { stepName } : {}),
    ...(stepInstanceId !== undefined ? { stepInstanceId } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
  };
}

/**
 * Admit a held reservation just before its call is sent (page section 6.3),
 * in the tenant the caller's context established: with `checkRunning`, the
 * chain is locked and must still be `running` (a stopped chain releases the
 * reservation and the stop is thrown); either way the held call's own event
 * must still be `reserved` in this run. With a claim fence, both modes
 * assert it first: a worker whose claim was taken over gets
 * {@link AiRunClaimLostError}. A run that is gone throws
 * {@link AiRunNotFoundError}, a reservation no longer held throws
 * {@link AiRunTransitionError}; nothing is sent.
 */
async function admitHeldAiCall(
  db: DatabaseInterface,
  runId: string,
  callId: string,
  options: AiRunScopedTxOptions & { checkRunning: boolean },
): Promise<void> {
  if (options.checkRunning) {
    // The claim fence is asserted first, inside the same transaction.
    await assertAiRunStillRunning(db, runId, {
      ...options,
      releaseCallId: callId,
    });
    return;
  }
  const tenant = expectedTenantOf(options);
  if (options.fence) {
    // A worker that lost its claim never spends a reservation it took
    // before: the fence is asserted, then the reservation read, in one
    // transaction (the job row first, as in every accounting write).
    const fence = options.fence;
    await withAiRunTransaction(
      db,
      async (tx) => {
        await assertAiRunFence(tx, runId, fence, tenant);
        await readHeldReservation(tx.db, runId, callId, tenant);
      },
      options,
    );
    return;
  }
  await readHeldReservation(db, runId, callId, tenant);
}

/** Throw unless the held call's event is still `reserved` in its run. */
async function readHeldReservation(
  db: DatabaseInterface,
  runId: string,
  callId: string,
  tenant: string | null | undefined,
): Promise<void> {
  const rows = getRows(
    await aiRunQuery(
      db,
      `SELECT r.status, e.reservation FROM _smrt_ai_runs r
         LEFT JOIN _smrt_ai_run_events e
           ON e.run_id = r.id AND e.call_id = $2 AND e.type = 'call'
        WHERE r.id = $1${
          tenant === undefined
            ? ''
            : tenant === null
              ? ' AND r.tenant_id IS NULL'
              : ' AND r.tenant_id = $3'
        }`,
      runId,
      callId,
      ...(tenant === undefined || tenant === null ? [] : [tenant]),
    ),
  );
  const row = rows[0];
  if (!row) throw new AiRunNotFoundError(runId);
  if (row.reservation !== 'reserved') {
    const status = String(row.status) as AiRunStatus;
    throw new AiRunTransitionError(
      `AI call ${callId} of run ${runId} is no longer reserved`,
      runId,
      status,
      status,
    );
  }
}

/**
 * Write one call's usage row with its settlement; the handlers run only
 * after it commits. A settlement that fails every retry waits on the
 * database's pending list.
 */
async function settleTaggedCall(
  context: AiRunContext,
  callId: string,
  usageTags: Record<string, string>,
  afterSettle: ((event: SmrtAiUsageEvent) => Promise<void>) | undefined,
  event: SmrtAiUsageEvent,
  status: string,
  committed?: () => void,
): Promise<void> {
  const tagged: SmrtAiUsageEvent = {
    ...event,
    // A call of a run is billed to the run's tenant (the settlement writes
    // the row with the run row's own), and the handlers see the same.
    ...(context.tenantId !== undefined
      ? { tenantId: context.tenantId ?? null }
      : {}),
    tags: { ...(event.tags ?? {}), ...usageTags },
  };
  // The call's own record: the handlers receive it and it is never routed
  // back to the call as late usage.
  markAiRunSettledUsageEvent(tagged);
  const input = { runId: context.runId, callId, usage: tagged, status };
  const after =
    afterSettle || committed
      ? async () => {
          committed?.();
          if (afterSettle) await afterSettle(tagged);
        }
      : undefined;
  // The run is settled in the tenant its context names, also when the
  // settlement is queued and written later.
  if (context.tenantId !== undefined) {
    rememberSettlementTenant(input, context.tenantId ?? null);
  }
  try {
    await settleAiCall(context.db, input, inContextTenant(context));
  } catch (error) {
    logger.warn(
      `[smrt] AI run ${context.runId} settlement of call ${callId} failed; kept pending: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    // Written later from the pending list; `after` (the handlers, and a
    // late correction waiting for the settlement) runs then.
    deferAiRunSettlement(context.db, input, after);
    return;
  }
  if (!after) return;
  try {
    await after();
  } catch (error) {
    logger.warn(
      `[smrt] AI usage handlers failed for call ${callId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Charge a call that ran without a reservation to its run (page section
 * 6.4, `unreserved`): a chain that never answered still wrote its
 * zero-token row, and the run counts it. The call gets its own id and, like
 * any call, one usage row; nothing is reserved or released.
 */
export async function chargeAiRunCallUnreserved(
  context: AiRunContext,
  request: {
    event: SmrtAiUsageEvent;
    status?: string;
    entryCallId?: string;
    afterSettle?: (event: SmrtAiUsageEvent) => Promise<void>;
  },
): Promise<string> {
  const callId = newAiRunId();
  await settleTaggedCall(
    context,
    callId,
    aiRunCallTags(context, callId, request.entryCallId ?? callId),
    request.afterSettle,
    request.event,
    request.status ?? 'failed',
  );
  return callId;
}

/** The tag on a usage row whose amounts are its call's reservation. */
const AI_USAGE_ESTIMATE_TAG = 'usageEstimate';

function reportsTokens(event: SmrtAiUsageEvent): boolean {
  const usage = event.usage;
  return [
    usage?.promptTokens,
    usage?.completionTokens,
    usage?.totalTokens,
  ].some((value) => typeof value === 'number' && Number.isFinite(value));
}

/**
 * A priced call that answered without reporting tokens or a cost (#5489;
 * an OpenAI-compatible stream reports none) is charged what it reserved:
 * the run is already charged the reserved tokens, and its usage row now
 * records the reserved cost too, tagged `usageEstimate: reservation`, so
 * `maxCost`, the ledger and hosted spend never read it as free. A call on
 * an unpriced model stays uncosted; reported usage is kept as reported.
 */
function chargedAtReservation(
  event: SmrtAiUsageEvent,
  reservation: AiCallReservation,
): SmrtAiUsageEvent {
  if (
    reservation.uncosted ||
    reportsTokens(event) ||
    (typeof event.estimatedCost === 'number' &&
      Number.isFinite(event.estimatedCost))
  ) {
    return event;
  }
  return {
    ...event,
    estimatedCost: reservation.reservedCost,
    tags: { ...(event.tags ?? {}), [AI_USAGE_ESTIMATE_TAG]: 'reservation' },
  };
}

/** The usage a response reported, for a client that sends no usage event. */
export interface AiRunObservedUsage {
  model?: string;
  usage?: SmrtAiUsageEvent['usage'];
  estimatedCost?: number;
  duration?: number;
}

/** A tracked call between its reservation and its end. */
export interface AiRunCallHandle {
  invocation: AiRunCallInvocation;
  reservation: AiCallReservation;
  /**
   * The call answered: settle it with its captured usage event, else with
   * what the response itself reported (`observed`), else the zero-token
   * fallback row.
   */
  succeed(observed?: AiRunObservedUsage): Promise<void>;
  /**
   * The call failed: settle it when usage was captured, else release it;
   * returns the error to throw (a timeout becomes {@link AiCallLimitError};
   * a child's stop becomes the calling run's).
   */
  fail(error: unknown): Promise<unknown>;
}

/**
 * Reserve one tracked call and return its handle (page section 6.4): the
 * call id is minted before anything is sent, a refused reservation stops the
 * run and throws {@link AiRunStoppedError}, and no transaction is open while
 * the caller sends the call. End it with `succeed()` or `fail()`; the usage
 * handlers (`afterSettle`) run only after the settlement commits, and a
 * settlement that fails every retry waits on the database's pending list.
 */
export async function beginAiRunCall(
  passed: AiRunContext,
  request: AiRunCallRequest,
): Promise<AiRunCallHandle> {
  // Each property is read once: the fence, tenant and run that admit the
  // call are the ones every later step uses.
  const context = readAiRunContextOnce(passed);
  const held = context.reservations?.take();
  if (held) {
    await admitHeldAiCall(context.db, context.runId, held.reservation.callId, {
      checkRunning: Boolean(held.checkRunning),
      ...(context.fence ? { fence: context.fence } : {}),
      ...inContextTenant(context),
    });
  }
  const callId = held?.reservation.callId ?? request.callId ?? newAiRunId();
  const entryCallId = request.entryCallId ?? callId;
  const reservation: AiCallReservation = held
    ? held.reservation
    : await reserveAiCall(
        context.db,
        context.runId,
        {
          callId,
          ...(request.inputTokens !== undefined
            ? { inputTokens: request.inputTokens }
            : {}),
          ...(request.inputChars !== undefined
            ? { inputChars: request.inputChars }
            : {}),
          ...(request.outputLimit !== undefined
            ? { outputLimit: request.outputLimit }
            : {}),
          ...(request.expectedOutputTokens !== undefined
            ? { expectedOutputTokens: request.expectedOutputTokens }
            : {}),
          ...(request.modelMaxOutput !== undefined
            ? { modelMaxOutput: request.modelMaxOutput }
            : {}),
          rate: request.rate ?? null,
          stepIndex: context.stepIndex ?? null,
          name: request.name ?? context.stepName ?? null,
          parentEventId: request.parentEventId ?? null,
        },
        {
          ...(context.fence ? { fence: context.fence } : {}),
          ...inContextTenant(context),
        },
      );

  const timeout =
    reservation.callTimeoutMs !== null
      ? AbortSignal.timeout(reservation.callTimeoutMs)
      : undefined;
  const signal =
    timeout && request.signal
      ? AbortSignal.any([timeout, request.signal])
      : (timeout ?? request.signal);
  const usageTags = aiRunCallTags(context, callId, entryCallId);

  // The call's route: its usage, while it runs and after it ended, wherever
  // the event is delivered (ai-run-late-usage.ts). Its state, the
  // once-only correction included, lives on the route, not here.
  const settle = (event: SmrtAiUsageEvent, status: string) =>
    settleTaggedCall(
      context,
      callId,
      usageTags,
      request.afterSettle,
      chargedAtReservation(event, reservation),
      status,
      () => route.settlementCommitted(),
    );
  const route = openAiRunCallRoute(
    new AiRunCallRoute(
      callId,
      context.db,
      context.runId,
      context.tenantId,
      settle,
    ),
  );
  // An event handed to the call's own capture names the call's run (core's
  // tags); one that does not is not this call's usage.
  const capture = (event: SmrtAiUsageEvent): void => {
    if (event.tags?.runId !== undefined && event.tags.runId !== context.runId) {
      return;
    }
    route.capture(event);
  };

  return {
    reservation,
    invocation: {
      callId,
      entryCallId,
      outputLimit: reservation.outputLimit,
      usageTags,
      signal,
      capture,
    },
    async succeed(observed) {
      if (route.ended) return;
      route.ended = true;
      await settle(
        route.settlementEvent() ?? {
          ...request.fallbackUsage,
          ...(observed?.model ? { model: observed.model } : {}),
          ...(observed?.usage ? { usage: observed.usage } : {}),
          ...(observed?.estimatedCost !== undefined
            ? { estimatedCost: observed.estimatedCost }
            : {}),
          duration: observed?.duration ?? 0,
          timestamp: new Date(),
        },
        'ok',
      );
    },
    async fail(error) {
      if (route.ended) return error;
      route.ended = true;
      const timedOut = Boolean(timeout?.aborted);
      const status = timedOut
        ? 'timed_out'
        : isAbort(error)
          ? 'cancelled'
          : 'failed';
      const captured = route.settlementEvent();
      if (captured) {
        // It reported usage before it ended: charged, with how it ended.
        await settle(captured, status);
      } else {
        route.released(status);
        await releaseAiCall(
          context.db,
          { runId: context.runId, callId, status },
          inContextTenant(context),
        ).catch((releaseError) => {
          logger.warn(
            `[smrt] AI run ${context.runId} could not release call ${callId}: ${
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError)
            }`,
          );
        });
        if (timedOut) {
          return new AiCallLimitError(
            `The call exceeded callTimeoutMs ${reservation.callTimeoutMs}`,
            'callTimeoutMs',
            context.runId,
          );
        }
      }
      if (error instanceof AiRunStoppedError && error.runId !== context.runId) {
        return stopAiRunForChild(
          context.db,
          context.runId,
          error,
          inContextTenant(context),
        );
      }
      return error;
    },
  };
}

/**
 * One tracked call in a run: {@link beginAiRunCall}, `send` with no
 * transaction open, then settle or release. When `send` raises the
 * {@link AiRunStoppedError} of a child run that answered the entry call, the
 * calling run takes the child's stop first and the calling run's error is
 * raised: catching it does not revive the run.
 */
export async function runAiRunCall<T>(
  context: AiRunContext,
  request: AiRunCallRequest,
  send: (invocation: AiRunCallInvocation) => Promise<T>,
): Promise<T> {
  const handle = await beginAiRunCall(context, request);
  let value: T;
  try {
    value = await send(handle.invocation);
  } catch (error) {
    throw await handle.fail(error);
  }
  await handle.succeed();
  return value;
}
