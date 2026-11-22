/**
 * A tracked call's usage event that arrives after the call ended (#5005;
 * docs/content/ai-runs.md section 6.4, late usage).
 *
 * The provider SDK starts its usage callback without awaiting it, and an
 * app's own async `onUsage` runs before core routes the event, so a call's
 * usage can reach the pipeline after the call returned and after its own
 * capture was removed. Each tracked call therefore has a route here, keyed
 * by the call id core minted for it and holding the call's database, run and
 * tenant. `dispatchAiUsageEvent` hands an event to the route only when all
 * three match (a caller's `aiCallId` tag alone never does), and the route
 * takes it only when it has something to apply:
 *
 * - a call released without usage is settled late, once;
 * - a call settled from its response or the fallback row has its usage row
 *   and run totals corrected to the provider's measured counts, once, after
 *   its settlement has committed (a queued settlement included), retried
 *   when the correction transaction fails;
 * - anything else (a settled call's repeated or unmeasured event) is not
 *   taken and reaches the usage handlers as it would without a route.
 *
 * When the route is gone (another process, after an hour, after 10 000
 * newer calls), {@link reconcileLateAiRunUsage} still settles a released
 * call from the persisted reservation; a call settled from its response
 * keeps those counts (the documented limit).
 *
 * Nothing here is part of the package surface: `system/browser.ts` does not
 * re-export this module.
 */

import { createLogger } from '@happyvertical/logger';
import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  AI_OWN_CALL_ID_TAG,
  setAiRunLateUsageHooks,
} from '../adapters/ai-usage.js';
import { settleAiCall } from './ai-run-accounting.js';
import {
  type AiRunRow,
  type AiRunScopedTxOptions,
  type AiRunTxOptions,
  actualsOf,
  aiRunQuery,
  getRows,
  lockAiRunChain,
  num,
  text,
  withAiRunTransaction,
  writeAiRunTotals,
} from './ai-run-model.js';

const logger = createLogger({ level: 'info' });

/** How long a tracked call's route is kept after the call began. */
const ROUTE_TTL_MS = 60 * 60 * 1000;
/** At most this many routes are kept per process (oldest dropped first). */
const ROUTE_LIMIT = 10_000;
/** Retries of a correction whose transaction failed. */
const CORRECTION_RETRIES = 5;

/** Whether an event carries a measured token count. */
export function isMeasuredAiUsage(event: SmrtAiUsageEvent): boolean {
  const usage = event.usage as Record<string, unknown> | undefined;
  return ['promptTokens', 'completionTokens', 'totalTokens'].some(
    (key) =>
      typeof usage?.[key] === 'number' && Number.isFinite(usage[key] as number),
  );
}

/** What correcting a call's usage did. */
type Correction = 'applied' | 'unchanged' | 'not_settled' | 'foreign';

/**
 * Replace a settled call's usage with the provider's measured usage: the
 * usage row (only the run's own row, in the run's tenant) is updated in
 * place and the chain's totals move by the difference, never below zero,
 * in one chain transaction. A row of another run or tenant under the call
 * id is never touched ('foreign').
 */
async function correctAiCallUsage(
  db: DatabaseInterface,
  input: { runId: string; callId: string; usage: SmrtAiUsageEvent },
  options: AiRunTxOptions = {},
): Promise<Correction> {
  return withAiRunTransaction(
    db,
    async (tx) => {
      const chain = await lockAiRunChain(tx, input.runId);
      const caller = chain[chain.length - 1] as AiRunRow;
      const event = getRows(
        await aiRunQuery(
          tx.db,
          `SELECT reservation, reserved_tokens FROM _smrt_ai_run_events
            WHERE run_id = $1 AND call_id = $2 AND type = 'call'`,
          input.runId,
          input.callId,
        ),
      )[0];
      if (
        !event ||
        !['settled', 'settled_late'].includes(String(event.reservation))
      ) {
        return 'not_settled';
      }
      const row = getRows(
        await aiRunQuery(
          tx.db,
          `SELECT run_id, tenant_id, prompt_tokens, completion_tokens,
                  total_tokens, estimated_cost
             FROM _smrt_ai_usage WHERE id = $1`,
          input.callId,
        ),
      )[0];
      if (!row) return 'not_settled';
      const tenant = caller.tenantId ?? null;
      if (
        text(row.run_id) !== input.runId ||
        (text(row.tenant_id) ?? null) !== tenant
      ) {
        return 'foreign';
      }
      const reserved = num(event.reserved_tokens ?? 0);
      const nullable = (value: unknown) =>
        value === null || value === undefined ? null : num(value);
      const before = actualsOf(
        {
          promptTokens: nullable(row.prompt_tokens),
          completionTokens: nullable(row.completion_tokens),
          totalTokens: nullable(row.total_tokens),
          estimatedCost: nullable(row.estimated_cost),
        },
        reserved,
      );
      const usage = input.usage;
      const after = actualsOf(
        {
          promptTokens: usage.usage?.promptTokens ?? null,
          completionTokens: usage.usage?.completionTokens ?? null,
          totalTokens: usage.usage?.totalTokens ?? null,
          estimatedCost: usage.estimatedCost ?? null,
        },
        reserved,
      );
      const tenantPredicate =
        tenant === null ? 'tenant_id IS NULL' : 'tenant_id = $10';
      await aiRunQuery(
        tx.db,
        `UPDATE _smrt_ai_usage
            SET prompt_tokens = $3, completion_tokens = $4, total_tokens = $5,
                estimated_cost = $6, model = $7, provider = $8, duration = $9
          WHERE id = $1 AND run_id = $2 AND ${tenantPredicate}`,
        input.callId,
        input.runId,
        usage.usage?.promptTokens ?? null,
        usage.usage?.completionTokens ?? null,
        usage.usage?.totalTokens ?? null,
        usage.estimatedCost ?? null,
        usage.model,
        usage.provider,
        usage.duration ?? 0,
        ...(tenant === null ? [] : [tenant]),
      );
      if (before.tokens === after.tokens && before.cost === after.cost) {
        return 'unchanged';
      }
      const tokens = after.tokens - before.tokens;
      const uncosted =
        (after.cost === null ? 1 : 0) - (before.cost === null ? 1 : 0);
      const cost = (after.cost ?? 0) - (before.cost ?? 0);
      const floor = (value: number) => Math.max(0, value);
      for (const run of chain) {
        run.inclusiveTokens = floor(run.inclusiveTokens + tokens);
        run.inclusiveUncostedCalls = floor(
          run.inclusiveUncostedCalls + uncosted,
        );
        run.inclusiveCost = floor(run.inclusiveCost + cost);
        if (run === caller) {
          run.tokens = floor(run.tokens + tokens);
          run.uncostedCalls = floor(run.uncostedCalls + uncosted);
          run.costUsed = floor(run.costUsed + cost);
        }
        await writeAiRunTotals(tx, run);
      }
      return 'applied';
    },
    options,
  );
}

/** Where a tracked call's late usage goes; see the module comment. */
export class AiRunCallRoute {
  /** The measured usage event captured while the call ran. */
  measured?: SmrtAiUsageEvent;
  /** An unmeasured event (a decision's provenance) captured while it ran. */
  provisional?: SmrtAiUsageEvent;
  ended = false;
  /** How the call was released without usage; cleared once settled late. */
  private releasedAs?: string;
  /** Settled from its response or the fallback row: correctable once. */
  private correctable = false;
  private corrected = false;
  /** The settlement has committed (a queued one included). */
  private settled = false;
  private pending?: SmrtAiUsageEvent;
  private correcting = false;
  private retries = 0;
  readonly until = Date.now() + ROUTE_TTL_MS;

  constructor(
    readonly callId: string,
    readonly db: DatabaseInterface,
    readonly runId: string,
    private tenantId: string | null | undefined,
    private readonly settleLate: (
      event: SmrtAiUsageEvent,
      status: string,
    ) => Promise<void>,
  ) {}

  /** The event to settle a call that answered, and whether it is final. */
  settlementEvent(): SmrtAiUsageEvent | undefined {
    this.correctable = !this.measured;
    return this.measured ?? this.provisional;
  }

  /** The call ended without any usage: released with `status`. */
  released(status: string): void {
    this.releasedAs = status;
  }

  /** The settlement committed: a correction that waited for it runs now. */
  settlementCommitted(): void {
    this.settled = true;
    if (this.pending) void this.applyCorrection();
  }

  /**
   * Take a usage event of this call. Before the call ended it is kept for
   * the settlement (a measured event wins over an unmeasured one). After,
   * it is taken only when there is something to apply; returns whether it
   * was taken.
   */
  capture(event: SmrtAiUsageEvent): boolean {
    if (!this.ended) {
      if (isMeasuredAiUsage(event)) this.measured = event;
      else if (!this.measured && !this.provisional) this.provisional = event;
      return true;
    }
    if (this.releasedAs !== undefined) {
      const status = this.releasedAs;
      this.releasedAs = undefined;
      void this.settleLate(event, status);
      return true;
    }
    if (this.correctable && !this.corrected && isMeasuredAiUsage(event)) {
      // A redelivery (of the same measurement) restarts a correction whose
      // retries ran out; one already running is not doubled.
      this.pending = event;
      if (this.settled) void this.applyCorrection();
      return true;
    }
    return false;
  }

  /**
   * Take an event delivered through a usage pipeline (not the call's own
   * capture): only when it names this call's run, was recorded for this
   * call's tenant and is being written to this call's database.
   */
  async take(event: SmrtAiUsageEvent, db: DatabaseInterface): Promise<boolean> {
    if (db !== this.db || event.tags?.runId !== this.runId) return false;
    if (this.tenantId === undefined) {
      const row = getRows(
        await aiRunQuery(
          db,
          'SELECT tenant_id FROM _smrt_ai_runs WHERE id = $1',
          this.runId,
        ),
      )[0];
      if (!row) return false;
      this.tenantId = text(row.tenant_id) ?? null;
    }
    if ((event.tenantId ?? null) !== this.tenantId) return false;
    return this.capture(event);
  }

  private async applyCorrection(): Promise<void> {
    if (this.correcting || !this.pending || this.corrected) return;
    this.correcting = true;
    try {
      const outcome = await correctAiCallUsage(this.db, {
        runId: this.runId,
        callId: this.callId,
        usage: this.pending,
      });
      // Not settled yet (a queued settlement): applied when it commits.
      if (outcome !== 'not_settled') {
        this.corrected = true;
        this.pending = undefined;
      }
    } catch (error) {
      logger.warn(
        `[smrt] AI run ${this.runId} could not apply the late usage of call ${this.callId} yet: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Retried on a back-off; once the retries run out the measurement
      // stays pending, and a redelivery of it starts again.
      if (this.retries >= CORRECTION_RETRIES) {
        this.retries = 0;
        return;
      }
      this.retries++;
      const timer = setTimeout(
        () => void this.applyCorrection(),
        1000 * 2 ** this.retries,
      );
      (timer as { unref?: () => void }).unref?.();
    } finally {
      this.correcting = false;
    }
  }
}

const routes = new Map<string, AiRunCallRoute>();

/** Keep the route of a call core just minted an id for. */
export function openAiRunCallRoute(route: AiRunCallRoute): AiRunCallRoute {
  const now = Date.now();
  routes.delete(route.callId);
  routes.set(route.callId, route);
  for (const [id, kept] of routes) {
    if (routes.size <= ROUTE_LIMIT && kept.until > now) break;
    routes.delete(id);
  }
  return route;
}

function liveRoute(callId: unknown): AiRunCallRoute | undefined {
  if (typeof callId !== 'string' || callId === '') return undefined;
  const route = routes.get(callId);
  if (route && route.until <= Date.now()) {
    routes.delete(callId);
    return undefined;
  }
  return route;
}

/**
 * Settle a released (or abandoned) call from a late usage event when this
 * process no longer has its route, from the persisted reservation: the run
 * must exist in the event's tenant and its call must still be released or
 * abandoned. Returns whether it settled it (its usage row then written by
 * the settlement, with the run's totals).
 */
export async function reconcileLateAiRunUsage(
  event: SmrtAiUsageEvent,
  db: DatabaseInterface,
): Promise<boolean> {
  const callId = event.tags?.[AI_OWN_CALL_ID_TAG];
  const runId = event.tags?.runId;
  if (typeof callId !== 'string' || typeof runId !== 'string') return false;
  if (liveRoute(callId)) return false;
  const run = getRows(
    await aiRunQuery(
      db,
      'SELECT tenant_id FROM _smrt_ai_runs WHERE id = $1',
      runId,
    ),
  )[0];
  if (!run || (text(run.tenant_id) ?? null) !== (event.tenantId ?? null)) {
    return false;
  }
  const call = getRows(
    await aiRunQuery(
      db,
      `SELECT reservation, status FROM _smrt_ai_run_events
        WHERE run_id = $1 AND call_id = $2 AND type = 'call'`,
      runId,
      callId,
    ),
  )[0];
  if (!call || !['released', 'abandoned'].includes(String(call.reservation))) {
    return false;
  }
  // The settlement locks the chain in the event's tenant, so the tenant
  // checked above is the one the charge is written in.
  await settleAiCall(
    db,
    { runId, callId, usage: event, status: text(call.status) ?? 'failed' },
    { expectedTenant: event.tenantId ?? null } as AiRunScopedTxOptions,
  );
  return true;
}

/**
 * Whether a usage event names a tracked call core minted, in the event's
 * tenant on this database: this process's route of the call, or the call's
 * persisted `call` event in a run of that tenant (another process's call).
 */
async function isTrackedAiRunCall(
  event: SmrtAiUsageEvent,
  db: DatabaseInterface,
): Promise<boolean> {
  const callId = event.tags?.[AI_OWN_CALL_ID_TAG];
  if (typeof callId !== 'string' || callId === '') return false;
  const route = liveRoute(callId);
  if (route) return route.db === db;
  const tenant = event.tenantId ?? null;
  const rows = getRows(
    await aiRunQuery(
      db,
      `SELECT r.tenant_id FROM _smrt_ai_run_events e
         JOIN _smrt_ai_runs r ON r.id = e.run_id
        WHERE e.call_id = $1 AND e.type = 'call'`,
      callId,
    ),
  );
  return rows.some((row) => (text(row.tenant_id) ?? null) === tenant);
}

setAiRunLateUsageHooks({
  isTrackedCall: isTrackedAiRunCall,
  route: async (event, db) =>
    (await liveRoute(event.tags?.[AI_OWN_CALL_ID_TAG])?.take(event, db)) ??
    false,
  reconcile: reconcileLateAiRunUsage,
});
