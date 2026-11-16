/**
 * Budget accounting of AI runs (#5005; page section 6): reserve, settle,
 * release, reconciliation after a crash, the `ai-runs` sweep, and the
 * operator's totals check and repair.
 *
 * Run totals are the authority for budgets and change only here, in short
 * transactions that lock the chain root first and write the event that
 * justifies each change. A call is charged once: to its run's own totals and
 * to the inclusive totals of its run and every ancestor. Settlement never
 * looks at a run's status: spending that happened is counted.
 */

import { createLogger } from '@happyvertical/logger';
import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { insertAiUsageRow } from '../adapters/ai-usage.js';
import {
  type AiRunReservationState,
  insertAiRunEventTx,
} from './ai-run-events.js';
import {
  checkAiRunChainRunning,
  stopAiRunAtLimitTx,
  writeAiRunStatusTx,
} from './ai-run-lifecycle.js';
import {
  AiCallLimitError,
  type AiRunBudgetLimit,
  type AiRunClaimFence,
  AiRunError,
  AiRunNotFoundError,
  type AiRunRow,
  type AiRunStopDetail,
  AiRunStoppedError,
  type AiRunTx,
  type AiRunTxOptions,
  aiRunActiveTime,
  aiRunQuery,
  dateOrNull,
  getAiRun,
  getRows,
  isAiRunFinal,
  isAiRunRetryable,
  lockAiRun,
  lockAiRunChain,
  lockAiRunChainFenced,
  newAiRunId,
  num,
  readAiRunChainIds,
  withAiRunTransaction,
  writeAiRunTotals,
} from './ai-run-model.js';

const logger = createLogger({ level: 'info' });

// ---------------------------------------------------------------------------
// Sizing a reservation (page section 6.3)
// ---------------------------------------------------------------------------

/** The default output allowance `D` when a prompt declares none. */
export const AI_RUN_DEFAULT_OUTPUT_TOKENS = 4096;

/** A rate card entry, per 1,000 tokens. */
export interface AiCallRate {
  input: number;
  output: number;
}

/** What one call asks to reserve. */
export interface AiCallReservationRequest {
  /** Minted before the call is sent when absent. */
  callId?: string;
  /** `E` from the provider's token count, when the client offers one. */
  inputTokens?: number;
  /** Else `E` is the request's characters divided by 4. */
  inputChars?: number;
  /** `O`: the request's own output-token limit. */
  outputLimit?: number;
  /** The prompt's declared output allowance (`expectedOutputTokens`). */
  expectedOutputTokens?: number;
  /** The model's maximum output, where its capabilities record it. */
  modelMaxOutput?: number;
  /** The call's rate; absent for a model with no price (uncosted). */
  rate?: AiCallRate | null;
  stepIndex?: number | null;
  /** Stored as the event's `name` (a fusion seat, a step name). */
  name?: string | null;
  parentEventId?: string | null;
}

/** A reservation's size. */
export interface AiCallReservationSize {
  /** `E`. */
  inputTokens: number;
  /** The output limit to send to the provider, or null to send none. */
  outputLimit: number | null;
  /** `R`. */
  reservedTokens: number;
  /** `C`; 0 for an uncosted call. */
  reservedCost: number;
  uncosted: boolean;
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Size one call's reservation (page section 6.3), given `M`, the smallest
 * `maxCallTokens` on the run and its ancestors. Returns `null` when the
 * request's input alone does not fit `M`.
 */
export function sizeAiCallReservation(
  request: AiCallReservationRequest,
  maxCallTokens?: number,
): AiCallReservationSize | null {
  const counted = positive(request.inputTokens);
  const inputTokens =
    counted !== undefined
      ? Math.ceil(counted)
      : Math.ceil((positive(request.inputChars) ?? 0) / 4);
  const own = positive(request.outputLimit);
  let outputLimit: number | null;
  let allowance: number;
  if (maxCallTokens !== undefined) {
    const room = Math.floor(maxCallTokens - inputTokens);
    if (room < 1) return null;
    outputLimit = own === undefined ? room : Math.min(Math.floor(own), room);
    allowance = outputLimit;
  } else if (own !== undefined) {
    outputLimit = Math.floor(own);
    allowance = outputLimit;
  } else {
    outputLimit = null;
    const declared =
      positive(request.expectedOutputTokens) ?? AI_RUN_DEFAULT_OUTPUT_TOKENS;
    const max = positive(request.modelMaxOutput);
    allowance = Math.ceil(
      max !== undefined ? Math.min(declared, max) : declared,
    );
  }
  const reservedTokens = inputTokens + allowance;
  const rate = request.rate;
  const uncosted = !rate;
  const reservedCost = rate
    ? (inputTokens * rate.input + allowance * rate.output) / 1000
    : 0;
  return { inputTokens, outputLimit, reservedTokens, reservedCost, uncosted };
}

/** One reserved call. */
export interface AiCallReservation extends AiCallReservationSize {
  runId: string;
  callId: string;
  eventId: string;
  seq: number;
  /** The smallest `callTimeoutMs` on the chain, if any. */
  callTimeoutMs: number | null;
}

/** Options of {@link reserveAiCalls}. */
export interface ReserveAiCallsOptions extends AiRunTxOptions {
  fence?: AiRunClaimFence;
}

function smallest(chain: AiRunRow[], key: 'maxCallTokens' | 'callTimeoutMs') {
  let out: number | undefined;
  for (const run of chain) {
    const value = run.budget[key];
    if (value !== undefined && (out === undefined || value < out)) out = value;
  }
  return out;
}

/** Room check of one run for `n` calls, `R` tokens and `C` cost. */
function lackOfRoom(
  run: AiRunRow,
  now: Date,
  want: { calls: number; tokens: number; cost: number },
): AiRunStopDetail | null {
  const budget = run.budget;
  if (budget.maxDurationMs !== undefined) {
    const active = aiRunActiveTime(run, now);
    if (active >= budget.maxDurationMs) {
      return {
        limit: 'maxDurationMs',
        runId: run.id,
        limitValue: budget.maxDurationMs,
        used: active,
        room: budget.maxDurationMs - active,
      };
    }
  }
  const checks: [
    AiRunBudgetLimit,
    number | undefined,
    number,
    number,
    number,
  ][] = [
    [
      'maxCalls',
      budget.maxCalls,
      run.inclusiveCalls,
      run.reservedCalls,
      want.calls,
    ],
    [
      'maxTokens',
      budget.maxTokens,
      run.inclusiveTokens,
      run.reservedTokens,
      want.tokens,
    ],
    ['maxCost', budget.maxCost, run.inclusiveCost, run.reservedCost, want.cost],
  ];
  for (const [limit, limitValue, used, reserved, requested] of checks) {
    if (limitValue === undefined) continue;
    if (limit === 'maxCost' && requested === 0) continue; // uncosted
    if (used + reserved + requested > limitValue) {
      return {
        limit,
        runId: run.id,
        limitValue,
        used,
        reserved,
        requested,
        room: limitValue - used - reserved,
      };
    }
  }
  return null;
}

/**
 * Reserve room for calls about to be sent, all or none, in one transaction
 * (page section 6.4): the claim fence for the nearest durable run, the chain
 * locked root first, every chain run `running` and with room for the whole
 * amount. A fusion's panel and judge reserve together this way. A refusal
 * stops the calling run (guarded) with the limit's reason and `stop_detail`
 * and throws {@link AiRunStoppedError} after the commit. A request whose
 * input alone exceeds `maxCallTokens` throws {@link AiCallLimitError} and
 * reserves nothing. A caller-supplied `callId` already used by a call, or
 * used twice in `requests`, throws a `TypeError` and reserves nothing. The
 * check holds the reserving run's chain only: two reservations in runs of
 * different chains that supply the same id at the same moment can both
 * pass (no unique index backs it, since DuckDB has no partial index); a
 * minted id never collides. The model is called only after this returns.
 */
export async function reserveAiCalls(
  db: DatabaseInterface,
  runId: string,
  requests: readonly AiCallReservationRequest[],
  options: ReserveAiCallsOptions = {},
): Promise<AiCallReservation[]> {
  if (requests.length === 0) return [];
  await flushAiRunSettlements(db, { runId });
  const prepared = requests.map((request) => ({
    request,
    callId: request.callId ?? newAiRunId(),
    eventId: newAiRunId(),
  }));
  if (new Set(prepared.map(({ callId }) => callId)).size !== prepared.length) {
    throw new TypeError('Each reserved AI call needs its own call id');
  }
  const supplied = prepared
    .filter(({ request }) => request.callId !== undefined)
    .map(({ callId }) => callId);
  const result = await withAiRunTransaction(
    db,
    async (tx): Promise<AiCallReservation[] | AiRunStoppedError> => {
      const chain = await lockAiRunChainFenced(tx, runId, options.fence);
      if (supplied.length > 0) {
        // A call id names one call: its one event and its usage row's id.
        const taken = getRows(
          await aiRunQuery(
            tx.db,
            `SELECT call_id FROM _smrt_ai_run_events
              WHERE type = 'call'
                AND call_id IN (${supplied.map((_, i) => `$${i + 1}`).join(', ')})
              LIMIT 1`,
            ...supplied,
          ),
        );
        if (taken[0]) {
          throw new TypeError(
            `AI call id ${String(taken[0].call_id)} is already reserved`,
          );
        }
      }
      const stopped = await checkAiRunChainRunning(tx, chain);
      if (stopped) return stopped;
      const run = chain[chain.length - 1] as AiRunRow;
      const maxCallTokens = smallest(chain, 'maxCallTokens');
      const sizes = prepared.map(({ request }) => {
        const size = sizeAiCallReservation(request, maxCallTokens);
        if (!size) {
          throw new AiCallLimitError(
            `The request's input alone exceeds maxCallTokens ${maxCallTokens}`,
            'maxCallTokens',
            runId,
          );
        }
        return size;
      });
      const want = {
        calls: sizes.length,
        tokens: sizes.reduce((sum, size) => sum + size.reservedTokens, 0),
        cost: sizes.reduce((sum, size) => sum + size.reservedCost, 0),
      };
      for (let i = chain.length - 1; i >= 0; i--) {
        const detail = lackOfRoom(chain[i] as AiRunRow, tx.now, want);
        if (detail) return stopAiRunAtLimitTx(tx, run, detail);
      }
      for (const chainRun of chain) {
        chainRun.reservedCalls += want.calls;
        chainRun.reservedTokens += want.tokens;
        chainRun.reservedCost += want.cost;
        await writeAiRunTotals(tx, chainRun);
      }
      const callTimeoutMs = smallest(chain, 'callTimeoutMs') ?? null;
      const out: AiCallReservation[] = [];
      for (const [i, { request, callId, eventId }] of prepared.entries()) {
        const size = sizes[i] as AiCallReservationSize;
        const seq = await insertAiRunEventTx(tx, runId, {
          id: eventId,
          type: 'call',
          callId,
          parentEventId: request.parentEventId ?? null,
          stepIndex: request.stepIndex ?? null,
          name: request.name ?? null,
          status: 'pending',
          reservation: 'reserved',
          reservedTokens: size.reservedTokens,
          reservedCost: size.reservedCost,
        });
        out.push({ ...size, runId, callId, eventId, seq, callTimeoutMs });
      }
      return out;
    },
    options,
  );
  if (result instanceof AiRunStoppedError) throw result;
  return result;
}

/** Reserve one call; see {@link reserveAiCalls}. */
export async function reserveAiCall(
  db: DatabaseInterface,
  runId: string,
  request: AiCallReservationRequest,
  options: ReserveAiCallsOptions = {},
): Promise<AiCallReservation> {
  const [reservation] = await reserveAiCalls(db, runId, [request], options);
  return reservation as AiCallReservation;
}

/**
 * The check a fusion makes just before sending its judge under the
 * reservation it already holds (page section 6.3): its chain must still be
 * `running`. When it is not, the judge's reservation is released and the
 * fusion run takes the stop it found; the error is thrown.
 */
export async function assertAiRunStillRunning(
  db: DatabaseInterface,
  runId: string,
  options: AiRunTxOptions & { releaseCallId?: string } = {},
): Promise<void> {
  const result = await withAiRunTransaction(
    db,
    async (tx) => {
      const chain = await lockAiRunChain(tx, runId);
      const stopped = await checkAiRunChainRunning(tx, chain);
      if (stopped && options.releaseCallId) {
        await releaseInTx(tx, chain, options.releaseCallId, 'cancelled');
      }
      return stopped;
    },
    options,
  );
  if (result) throw result;
}

// ---------------------------------------------------------------------------
// Settle, release, abandon
// ---------------------------------------------------------------------------

/** The amounts one call is charged. */
interface Actuals {
  tokens: number;
  cost: number | null;
}

function actualsOf(
  usage: {
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    estimatedCost?: number | null;
  },
  reservedTokens: number,
): Actuals {
  const total = usage.totalTokens;
  const prompt = usage.promptTokens;
  const completion = usage.completionTokens;
  let tokens: number;
  if (typeof total === 'number' && Number.isFinite(total)) tokens = total;
  else if (
    (typeof prompt === 'number' && Number.isFinite(prompt)) ||
    (typeof completion === 'number' && Number.isFinite(completion))
  ) {
    tokens = (prompt ?? 0) + (completion ?? 0);
  } else {
    // Answered without reporting tokens: charged what it reserved.
    tokens = reservedTokens;
  }
  const cost =
    typeof usage.estimatedCost === 'number' &&
    Number.isFinite(usage.estimatedCost)
      ? usage.estimatedCost
      : null;
  return { tokens: Math.max(0, Math.round(tokens)), cost };
}

/** Apply one call's charge (and the return of its reservation) to a chain. */
async function chargeChain(
  tx: AiRunTx,
  chain: AiRunRow[],
  actuals: Actuals | null,
  returned: { tokens: number; cost: number } | null,
): Promise<void> {
  const caller = chain[chain.length - 1] as AiRunRow;
  for (const run of chain) {
    if (returned) {
      run.reservedCalls -= 1;
      run.reservedTokens -= returned.tokens;
      run.reservedCost -= returned.cost;
    }
    if (actuals) {
      run.inclusiveCalls += 1;
      run.inclusiveTokens += actuals.tokens;
      if (actuals.cost === null) run.inclusiveUncostedCalls += 1;
      else run.inclusiveCost += actuals.cost;
      if (run === caller) {
        run.calls += 1;
        run.tokens += actuals.tokens;
        if (actuals.cost === null) run.uncostedCalls += 1;
        else run.costUsed += actuals.cost;
      }
    }
    await writeAiRunTotals(tx, run);
  }
}

async function moveReservation(
  tx: AiRunTx,
  runId: string,
  callId: string,
  from: AiRunReservationState[],
  to: AiRunReservationState,
  status: string | null,
): Promise<{ reservedTokens: number; reservedCost: number } | null> {
  const marks = from.map((_, i) => `$${i + 5}`).join(', ');
  const rows = getRows(
    await aiRunQuery(
      tx.db,
      `UPDATE _smrt_ai_run_events
          SET reservation = $3, status = COALESCE($4, status)
        WHERE run_id = $1 AND call_id = $2 AND type = 'call'
          AND reservation IN (${marks})
        RETURNING reserved_tokens, reserved_cost`,
      runId,
      callId,
      to,
      status,
      ...from,
    ),
  );
  if (!rows[0]) return null;
  return {
    reservedTokens: num(rows[0].reserved_tokens),
    reservedCost: num(rows[0].reserved_cost),
  };
}

/** What a settlement did. */
export type AiCallSettlement =
  | 'settled'
  | 'settled_late'
  | 'unreserved'
  | 'already_settled';

/** Input of {@link settleAiCall}. */
export interface SettleAiCallInput {
  runId: string;
  callId: string;
  /** The call's normalized usage event; written as its usage row. */
  usage: SmrtAiUsageEvent;
  /** The call event's status; default `ok`. */
  status?: string;
}

async function settleInTx(
  tx: AiRunTx,
  input: SettleAiCallInput,
): Promise<AiCallSettlement> {
  const chain = await lockAiRunChain(tx, input.runId);
  const status = input.status ?? 'ok';
  const usage = input.usage;
  let path: AiCallSettlement;
  let returned: { tokens: number; cost: number } | null = null;
  let reservedTokens = 0;
  const held = await moveReservation(
    tx,
    input.runId,
    input.callId,
    ['reserved'],
    'settled',
    status,
  );
  if (held) {
    path = 'settled';
    returned = { tokens: held.reservedTokens, cost: held.reservedCost };
    reservedTokens = held.reservedTokens;
  } else {
    const late = await moveReservation(
      tx,
      input.runId,
      input.callId,
      ['released', 'abandoned'],
      'settled_late',
      status,
    );
    if (late) {
      path = 'settled_late';
      reservedTokens = late.reservedTokens;
    } else {
      const existing = getRows(
        await aiRunQuery(
          tx.db,
          `SELECT id FROM _smrt_ai_run_events
            WHERE run_id = $1 AND call_id = $2 AND type = 'call'`,
          input.runId,
          input.callId,
        ),
      );
      path = existing[0] ? 'already_settled' : 'unreserved';
    }
  }
  const inserted = await insertAiUsageRow(tx.db, usage, {
    id: input.callId,
    runId: input.runId,
  });
  if (path === 'already_settled') return path;
  if (path === 'unreserved') {
    // The one case where the insert, not the event, guards double charging.
    if (!inserted) return 'already_settled';
    await insertAiRunEventTx(tx, input.runId, {
      id: newAiRunId(),
      type: 'call',
      callId: input.callId,
      status,
      reservation: 'unreserved',
      reservedTokens: 0,
      reservedCost: 0,
    });
  }
  await chargeChain(
    tx,
    chain,
    actualsOf(
      {
        promptTokens: usage.usage?.promptTokens ?? null,
        completionTokens: usage.usage?.completionTokens ?? null,
        totalTokens: usage.usage?.totalTokens ?? null,
        estimatedCost: usage.estimatedCost ?? null,
      },
      reservedTokens,
    ),
    returned,
  );
  return path;
}

/**
 * Settle a call that ended with usage, in one transaction (page section
 * 6.4): the reservation moves `reserved` to `settled` (or, after a release
 * or an abandonment, to `settled_late` without returning room twice), the
 * usage row is inserted with `id = call_id` (`ON CONFLICT DO NOTHING`), and
 * the actual amounts are charged to the chain root first. Usage for a call
 * of the run that never reserved is charged once, on its insert. Never
 * asserts the claim and never looks at status.
 */
export async function settleAiCall(
  db: DatabaseInterface,
  input: SettleAiCallInput,
  options: AiRunTxOptions = {},
): Promise<AiCallSettlement> {
  return withAiRunTransaction(db, (tx) => settleInTx(tx, input), options);
}

async function releaseInTx(
  tx: AiRunTx,
  chain: AiRunRow[],
  callId: string,
  status: 'failed' | 'timed_out' | 'cancelled',
): Promise<boolean> {
  const run = chain[chain.length - 1] as AiRunRow;
  const held = await moveReservation(
    tx,
    run.id,
    callId,
    ['reserved'],
    'released',
    status,
  );
  if (!held) return false;
  await chargeChain(tx, chain, null, {
    tokens: held.reservedTokens,
    cost: held.reservedCost,
  });
  return true;
}

/**
 * Release a call that ended without usage (failed, timed out, cancelled):
 * `reserved` to `released`, its room returned. Returns false when the
 * reservation had already moved.
 */
export async function releaseAiCall(
  db: DatabaseInterface,
  input: {
    runId: string;
    callId: string;
    status: 'failed' | 'timed_out' | 'cancelled';
  },
  options: AiRunTxOptions = {},
): Promise<boolean> {
  return withAiRunTransaction(
    db,
    async (tx) => {
      const chain = await lockAiRunChain(tx, input.runId);
      return releaseInTx(tx, chain, input.callId, input.status);
    },
    options,
  );
}

function usageFromRow(row: Record<string, unknown>): SmrtAiUsageEvent {
  const nullable = (value: unknown) =>
    value === null || value === undefined ? undefined : num(value);
  return {
    provider: String(row.provider),
    model: String(row.model),
    operation: String(row.operation),
    usage: {
      promptTokens: nullable(row.prompt_tokens),
      completionTokens: nullable(row.completion_tokens),
      totalTokens: nullable(row.total_tokens),
    } as SmrtAiUsageEvent['usage'],
    estimatedCost: nullable(row.estimated_cost),
    duration: num(row.duration),
    timestamp: dateOrNull(row.created_at) ?? new Date(0),
  } as SmrtAiUsageEvent;
}

/** What reconciling one stale reservation did. */
export type AiCallReconciliation = 'settled' | 'abandoned' | 'moved';

/**
 * Reconcile one call event still `reserved` (page section 6.7): settle it
 * from its usage row when one reached the table, else abandon it. One chain
 * transaction.
 */
export async function reconcileAiCall(
  db: DatabaseInterface,
  runId: string,
  callId: string,
  options: AiRunTxOptions = {},
): Promise<AiCallReconciliation> {
  return withAiRunTransaction(
    db,
    async (tx) => {
      const chain = await lockAiRunChain(tx, runId);
      const usage = getRows(
        await aiRunQuery(
          tx.db,
          'SELECT * FROM _smrt_ai_usage WHERE id = $1',
          callId,
        ),
      );
      if (usage[0]) {
        const held = await moveReservation(
          tx,
          runId,
          callId,
          ['reserved'],
          'settled',
          'ok',
        );
        if (!held) return 'moved';
        const event = usageFromRow(usage[0]);
        await chargeChain(
          tx,
          chain,
          actualsOf(
            {
              promptTokens: event.usage?.promptTokens ?? null,
              completionTokens: event.usage?.completionTokens ?? null,
              totalTokens: event.usage?.totalTokens ?? null,
              estimatedCost: event.estimatedCost ?? null,
            },
            held.reservedTokens,
          ),
          { tokens: held.reservedTokens, cost: held.reservedCost },
        );
        return 'settled';
      }
      const held = await moveReservation(
        tx,
        runId,
        callId,
        ['reserved'],
        'abandoned',
        'abandoned',
      );
      if (!held) return 'moved';
      await chargeChain(tx, chain, null, {
        tokens: held.reservedTokens,
        cost: held.reservedCost,
      });
      return 'abandoned';
    },
    options,
  );
}

/** The run and its descendants that are not durable, stopping at durable ones. */
async function nonDurableSubtree(
  db: DatabaseInterface,
  runId: string,
): Promise<string[]> {
  const out = [runId];
  const queue = [runId];
  while (queue.length > 0) {
    const parent = queue.shift() as string;
    const children = getRows(
      await aiRunQuery(
        db,
        `SELECT r.id FROM _smrt_ai_runs r
          WHERE r.parent_run_id = $1
            AND NOT EXISTS (SELECT 1 FROM _smrt_ai_run_checkpoints c
                             WHERE c.run_id = r.id)
          ORDER BY r.id`,
        parent,
      ),
    );
    for (const child of children) {
      const id = String(child.id);
      out.push(id);
      queue.push(id);
    }
  }
  return out;
}

/** What {@link reconcileAiRunOnClaim} did. */
export interface AiRunClaimReconciliation {
  settled: number;
  abandoned: number;
  /** Descendants still `running` that were set `failed` with `abandoned`. */
  abandonedRuns: string[];
}

/**
 * Reconcile a durable run when a worker claims it for resume (page section
 * 6.7): at once, without waiting for any threshold, every `call` event still
 * `reserved` in the run and in its descendants that are not durable, and any
 * such descendant still `running` is set `failed` with `abandoned` (guarded).
 * It never goes into or below a durable descendant: that one has its own job
 * and its own recovery.
 */
export async function reconcileAiRunOnClaim(
  db: DatabaseInterface,
  runId: string,
  options: AiRunTxOptions = {},
): Promise<AiRunClaimReconciliation> {
  const ids = await nonDurableSubtree(db, runId);
  const out: AiRunClaimReconciliation = {
    settled: 0,
    abandoned: 0,
    abandonedRuns: [],
  };
  for (const id of ids) {
    const reserved = getRows(
      await aiRunQuery(
        db,
        `SELECT call_id FROM _smrt_ai_run_events
          WHERE run_id = $1 AND type = 'call' AND reservation = 'reserved'
          ORDER BY seq`,
        id,
      ),
    );
    for (const row of reserved) {
      const outcome = await reconcileAiCall(
        db,
        id,
        String(row.call_id),
        options,
      );
      if (outcome === 'settled') out.settled++;
      else if (outcome === 'abandoned') out.abandoned++;
    }
  }
  for (const id of ids.slice(1)) {
    const failed = await withAiRunTransaction(
      db,
      async (tx) => {
        const run = await lockAiRun(tx, id);
        if (run?.status !== 'running') return false;
        return writeAiRunStatusTx(tx, run, 'failed', {
          stopReason: 'abandoned',
          stoppedByRunId: id,
        });
      },
      options,
    );
    if (failed) out.abandonedRuns.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The `ai-runs` sweep
// ---------------------------------------------------------------------------

/** Defaults of the sweep (page section 6.7). */
export const AI_RUN_SWEEP_DEFAULTS = Object.freeze({
  /** Grace added to the smallest `callTimeoutMs` on the chain. */
  graceMs: 60_000,
  /** The stale-reservation threshold when no `callTimeoutMs` is set. */
  staleReservationMs: 60 * 60_000,
  /** A non-durable run quiet this long is closed as abandoned. */
  staleRunMs: 24 * 60 * 60_000,
  /** Reservations examined per sweep. */
  batch: 500,
});

/** Options of {@link sweepAiRuns}. */
export interface SweepAiRunsOptions extends AiRunTxOptions {
  graceMs?: number;
  staleReservationMs?: number;
  staleRunMs?: number;
  batch?: number;
}

/** What one sweep did. */
export interface AiRunSweepResult {
  settled: number;
  abandoned: number;
  /** Non-durable runs set `failed` with `abandoned`. */
  closedRuns: string[];
  /** Descendants of a final or missing ancestor moved to `cancelled`. */
  cancelledRuns: string[];
}

/**
 * The `ai-runs` task of the retention sweep (page section 6.7): reconcile
 * every `call` reservation older than its threshold (the smallest
 * `callTimeoutMs` on its chain plus one minute, else one hour), and set a
 * run that is not durable from `running` to `failed` with `abandoned` when
 * it holds no reservation and has had no event or run-row write for 24
 * hours. Every change is guarded, so a slow but live process can neither
 * spend more nor write `done` over the result. Last, it moves to
 * `cancelled` every descendant left under a cancelled, final or missing
 * ancestor (see {@link repairOrphanedAiRuns}).
 */
export async function sweepAiRuns(
  db: DatabaseInterface,
  options: SweepAiRunsOptions = {},
): Promise<AiRunSweepResult> {
  const clock = options.now ?? (() => new Date());
  const now = clock();
  const graceMs = options.graceMs ?? AI_RUN_SWEEP_DEFAULTS.graceMs;
  const defaultMs =
    options.staleReservationMs ?? AI_RUN_SWEEP_DEFAULTS.staleReservationMs;
  const staleRunMs = options.staleRunMs ?? AI_RUN_SWEEP_DEFAULTS.staleRunMs;
  const batch = options.batch ?? AI_RUN_SWEEP_DEFAULTS.batch;
  const out: AiRunSweepResult = {
    settled: 0,
    abandoned: 0,
    closedRuns: [],
    cancelledRuns: [],
  };

  // Up to `batch` reconciliations, oldest first. A reservation not yet past
  // its own threshold (or of a missing run) stays `reserved`; the next page
  // starts past the rows left behind instead of reading them again.
  const timeouts = new Map<string, number | undefined>();
  const reconcileSwept = async (
    row: Record<string, unknown>,
  ): Promise<boolean> => {
    const runId = String(row.run_id);
    if (!timeouts.has(runId)) {
      let timeout: number | undefined;
      try {
        for (const id of await readAiRunChainIds(db, runId)) {
          const value = (await getAiRun(db, id))?.budget.callTimeoutMs;
          if (
            value !== undefined &&
            (timeout === undefined || value < timeout)
          ) {
            timeout = value;
          }
        }
      } catch (error) {
        if (!(error instanceof AiRunNotFoundError)) throw error;
      }
      timeouts.set(runId, timeout);
    }
    const timeout = timeouts.get(runId);
    const threshold = timeout !== undefined ? timeout + graceMs : defaultMs;
    const createdAt = dateOrNull(row.created_at)?.getTime() ?? 0;
    if (createdAt > now.getTime() - threshold) return false;
    try {
      const outcome = await reconcileAiCall(
        db,
        runId,
        String(row.call_id),
        options,
      );
      if (outcome === 'settled') out.settled++;
      else if (outcome === 'abandoned') out.abandoned++;
      return true;
    } catch (error) {
      if (!(error instanceof AiRunNotFoundError)) throw error;
      return false;
    }
  };
  let reconciled = 0;
  let leftBehind = 0;
  for (let full = true; full && reconciled < batch; ) {
    const page = getRows(
      await aiRunQuery(
        db,
        `SELECT run_id, call_id, created_at FROM _smrt_ai_run_events
          WHERE type = 'call' AND reservation = 'reserved' AND created_at < $1
          ORDER BY created_at, id LIMIT $2 OFFSET $3`,
        new Date(now.getTime() - graceMs).toISOString(),
        batch,
        leftBehind,
      ),
    );
    full = page.length === batch;
    for (const row of page) {
      if (reconciled >= batch) break;
      if (await reconcileSwept(row)) reconciled++;
      else leftBehind++;
    }
  }

  const cutoff = new Date(now.getTime() - staleRunMs);
  const quiet = getRows(
    await aiRunQuery(
      db,
      `SELECT r.id FROM _smrt_ai_runs r
        WHERE r.status = 'running'
          AND COALESCE(r.active_since, r.started_at) < $1
          AND NOT EXISTS (SELECT 1 FROM _smrt_ai_run_checkpoints c
                           WHERE c.run_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM _smrt_ai_run_events e
                           WHERE e.run_id = r.id
                             AND (e.created_at >= $1
                                  OR (e.type = 'call' AND e.reservation = 'reserved')))
        ORDER BY r.id LIMIT $2`,
      cutoff.toISOString(),
      batch,
    ),
  );
  for (const row of quiet) {
    const id = String(row.id);
    const closed = await withAiRunTransaction(
      db,
      async (tx) => {
        const run = await lockAiRun(tx, id);
        if (run?.status !== 'running' || run.durable) return false;
        const lastWrite = run.activeSince ?? run.startedAt;
        if (lastWrite.getTime() >= cutoff.getTime()) return false;
        const live = getRows(
          await aiRunQuery(
            tx.db,
            `SELECT 1 AS x FROM _smrt_ai_run_events
              WHERE run_id = $1
                AND (created_at >= $2
                     OR (type = 'call' AND reservation = 'reserved'))
              LIMIT 1`,
            id,
            cutoff.toISOString(),
          ),
        );
        if (live.length > 0) return false;
        return writeAiRunStatusTx(tx, run, 'failed', {
          stopReason: 'abandoned',
          stoppedByRunId: id,
        });
      },
      options,
    );
    if (closed) out.closedRuns.push(id);
  }

  out.cancelledRuns = await repairOrphanedAiRuns(db, batch, options);
  return out;
}

/**
 * The sweep's repair of descendants left under a final ancestor (page
 * section 6.7): any run that is not final and has a `cancelled` ancestor,
 * and any `waiting-approval` or durable `stopped` run with an ancestor that
 * is final or whose row is missing, moves to `cancelled` with `cancelled`
 * (guarded, its chain locked root first). `stopped_by_run_id` is the nearest
 * such ancestor, or the run itself when the ancestor's row is missing.
 * Candidates are read by their parent, so a deeper descendant is repaired
 * in a later round of the same sweep, once its parent has been.
 */
async function repairOrphanedAiRuns(
  db: DatabaseInterface,
  batch: number,
  options: AiRunTxOptions,
): Promise<string[]> {
  const repaired: string[] = [];
  const tried = new Set<string>();
  for (let round = 0; round < 64; round++) {
    const candidates = getRows(
      await aiRunQuery(
        db,
        `SELECT r.id FROM _smrt_ai_runs r
           LEFT JOIN _smrt_ai_runs p ON p.id = r.parent_run_id
          WHERE r.parent_run_id IS NOT NULL
            AND (
              (r.status = 'running' AND p.status = 'cancelled')
              OR ((r.status = 'waiting-approval'
                   OR (r.status = 'stopped'
                       AND EXISTS (SELECT 1 FROM _smrt_ai_run_checkpoints c
                                    WHERE c.run_id = r.id)))
                  AND (p.id IS NULL
                       OR p.status IN ('cancelled', 'failed', 'done')
                       OR (p.status = 'stopped'
                           AND NOT EXISTS (SELECT 1 FROM _smrt_ai_run_checkpoints pc
                                            WHERE pc.run_id = p.id))))
            )
          ORDER BY r.id LIMIT $1`,
        batch,
      ),
    )
      .map((row) => String(row.id))
      .filter((id) => !tried.has(id));
    if (candidates.length === 0) break;
    for (const id of candidates) {
      tried.add(id);
      const cancelled = await withAiRunTransaction(
        db,
        async (tx) => {
          const chain = await lockAiRunChain(tx, id).catch((error) => {
            if (error instanceof AiRunNotFoundError) return null;
            throw error;
          });
          if (!chain) return false;
          const run = chain[chain.length - 1] as AiRunRow;
          if (isAiRunFinal(run)) return false;
          const ancestors = chain.slice(0, -1).reverse();
          const cancelledAncestor = ancestors.find(
            (ancestor) => ancestor.status === 'cancelled',
          );
          let stoppedBy: string | null = cancelledAncestor?.id ?? null;
          if (!stoppedBy && run.status !== 'running') {
            stoppedBy =
              ancestors.find(isAiRunFinal)?.id ??
              ((chain[0] as AiRunRow).parentRunId !== null ? run.id : null);
          }
          if (!stoppedBy) return false;
          return writeAiRunStatusTx(tx, run, 'cancelled', {
            stopReason: 'cancelled',
            stoppedByRunId: stoppedBy,
          });
        },
        options,
      );
      if (cancelled) repaired.push(id);
    }
  }
  return repaired;
}

// ---------------------------------------------------------------------------
// The pending settlement list (page section 6.4)
// ---------------------------------------------------------------------------

interface PendingSettlement {
  input: SettleAiCallInput;
  afterCommit?: () => Promise<void>;
  /** The write in flight for this entry, followed by every flush. */
  settling?: Promise<PendingOutcome>;
  /** Flushes that failed to write it. */
  failures: number;
}

/**
 * `written`: settled; `ledger`: taken off the list with its usage row
 * written on its own (its run is gone, or it can never settle); `dropped`:
 * taken off the list and not even its usage row could be written;
 * `pending`: still failing, kept.
 */
type PendingOutcome = 'written' | 'ledger' | 'dropped' | 'pending';

/**
 * Flushes a settlement may fail, while the database itself answers, with an
 * error that could pass on another try before it is taken off the list like
 * one that never can.
 */
export const AI_RUN_PENDING_MAX_FAILURES = 10;

/** Passes one flush makes over entries deferred while it runs. */
const FLUSH_PASSES = 3;

const pendingByUrl = new Map<string, PendingSettlement[]>();
const pendingByHandle = new WeakMap<object, PendingSettlement[]>();

function pendingList(db: DatabaseInterface, create: boolean) {
  const url =
    typeof db.url === 'string' && db.url && db.url !== ':memory:'
      ? db.url
      : null;
  if (url) {
    let list = pendingByUrl.get(url);
    if (!list && create) {
      list = [];
      pendingByUrl.set(url, list);
    }
    return list;
  }
  let list = pendingByHandle.get(db);
  if (!list && create) {
    list = [];
    pendingByHandle.set(db, list);
  }
  return list;
}

/**
 * Keep a settlement whose transaction failed every retry, oldest first, for
 * this database; its handlers are not called until it commits.
 */
export function deferAiRunSettlement(
  db: DatabaseInterface,
  input: SettleAiCallInput,
  afterCommit?: () => Promise<void>,
): void {
  pendingList(db, true)?.push({
    input,
    failures: 0,
    ...(afterCommit ? { afterCommit } : {}),
  });
}

/** Settlements waiting for this database. */
export function pendingAiRunSettlements(db: DatabaseInterface): number {
  return pendingList(db, false)?.length ?? 0;
}

function removePending(list: PendingSettlement[], entry: PendingSettlement) {
  const index = list.indexOf(entry);
  if (index >= 0) list.splice(index, 1);
}

/**
 * Write a settlement's usage row on its own (`ON CONFLICT DO NOTHING`), so
 * the spend stays in the billing ledger when the run can never take it.
 * `runId` is null when the run is gone.
 */
async function writeUsageAlone(
  db: DatabaseInterface,
  input: SettleAiCallInput,
  runId: string | null,
): Promise<boolean> {
  try {
    await insertAiUsageRow(db, input.usage, { id: input.callId, runId });
    return true;
  } catch (error) {
    logger.warn(
      `[smrt] AI usage row for call ${input.callId} could not be written: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/** Whether the database answers a trivial query. */
async function databaseReachable(db: DatabaseInterface): Promise<boolean> {
  try {
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function writePending(
  db: DatabaseInterface,
  list: PendingSettlement[],
  entry: PendingSettlement,
  options: AiRunTxOptions,
): Promise<PendingOutcome> {
  try {
    await settleAiCall(db, entry.input, options);
    removePending(list, entry);
    return 'written';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const callId = entry.input.callId;
    if (error instanceof AiRunNotFoundError) {
      // Its run was pruned: no run can ever take it, the ledger still does.
      removePending(list, entry);
      const kept = await writeUsageAlone(db, entry.input, null);
      logger.warn(
        `[smrt] AI run settlement for call ${callId} dropped, its run no longer exists${
          kept ? '; usage row kept without a run' : ''
        }: ${message}`,
      );
      return kept ? 'ledger' : 'dropped';
    }
    // A database that cannot be reached at all is not this entry's fault:
    // such a flush does not count toward the cap, so an outage never drops
    // the list.
    if (isAiRunRetryable(error) && (await databaseReachable(db))) {
      entry.failures += 1;
    }
    if (
      !isAiRunRetryable(error) ||
      entry.failures >= AI_RUN_PENDING_MAX_FAILURES
    ) {
      // It can never settle (or has failed every flush so far): park it so
      // the run's later calls go ahead. The usage row keeps its run, so
      // reconciliation settles the reservation from it if one is held.
      removePending(list, entry);
      const kept = await writeUsageAlone(db, entry.input, entry.input.runId);
      logger.warn(
        `[smrt] AI run settlement for call ${callId} of run ${entry.input.runId} parked after ${entry.failures} failed flush(es)${
          kept ? '; usage row written on its own' : ''
        }: ${message}`,
      );
      return kept ? 'ledger' : 'dropped';
    }
    logger.warn(
      `[smrt] AI run settlement for call ${callId} is still pending: ${message}`,
    );
    return 'pending';
  } finally {
    entry.settling = undefined;
  }
}

/**
 * Write the pending settlements of this database, oldest first. One that
 * still fails holds back the later settlements of its own run, never those
 * of other runs. A settlement whose run no longer exists is taken off the
 * list with its usage row written on its own (without a run); one that can
 * never settle (a typed error, a `TypeError`) or has failed
 * {@link AI_RUN_PENDING_MAX_FAILURES} flushes while the database answered
 * is taken off with its usage row written on its own (with its run), each
 * with a warning; a flush during an outage never counts. The handlers
 * run once the usage row is written either way. Concurrent flushes share
 * each entry's write, so a settlement is written once and its handlers run
 * once, by the flush that wrote it, after the commit; a handler may itself
 * make a tracked call. With `runId`, throws when a settlement of that run
 * is still pending, so the run's next reservation does not go ahead.
 */
export async function flushAiRunSettlements(
  db: DatabaseInterface,
  options: { runId?: string } & AiRunTxOptions = {},
): Promise<void> {
  const list = pendingList(db, false);
  if (!list || list.length === 0) return;
  const held = new Set<string>();
  const seen = new Set<PendingSettlement>();
  // An entry deferred while this flush runs (a handler's own call) is
  // written by a later pass of this same flush.
  for (let pass = 0; pass < FLUSH_PASSES; pass++) {
    const batch = list.filter((entry) => !seen.has(entry));
    if (batch.length === 0) break;
    for (const next of batch) {
      seen.add(next);
      if (!list.includes(next)) continue;
      const runId = next.input.runId;
      if (held.has(runId)) continue;
      if (next.settling) {
        // Another flush is writing it; follow, and leave its handlers to it.
        if ((await next.settling) === 'pending') held.add(runId);
        continue;
      }
      const settling = writePending(db, list, next, options);
      next.settling = settling;
      const outcome = await settling;
      if (outcome === 'pending') {
        held.add(runId);
        continue;
      }
      if ((outcome === 'written' || outcome === 'ledger') && next.afterCommit) {
        try {
          await next.afterCommit();
        } catch (error) {
          logger.warn(
            `[smrt] AI usage handlers failed for call ${next.input.callId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }
  if (
    options.runId &&
    list.some((entry) => entry.input.runId === options.runId)
  ) {
    throw new Error(
      `AI run ${options.runId} has a settlement that could not be written yet; its next call waits for it`,
    );
  }
}

// ---------------------------------------------------------------------------
// Checking and repairing totals (page section 6.6)
// ---------------------------------------------------------------------------

/** Own totals of a run. */
export interface AiRunOwnTotals {
  tokens: number;
  cost: number;
  calls: number;
  uncostedCalls: number;
}

/** What {@link checkAiRunTotals} found. */
export interface AiRunTotalsCheck {
  runId: string;
  /** False when a charged call's usage row is gone: never reported wrong. */
  verifiable: boolean;
  /** Charged call events whose usage row is missing. */
  missingUsageRows: number;
  stored: AiRunOwnTotals;
  /** From the usage rows; null when not verifiable. */
  computed: AiRunOwnTotals | null;
  matches: boolean | null;
}

const COST_TOLERANCE = 1e-6;

async function computeOwnTotals(
  db: DatabaseInterface,
  runId: string,
): Promise<{ computed: AiRunOwnTotals; missing: number }> {
  const rows = getRows(
    await aiRunQuery(
      db,
      `SELECT e.reserved_tokens, u.id AS usage_id, u.prompt_tokens,
              u.completion_tokens, u.total_tokens, u.estimated_cost
         FROM _smrt_ai_run_events e
         LEFT JOIN _smrt_ai_usage u ON u.id = e.call_id
        WHERE e.run_id = $1 AND e.type = 'call'
          AND e.reservation IN ('settled', 'settled_late', 'unreserved')`,
      runId,
    ),
  );
  const computed: AiRunOwnTotals = {
    tokens: 0,
    cost: 0,
    calls: 0,
    uncostedCalls: 0,
  };
  let missing = 0;
  for (const row of rows) {
    if (row.usage_id === null || row.usage_id === undefined) {
      missing++;
      continue;
    }
    const nullable = (value: unknown) =>
      value === null || value === undefined ? null : num(value);
    const actual = actualsOf(
      {
        promptTokens: nullable(row.prompt_tokens),
        completionTokens: nullable(row.completion_tokens),
        totalTokens: nullable(row.total_tokens),
        estimatedCost: nullable(row.estimated_cost),
      },
      num(row.reserved_tokens),
    );
    computed.calls++;
    computed.tokens += actual.tokens;
    if (actual.cost === null) computed.uncostedCalls++;
    else computed.cost += actual.cost;
  }
  return { computed, missing };
}

function sameTotals(a: AiRunOwnTotals, b: AiRunOwnTotals): boolean {
  return (
    a.tokens === b.tokens &&
    a.calls === b.calls &&
    a.uncostedCalls === b.uncostedCalls &&
    // A usage row's cost is REAL (32-bit off SQLite); totals are double.
    Math.abs(a.cost - b.cost) <= COST_TOLERANCE * Math.max(1, Math.abs(b.cost))
  );
}

/**
 * Compare a run's own totals with its usage rows (page section 6.6). Only
 * while every `settled`, `settled_late` and `unreserved` call event still has
 * its usage row; otherwise the run is unverifiable, never wrong.
 */
export async function checkAiRunTotals(
  db: DatabaseInterface,
  runId: string,
): Promise<AiRunTotalsCheck> {
  const run = await getAiRun(db, runId);
  if (!run) throw new AiRunNotFoundError(runId);
  const stored: AiRunOwnTotals = {
    tokens: run.tokens,
    cost: run.costUsed,
    calls: run.calls,
    uncostedCalls: run.uncostedCalls,
  };
  const { computed, missing } = await computeOwnTotals(db, runId);
  if (missing > 0) {
    return {
      runId,
      verifiable: false,
      missingUsageRows: missing,
      stored,
      computed: null,
      matches: null,
    };
  }
  return {
    runId,
    verifiable: true,
    missingUsageRows: 0,
    stored,
    computed,
    matches: sameTotals(stored, computed),
  };
}

/** Thrown by {@link repairAiRunTotals} for a run it cannot verify. */
export class AiRunTotalsUnverifiableError extends AiRunError {
  constructor(
    readonly runId: string,
    readonly missingUsageRows: number,
  ) {
    super(
      `AI run ${runId} cannot be repaired: ${missingUsageRows} charged call(s) have lost their usage rows`,
      'AI_RUN_TOTALS_UNVERIFIABLE',
      'runtime',
      { runId, missingUsageRows },
    );
  }
}

/**
 * The operator's explicit repair (page section 6.6): recompute the run's own
 * totals from its usage rows and add the difference to its own and inclusive
 * totals and to every ancestor's inclusive totals, in one chain transaction.
 * Never touches descendants or `reserved_*`. Refuses an unverifiable run.
 * Returns the difference applied.
 */
export async function repairAiRunTotals(
  db: DatabaseInterface,
  runId: string,
  options: AiRunTxOptions = {},
): Promise<AiRunOwnTotals> {
  return withAiRunTransaction(
    db,
    async (tx) => {
      const chain = await lockAiRunChain(tx, runId);
      const run = chain[chain.length - 1] as AiRunRow;
      const { computed, missing } = await computeOwnTotals(tx.db, runId);
      if (missing > 0) {
        throw new AiRunTotalsUnverifiableError(runId, missing);
      }
      const diff: AiRunOwnTotals = {
        tokens: computed.tokens - run.tokens,
        cost: computed.cost - run.costUsed,
        calls: computed.calls - run.calls,
        uncostedCalls: computed.uncostedCalls - run.uncostedCalls,
      };
      for (const chainRun of chain) {
        chainRun.inclusiveTokens += diff.tokens;
        chainRun.inclusiveCost += diff.cost;
        chainRun.inclusiveCalls += diff.calls;
        chainRun.inclusiveUncostedCalls += diff.uncostedCalls;
        if (chainRun === run) {
          chainRun.tokens = computed.tokens;
          chainRun.costUsed = computed.cost;
          chainRun.calls = computed.calls;
          chainRun.uncostedCalls = computed.uncostedCalls;
        }
        await writeAiRunTotals(tx, chainRun);
      }
      return diff;
    },
    options,
  );
}
