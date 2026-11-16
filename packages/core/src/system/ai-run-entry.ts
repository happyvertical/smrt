/**
 * A run that answers one entry call (#5005; docs/content/ai-runs.md sections
 * 2, 3 and 6.2-6.4): a fusion, opened when it starts and closed when it
 * ends. Core never imports the executor that drives it; the executor gets
 * this through the execution context (`openRun`).
 *
 * - Opening needs usage tracking ({@link AiRunTrackingDisabledError} before
 *   any call is sent). Inside a run (the entry call carries a `runContext`),
 *   the new run is its child, and the parent records a `handoff` event naming
 *   it, with `call_id` the entry call, in the same transaction.
 * - The calls reserve together, all or none ({@link AiEntryRun.reserve}):
 *   every panel seat and the judge in one transaction. A refusal stops the
 *   run with the limit's reason before anything is sent. Each seat's first
 *   call takes its share; the judge checks its chain is still `running` just
 *   before it is sent. Shares never taken are released at the end.
 * - The end writes the run's status and the `handoff` event's status (`done`,
 *   `stopped`, `cancelled` or `failed`). A stop reaches the parent as a stop
 *   ({@link AiEntryRun.stop}), never as a failed call.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type AiCallRate,
  type AiCallReservation,
  type AiCallReservationRequest,
  releaseAiCall,
  reserveAiCalls,
} from './ai-run-accounting.js';
import type {
  AiRunContext,
  AiRunHeldReservation,
  AiRunHeldReservations,
} from './ai-run-calls.js';
import { closeAiRunHandoff } from './ai-run-events.js';
import {
  type AiRunStore,
  aiRunStoppedError,
  finishAiRun,
  openAiRun,
  stopAiRunForChild,
  updateAiRun,
} from './ai-run-lifecycle.js';
import {
  type AiRunBudget,
  type AiRunRow,
  AiRunStoppedError,
  getAiRun,
  newAiRunId,
} from './ai-run-model.js';

/** Input of {@link openAiEntryRun}. */
export interface OpenAiEntryRunInput {
  /** `fusion`, or an owner's `@scope/pkg:type`. */
  type: string;
  definitionKey?: string | null;
  definitionVersion?: string | null;
  /** The prompt the entry call answered. */
  promptKey?: string | null;
  templateHash?: string | null;
  mode?: string | null;
  budget?: AiRunBudget;
  /** The run that made the entry call, when it was made inside one. */
  parent?: AiRunContext | null;
  /** The entry call's id; minted when absent. */
  entryCallId?: string | null;
  /** The rate card entry of a call, or null for an uncosted model. */
  rateFor?: (provider: string, model: string) => AiCallRate | null;
}

/** One call's share of a joint reservation. */
export interface AiEntryRunCallRequest {
  /** The seat (or call) name; one share per name. */
  name: string;
  /** Priced from the rate card when both are known; else uncosted. */
  provider?: string | null;
  model?: string | null;
  inputTokens?: number;
  inputChars?: number;
  outputLimit?: number;
  expectedOutputTokens?: number;
  modelMaxOutput?: number;
  /** Sent after the first stage (the judge): checked `running` first. */
  later?: boolean;
}

/** How an entry run ended without a stop. */
export type AiEntryRunOutcome =
  | {
      status: 'done';
      degraded?: boolean;
      seats?: number | null;
      degradedSeats?: number | null;
      details?: Record<string, unknown> | null;
    }
  | {
      status: 'failed';
      seats?: number | null;
      degradedSeats?: number | null;
      details?: Record<string, unknown> | null;
    };

/** An open entry run; see {@link openAiEntryRun}. */
export interface AiEntryRun {
  readonly run: AiRunRow;
  readonly runId: string;
  readonly entryCallId: string;
  /** The `handoff` event in the parent, when there is a parent. */
  readonly handoffEventId: string | null;
  /** The context the run's calls carry (`runContext`). */
  readonly context: AiRunContext;
  /** The context for one named call: it takes that call's share. */
  contextFor(name: string): AiRunContext;
  /** Reserve every call's share together, all or none. */
  reserve(requests: readonly AiEntryRunCallRequest[]): Promise<void>;
  /** Close a run that ended without a stop. */
  close(outcome: AiEntryRunOutcome): Promise<AiRunRow | null>;
  /**
   * The run (or an ancestor) stopped: release the shares never taken, end
   * the `handoff`, and, when the run has a parent, move the parent out of
   * `running` with the child's stop (page section 6.2). Returns the error
   * the entry call raises: the parent's, or the run's own.
   */
  stop(error?: unknown): Promise<AiRunStoppedError>;
}

/**
 * Open a run that answers an entry call (page section 3: a fusion's row is
 * written when it starts). Throws {@link AiRunTrackingDisabledError} when
 * usage tracking is off, before anything is written or sent.
 */
export async function openAiEntryRun(
  store: AiRunStore,
  input: OpenAiEntryRunInput,
): Promise<AiEntryRun> {
  const parent = input.parent ?? null;
  const entryCallId = input.entryCallId ?? newAiRunId();
  const handoffEventId = parent ? newAiRunId() : null;
  const runStore: AiRunStore = parent
    ? { ...store, db: parent.db, tenantId: parent.tenantId ?? store.tenantId }
    : store;
  const run = await openAiRun(runStore, {
    type: input.type,
    definitionKey: input.definitionKey ?? null,
    definitionVersion: input.definitionVersion ?? null,
    promptKey: input.promptKey ?? null,
    templateHash: input.templateHash ?? null,
    mode: input.mode ?? null,
    ...(input.budget ? { budget: input.budget } : {}),
    ...(parent
      ? {
          parentRunId: parent.runId,
          handoff: {
            eventId: handoffEventId as string,
            callId: entryCallId,
            name: input.definitionKey ?? null,
            stepIndex: parent.stepIndex ?? null,
          },
        }
      : {}),
  });
  const db = runStore.db as DatabaseInterface;
  const context: AiRunContext = {
    runId: run.id,
    db,
    tenantId: run.tenantId,
    ...(parent?.fence ? { fence: parent.fence } : {}),
  };
  const held = new Map<string, AiRunHeldReservation>();
  let ended = false;

  const releaseUnused = async () => {
    for (const [name, share] of held) {
      held.delete(name);
      await releaseAiCall(db, {
        runId: run.id,
        callId: share.reservation.callId,
        status: 'cancelled',
      });
    }
  };
  const endHandoff = async (status: AiRunRow['status']) => {
    if (!parent || !handoffEventId) return;
    const handoff =
      status === 'done'
        ? 'done'
        : status === 'cancelled'
          ? 'cancelled'
          : status === 'failed'
            ? 'failed'
            : 'stopped';
    await closeAiRunHandoff(parent.db, parent.runId, handoffEventId, handoff);
  };

  return {
    run,
    runId: run.id,
    entryCallId,
    handoffEventId,
    context,
    contextFor(name) {
      const pool: AiRunHeldReservations = {
        take() {
          const share = held.get(name);
          if (share) held.delete(name);
          return share;
        },
      };
      return { ...context, reservations: pool };
    },
    async reserve(requests) {
      const named = new Set<string>();
      const prepared: AiCallReservationRequest[] = requests.map((request) => {
        if (named.has(request.name)) {
          throw new TypeError(
            `AI run ${run.id}: two calls share the name ${request.name}`,
          );
        }
        named.add(request.name);
        const rate =
          request.provider && request.model && input.rateFor
            ? input.rateFor(request.provider, request.model)
            : null;
        return {
          name: request.name,
          rate,
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
        };
      });
      const reservations: AiCallReservation[] = await reserveAiCalls(
        db,
        run.id,
        prepared,
        parent?.fence ? { fence: parent.fence } : {},
      );
      for (const [i, reservation] of reservations.entries()) {
        const request = requests[i] as AiEntryRunCallRequest;
        held.set(request.name, {
          reservation,
          ...(request.later ? { checkRunning: true } : {}),
        });
      }
    },
    async close(outcome) {
      if (ended) return getAiRun(db, run.id);
      ended = true;
      await releaseUnused();
      await updateAiRun(db, run.id, {
        ...(outcome.seats !== undefined ? { seats: outcome.seats } : {}),
        ...(outcome.degradedSeats !== undefined
          ? { degradedSeats: outcome.degradedSeats }
          : {}),
        ...(outcome.details !== undefined ? { details: outcome.details } : {}),
      });
      await finishAiRun(
        db,
        run.id,
        outcome.status === 'done'
          ? { status: 'done', degraded: Boolean(outcome.degraded) }
          : { status: 'failed', stopReason: 'error' },
      );
      // Whatever it ended as (a stop by an ancestor may have won).
      const after = await getAiRun(db, run.id);
      if (after) await endHandoff(after.status);
      return after;
    },
    async stop(error) {
      if (!ended) {
        ended = true;
        await releaseUnused();
      }
      const after = await getAiRun(db, run.id);
      const own =
        after && after.status !== 'running'
          ? aiRunStoppedError(after)
          : error instanceof AiRunStoppedError
            ? error
            : aiRunStoppedError(after ?? run);
      if (after && after.status !== 'running') await endHandoff(after.status);
      if (!parent) return own;
      return stopAiRunForChild(parent.db, parent.runId, own);
    },
  };
}
