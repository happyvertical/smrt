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
import { AI_OWN_CALL_ID_TAG } from '../adapters/ai-usage.js';
import {
  type AiCallRate,
  type AiCallReservation,
  deferAiRunSettlement,
  releaseAiCall,
  reserveAiCall,
  settleAiCall,
} from './ai-run-accounting.js';
import { stopAiRunForChild } from './ai-run-lifecycle.js';
import {
  AiCallLimitError,
  type AiRunClaimFence,
  AiRunNotFoundError,
  AiRunStoppedError,
  getAiRun,
  newAiRunId,
} from './ai-run-model.js';

const logger = createLogger({ level: 'info' });

/** The step a call belongs to, carried onto its usage row. */
export interface AiRunCallStep {
  stepIndex?: number;
  stepName?: string;
  stepInstanceId?: string;
  attempt?: number;
}

/** The run a call belongs to, on one database. */
export interface AiRunContext extends AiRunCallStep {
  runId: string;
  /** The run's database; its tenant's data. */
  db: DatabaseInterface;
  tenantId?: string | null;
  /** The claim fence of the job running the nearest durable run. */
  fence?: AiRunClaimFence;
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
    Partial<Pick<SmrtAiUsageEvent, 'className' | 'tenantId'>>;
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

/** A tracked call between its reservation and its end. */
export interface AiRunCallHandle {
  invocation: AiRunCallInvocation;
  reservation: AiCallReservation;
  /** The call answered: settle it (with its captured usage, or the fallback). */
  succeed(): Promise<void>;
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
  context: AiRunContext,
  request: AiRunCallRequest,
): Promise<AiRunCallHandle> {
  const callId = request.callId ?? newAiRunId();
  const entryCallId = request.entryCallId ?? callId;
  const reservation: AiCallReservation = await reserveAiCall(
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
    context.fence ? { fence: context.fence } : {},
  );

  const slot: { event?: SmrtAiUsageEvent; ended?: true } = {};
  const timeout =
    reservation.callTimeoutMs !== null
      ? AbortSignal.timeout(reservation.callTimeoutMs)
      : undefined;
  const signal =
    timeout && request.signal
      ? AbortSignal.any([timeout, request.signal])
      : (timeout ?? request.signal);
  const usageTags = aiRunCallTags(context, callId, entryCallId);

  const settle = async (event: SmrtAiUsageEvent, status: string) => {
    const tagged: SmrtAiUsageEvent = {
      ...event,
      tags: { ...(event.tags ?? {}), ...usageTags },
    };
    const input = { runId: context.runId, callId, usage: tagged, status };
    const afterSettle = request.afterSettle;
    const after = afterSettle ? () => afterSettle(tagged) : undefined;
    try {
      await settleAiCall(context.db, input);
    } catch (error) {
      logger.warn(
        `[smrt] AI run ${context.runId} settlement of call ${callId} failed; kept pending: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
  };

  return {
    reservation,
    invocation: {
      callId,
      entryCallId,
      outputLimit: reservation.outputLimit,
      usageTags,
      signal,
      capture(event) {
        slot.event = event;
      },
    },
    async succeed() {
      if (slot.ended) return;
      slot.ended = true;
      await settle(
        slot.event ?? {
          ...request.fallbackUsage,
          duration: 0,
          timestamp: new Date(),
        },
        'ok',
      );
    },
    async fail(error) {
      if (slot.ended) return error;
      slot.ended = true;
      if (slot.event) {
        await settle(slot.event, 'failed');
      } else {
        const timedOut = Boolean(timeout?.aborted);
        await releaseAiCall(context.db, {
          runId: context.runId,
          callId,
          status: timedOut
            ? 'timed_out'
            : isAbort(error)
              ? 'cancelled'
              : 'failed',
        }).catch((releaseError) => {
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
        return stopAiRunForChild(context.db, context.runId, error);
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
