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
  AI_USAGE_USER_TAG,
  getAiUsageUserResolver,
  normalizeAiUsageTags,
} from '../adapters/ai-usage-recorder.js';
import {
  AI_CALL_CORE_TAGS,
  AI_CALL_LOCATOR_TTL_MS,
  AI_CALL_PROOF_TAG,
  type ApplyCallUsageRequest,
  type ApplyCallUsageResult,
  admitHeldCall,
  admitWithReservation,
  applyCallUsage,
  type CallAdmission,
  type CallRowTemplate,
  type CallUsageInput,
  type CallUsageMode,
  callInternals,
  callProofDigest,
  callUsageHeld,
  callUsageInputFromRaw,
  closeCallLocator,
  emptyCallUsage,
  foldCallUsage,
  isTransactionHandle,
  markSenderRecord,
  mintCallSecret,
  observedUsageParts,
  parseUsagePart,
  queueCallClose,
  registerCallLocator,
} from './ai-call-ledger.js';
import {
  type AiCallRate,
  type AiCallReservation,
  type AiCallReservationRequest,
  deferAiRunSettlement,
  reserveAiCall,
  settleAiCall,
} from './ai-run-accounting.js';
import { stopAiRunForChild } from './ai-run-lifecycle.js';
import {
  AiCallLimitError,
  type AiRunClaimFence,
  AiRunNotFoundError,
  type AiRunScopedTxOptions,
  AiRunStoppedError,
  type AiRunTxOptions,
  getAiRun,
  newAiRunId,
  rememberSettlementTenant,
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

/** A usage tag value read once: a string, else nothing. */
function readUser(): string | undefined {
  const resolver = getAiUsageUserResolver();
  if (!resolver) return undefined;
  try {
    const user = resolver();
    return typeof user === 'string' && user.length > 0 ? user : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The tags of a call's billed row, fixed at admission (plan section 3.1), in
 * rising precedence: the sink attribution's and the client's provider-level
 * tags, the tags the call is sent with, then core's own (its call id, entry
 * call id, run and step). Core's tag names are removed from the first two
 * sources. An explicit `userId` wins; otherwise the ambient user resolver's,
 * read now, at admission.
 */
function billedRowTags(
  attributionTags: Record<string, string> | undefined,
  callTags: Record<string, string> | undefined,
  coreTags: Record<string, string>,
): Record<string, string> {
  const callers = (tags: Record<string, string> | undefined) => {
    const out = normalizeAiUsageTags(tags) ?? {};
    for (const name of AI_CALL_CORE_TAGS) delete out[name];
    return out;
  };
  const merged = { ...callers(attributionTags), ...callers(callTags) };
  const user = merged[AI_USAGE_USER_TAG] ? undefined : readUser();
  return {
    ...merged,
    ...(user ? { [AI_USAGE_USER_TAG]: user } : {}),
    ...coreTags,
  };
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
  const input = { runId: context.runId, callId, usage: tagged, status };
  // The record is the sender's own: it carries the call id and reaches the
  // handlers (a forwarded copy would not).
  const after = afterSettle
    ? () => afterSettle(markSenderRecord(tagged))
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
  // The ledger is written only in transactions core owns: a caller's
  // transaction could roll the charge back after the handlers ran.
  if (isTransactionHandle(context.db)) {
    throw new TypeError(
      'beginAiRunCall: the run context database is a transaction; pass the database itself, a tracked call writes its ledger in transactions it owns',
    );
  }
  const internals = callInternals(request);
  const mode: CallUsageMode = internals?.mode ?? 'single';
  const secret = mintCallSecret();
  const proof = await callProofDigest(secret);
  const held = context.reservations?.take();
  const callId = held?.reservation.callId ?? request.callId ?? newAiRunId();
  const entryCallId = request.entryCallId ?? callId;
  const coreTags = aiRunCallTags(context, callId, entryCallId);
  const fallback = request.fallbackUsage;
  const rowTags = billedRowTags(
    internals?.attributionTags,
    fallback.tags,
    coreTags,
  );
  const admission = (now: Date): CallAdmission => ({
    callProof: proof,
    callRow: JSON.stringify({
      provider: fallback.provider,
      model: fallback.model,
      operation: fallback.operation,
      ...(fallback.className ? { className: fallback.className } : {}),
      tags: rowTags,
      createdAt: now.toISOString(),
    } satisfies CallRowTemplate),
    callUsage: JSON.stringify(emptyCallUsage(mode)),
  });
  if (held) {
    await admitHeldCall(
      context.db,
      context.runId,
      callId,
      {
        checkRunning: Boolean(held.checkRunning),
        ...(context.fence ? { fence: context.fence } : {}),
        ...(context.tenantId !== undefined
          ? { expectedTenant: context.tenantId ?? null }
          : {}),
      },
      admission,
    );
  }
  const reservation: AiCallReservation = held
    ? held.reservation
    : await reserveAiCall(
        context.db,
        context.runId,
        admitWithReservation<AiCallReservationRequest>(
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
          admission,
        ),
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
  // The secret travels in the call's usage tags (the SDK echoes them on its
  // events) and in this closure; core removes it from everything it stores.
  const usageTags = { ...coreTags, [AI_CALL_PROOF_TAG]: secret };

  // The handle's memory: the usage that reached it while it was open, folded
  // the same way the ledger folds it; refusals counted for its write.
  const slot = {
    inputs: [] as CallUsageInput[],
    state: emptyCallUsage(mode),
    refused: {} as Record<string, number>,
    ending: false,
    notified: false,
  };
  const ledgerRequest = (
    inputs: CallUsageInput[],
    caller: 'sender' | 'delivery',
    extra: Partial<ApplyCallUsageRequest> = {},
  ): ApplyCallUsageRequest => ({
    runId: context.runId,
    callId,
    ...(context.tenantId !== undefined
      ? { expectedTenant: context.tenantId ?? null }
      : {}),
    caller,
    inputs,
    mode,
    ...extra,
  });
  const accept = (input?: CallUsageInput, refused?: string) => {
    if (refused || !input) {
      const reason = refused ?? 'malformed';
      slot.refused[reason] = (slot.refused[reason] ?? 0) + 1;
      return;
    }
    const step = foldCallUsage(slot.state, input);
    if (step.refused) {
      slot.refused[step.refused] = (slot.refused[step.refused] ?? 0) + 1;
      return;
    }
    if (!step.changed) return;
    slot.state = step.state;
    slot.inputs.push(input);
  };
  // After the handle closed: a parts-mode call applies a late part through
  // the ledger on the call's own database; a single-mode one refuses it.
  const late = async (input?: CallUsageInput, refused?: string) => {
    try {
      await applyCallUsage(
        context.db,
        ledgerRequest(input ? [input] : [], 'delivery', {
          ...(refused ? { refusedCounts: { [refused]: 1 } } : {}),
        }),
      );
    } catch (error) {
      logger.warn(
        `[smrt] AI run ${context.runId} call ${callId}: a late usage part could not be applied: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  const receive = async (input?: CallUsageInput, refused?: string) => {
    if (!slot.ending) {
      accept(input, refused);
      return;
    }
    await late(input, refused);
  };
  registerCallLocator(secret, {
    callId,
    deliver: async (raw) => {
      const { input, refused } = callUsageInputFromRaw(raw, mode);
      await receive(input, refused);
    },
  });
  const notify = async (result: ApplyCallUsageResult) => {
    if (slot.notified || !('record' in result) || !result.record) return;
    slot.notified = true;
    if (!request.afterSettle) return;
    try {
      await request.afterSettle(result.record);
    } catch (error) {
      logger.warn(
        `[smrt] AI usage handlers failed for call ${callId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  /**
   * The sender's closing write; one that fails every retry is queued and
   * written by the next flush, which notifies the handlers once it commits.
   */
  const close = async (
    status: string,
    inputs: CallUsageInput[],
    releaseIfEmpty: boolean,
  ): Promise<ApplyCallUsageResult['outcome'] | 'queued'> => {
    const write = async (options: AiRunTxOptions = {}) => {
      const result = await applyCallUsage(
        context.db,
        ledgerRequest(inputs, 'sender', {
          status,
          refusedCounts: slot.refused,
          ...(releaseIfEmpty ? { releaseIfEmpty } : {}),
        }),
        options,
      );
      await notify(result);
      return result;
    };
    try {
      return (await write()).outcome;
    } catch (error) {
      logger.warn(
        `[smrt] AI run ${context.runId} settlement of call ${callId} failed; kept pending: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      queueCallClose(context.db, {
        runId: context.runId,
        callId,
        write: async (options) => {
          await write(options);
        },
      });
      return 'queued';
    } finally {
      closeCallLocator(secret, AI_CALL_LOCATOR_TTL_MS);
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
        // A normalized event the sender's own code hands over: bound to
        // this call by construction.
        const raw = event as SmrtAiUsageEvent & { part?: unknown };
        const usage = raw.usage
          ? {
              ...(raw.usage.promptTokens !== undefined
                ? { promptTokens: raw.usage.promptTokens }
                : {}),
              ...(raw.usage.completionTokens !== undefined
                ? { completionTokens: raw.usage.completionTokens }
                : {}),
              ...(raw.usage.totalTokens !== undefined
                ? { totalTokens: raw.usage.totalTokens }
                : {}),
            }
          : undefined;
        const common = {
          ...(usage ? { usage } : {}),
          ...(raw.model ? { model: raw.model } : {}),
          ...(raw.provider ? { provider: raw.provider } : {}),
          ...(typeof raw.duration === 'number'
            ? { duration: raw.duration }
            : {}),
        };
        if (mode === 'single') {
          void receive({ kind: 'event', ...common });
          return;
        }
        const part = parseUsagePart(raw.part);
        if (part === undefined) void receive(undefined, 'no_part');
        else if (part === null) void receive(undefined, 'malformed');
        else void receive({ kind: 'part', part, ...common });
      },
    },
    async succeed(observed) {
      if (slot.ending) return;
      slot.ending = true;
      const inputs = [...slot.inputs];
      if (mode === 'parts') {
        const parts = observedUsageParts(observed);
        if (parts) inputs.push(parts);
      } else if (observed) {
        inputs.push({
          kind: 'stated',
          ...(observed.usage ? { usage: observed.usage } : {}),
          ...(observed.estimatedCost !== undefined
            ? { estimatedCost: observed.estimatedCost }
            : {}),
          ...(observed.model ? { model: observed.model } : {}),
          ...(observed.duration !== undefined
            ? { duration: observed.duration }
            : {}),
        });
      }
      await close('ok', inputs, false);
    },
    async fail(error) {
      if (slot.ending) return error;
      slot.ending = true;
      const timedOut = Boolean(timeout?.aborted);
      const status = timedOut
        ? 'timed_out'
        : isAbort(error)
          ? 'cancelled'
          : 'failed';
      // Settled with how it ended when the handle or the reservation holds
      // any usage, counted or count-less; released otherwise.
      const outcome = await close(status, [...slot.inputs], true);
      if (
        timedOut &&
        !callUsageHeld(slot.state) &&
        (outcome === 'released' || outcome === 'queued')
      ) {
        return new AiCallLimitError(
          `The call exceeded callTimeoutMs ${reservation.callTimeoutMs}`,
          'callTimeoutMs',
          context.runId,
        );
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
