/**
 * In-memory AI usage tracking adapters.
 */

import type {
  AiUsageHandler,
  AiUsageSnapshot,
  AiUsageStats,
  SmrtAiUsageEvent,
} from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';

function emptyStats(timestamp: number): AiUsageStats {
  return {
    callCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalDuration: 0,
    estimatedCost: 0,
    lastUsed: timestamp,
  };
}

function updateStats(stats: AiUsageStats, event: SmrtAiUsageEvent): void {
  stats.callCount++;
  stats.promptTokens += event.usage?.promptTokens ?? 0;
  stats.completionTokens += event.usage?.completionTokens ?? 0;
  stats.totalTokens += event.usage?.totalTokens ?? 0;
  stats.totalDuration += event.duration ?? 0;
  stats.estimatedCost += event.estimatedCost ?? 0;
  stats.lastUsed = event.timestamp.getTime();
}

/**
 * Collects normalized AI usage events in memory for quick inspection.
 */
export class AiUsageCollector implements AiUsageHandler {
  private byModel = new Map<string, AiUsageStats>();
  private byClass = new Map<string, AiUsageStats>();
  private totalCalls = 0;
  private startTime = Date.now();

  async handle(event: SmrtAiUsageEvent): Promise<void> {
    this.totalCalls++;

    const timestamp = event.timestamp.getTime();
    const modelKey = `${event.provider}:${event.model}`;
    const classKey = `${event.className ?? 'unknown'}:${event.operation}`;

    let modelStats = this.byModel.get(modelKey);
    if (!modelStats) {
      modelStats = emptyStats(timestamp);
      this.byModel.set(modelKey, modelStats);
    }

    let classStats = this.byClass.get(classKey);
    if (!classStats) {
      classStats = emptyStats(timestamp);
      this.byClass.set(classKey, classStats);
    }

    updateStats(modelStats, event);
    updateStats(classStats, event);
  }

  getSnapshot(): AiUsageSnapshot {
    const byModel: AiUsageSnapshot['byModel'] = {};
    const byClass: AiUsageSnapshot['byClass'] = {};

    for (const [key, stats] of this.byModel.entries()) {
      byModel[key] = { ...stats };
    }

    for (const [key, stats] of this.byClass.entries()) {
      byClass[key] = { ...stats };
    }

    return {
      byModel,
      byClass,
      totalCalls: this.totalCalls,
      startTime: this.startTime,
    };
  }

  reset(): void {
    this.byModel.clear();
    this.byClass.clear();
    this.totalCalls = 0;
    this.startTime = Date.now();
  }
}

/**
 * Usage tags lifted into `_smrt_ai_usage` columns (#4751; `callId`, #4780;
 * `templateHash` and the workflow step tags, #5005), tag name to column
 * name. The `callId` tag is the entry call's id, so it lands in
 * `entry_call_id`; the row's own call id is `aiCallId` (below), its primary
 * key. The full tag map is always stored in `tags` as well, so a lifted tag
 * is a copy, never a move.
 */
export const AI_USAGE_TAG_COLUMNS = Object.freeze({
  promptKey: 'prompt_key',
  tierRequested: 'tier_requested',
  tierResolved: 'tier_resolved',
  runId: 'run_id',
  callId: 'entry_call_id',
  templateHash: 'template_hash',
  stepIndex: 'step_index',
  stepName: 'step_name',
  stepInstanceId: 'step_instance_id',
  attempt: 'attempt',
} as const);

/**
 * The usage tag carrying a call's own id, minted before the call is sent
 * (#5005). The usage row is written with `id` (and `call_id`) equal to it,
 * so a retried save never makes a second row.
 */
export const AI_OWN_CALL_ID_TAG = 'aiCallId';

// ---------------------------------------------------------------------------
// Tracked calls' usage, wherever it is delivered (#5005)
// ---------------------------------------------------------------------------

const settledRunEvents = new WeakSet<object>();

/**
 * Mark the event a tracked call's settlement wrote, which the usage handlers
 * then receive: it is the call's own record, never routed back to the call
 * or reconciled again.
 *
 * @internal Called by the settlement only.
 */
export function markAiRunSettledUsageEvent(event: SmrtAiUsageEvent): void {
  settledRunEvents.add(event);
}

/** Late usage of tracked calls (`system/ai-run-late-usage.ts` installs it). */
interface AiRunLateUsageHooks {
  /** Hand the event to its call's route; whether the route took it. */
  route(event: SmrtAiUsageEvent, db: DatabaseInterface): Promise<boolean>;
  /** Settle a released call whose route is gone; whether it did. */
  reconcile(event: SmrtAiUsageEvent, db: DatabaseInterface): Promise<boolean>;
}

let lateUsageHooks: AiRunLateUsageHooks | undefined;

/** @internal Installed once by `system/ai-run-late-usage.ts`. */
export function setAiRunLateUsageHooks(hooks: AiRunLateUsageHooks): void {
  lateUsageHooks = hooks;
}

/** The database each persistence handler writes to. */
const persistenceDatabases = new WeakMap<object, DatabaseInterface>();

function lateUsageCandidate(event: SmrtAiUsageEvent): boolean {
  return (
    !settledRunEvents.has(event) &&
    typeof event.tags?.[AI_OWN_CALL_ID_TAG] === 'string' &&
    typeof event.tags?.runId === 'string'
  );
}

/**
 * Hand a usage event of a tracked call to that call's route, when the
 * pipeline writes to a database (its persistence handler) the route can be
 * checked against. Returns whether the route took it; an event it does not
 * take goes to every handler as usual.
 *
 * @internal Used by `dispatchAiUsageEvent`.
 */
export async function routeAiRunCallUsage(
  event: SmrtAiUsageEvent,
  handlers: readonly AiUsageHandler[],
): Promise<boolean> {
  if (!lateUsageHooks || !lateUsageCandidate(event)) return false;
  for (const handler of handlers) {
    const db = persistenceDatabases.get(handler as object);
    if (db) return lateUsageHooks.route(event, db);
  }
  return false;
}

/** A lifted tag value: a non-empty string, else NULL. */
function liftedTag(
  tags: Record<string, string> | undefined,
  name: keyof typeof AI_USAGE_TAG_COLUMNS | typeof AI_OWN_CALL_ID_TAG,
): string | null {
  const value = tags?.[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A lifted integer tag (`stepIndex`, `attempt`): a safe integer, else NULL. */
function liftedInteger(
  tags: Record<string, string> | undefined,
  name: 'stepIndex' | 'attempt',
): number | null {
  const value = liftedTag(tags, name);
  if (value === null || !/^-?\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/** Overrides of {@link insertAiUsageRow}. */
export interface AiUsageRowOverrides {
  /** The row id (= its call id); else the `aiCallId` tag, else minted. */
  id?: string;
  /** The run the call belongs to; else the `runId` tag. */
  runId?: string | null;
}

/**
 * Insert one usage row, `INSERT ... ON CONFLICT (id) DO NOTHING` (#5005):
 * the row's `id` and `call_id` are the call id, so writing the same call
 * twice (a retried save, the settle transaction and then the persistence
 * handler) leaves one row. `entry_call_id` is the `callId` tag, else the
 * row's own id. Returns whether this call inserted the row.
 */
export async function insertAiUsageRow(
  db: DatabaseInterface,
  event: SmrtAiUsageEvent,
  overrides: AiUsageRowOverrides = {},
): Promise<boolean> {
  const id =
    overrides.id ??
    liftedTag(event.tags, AI_OWN_CALL_ID_TAG) ??
    crypto.randomUUID();
  const runId =
    overrides.runId !== undefined
      ? overrides.runId
      : liftedTag(event.tags, 'runId');
  const result = await db.query(
    `INSERT INTO _smrt_ai_usage
      (id, provider, model, operation, prompt_tokens, completion_tokens,
       total_tokens, estimated_cost, duration, class_name, tenant_id, tags, created_at,
       prompt_key, tier_requested, tier_resolved, run_id, call_id,
       entry_call_id, template_hash, step_index, step_name, step_instance_id,
       attempt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $20, $21, $22, $23, $24)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    id,
    event.provider,
    event.model,
    event.operation,
    event.usage?.promptTokens ?? null,
    event.usage?.completionTokens ?? null,
    event.usage?.totalTokens ?? null,
    event.estimatedCost ?? null,
    event.duration,
    event.className ?? null,
    event.tenantId ?? null,
    event.tags ? JSON.stringify(event.tags) : null,
    event.timestamp.toISOString(),
    liftedTag(event.tags, 'promptKey'),
    liftedTag(event.tags, 'tierRequested'),
    liftedTag(event.tags, 'tierResolved'),
    runId,
    id,
    liftedTag(event.tags, 'callId') ?? id,
    liftedTag(event.tags, 'templateHash'),
    liftedInteger(event.tags, 'stepIndex'),
    liftedTag(event.tags, 'stepName'),
    liftedTag(event.tags, 'stepInstanceId'),
    liftedInteger(event.tags, 'attempt'),
  );
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] } | null)?.rows ?? []);
  return rows.length > 0;
}

/**
 * Persists normalized AI usage events into the framework system table.
 * Deduplicates on the call id (`aiCallId` tag) when the call carries one.
 */
export class AiUsagePersistenceHandler implements AiUsageHandler {
  constructor(private readonly db: DatabaseInterface) {
    persistenceDatabases.set(this, db);
  }

  async handle(event: SmrtAiUsageEvent): Promise<void> {
    try {
      // A released tracked call whose route this process no longer has is
      // settled from its persisted reservation, so its row and its run's
      // totals agree.
      if (
        lateUsageHooks &&
        lateUsageCandidate(event) &&
        (await lateUsageHooks.reconcile(event, this.db))
      ) {
        return;
      }
      await insertAiUsageRow(this.db, event);
    } catch (error) {
      throw new Error(
        `Failed to persist AI usage event for ${event.provider}:${event.model}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }
}
