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
 * Usage tags lifted into indexed `_smrt_ai_usage` columns (#4751; `callId`,
 * #4780), tag name to
 * column name. The full tag map is always stored in `tags` as well, so a
 * lifted tag is a copy, never a move.
 */
export const AI_USAGE_TAG_COLUMNS = Object.freeze({
  promptKey: 'prompt_key',
  tierRequested: 'tier_requested',
  tierResolved: 'tier_resolved',
  runId: 'run_id',
  callId: 'call_id',
} as const);

/** A lifted tag value: a non-empty string, else NULL. */
function liftedTag(
  tags: Record<string, string> | undefined,
  name: keyof typeof AI_USAGE_TAG_COLUMNS,
): string | null {
  const value = tags?.[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Persists normalized AI usage events into the framework system table.
 */
export class AiUsagePersistenceHandler implements AiUsageHandler {
  constructor(private readonly db: DatabaseInterface) {}

  async handle(event: SmrtAiUsageEvent): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO _smrt_ai_usage
          (id, provider, model, operation, prompt_tokens, completion_tokens,
           total_tokens, estimated_cost, duration, class_name, tenant_id, tags, created_at,
           prompt_key, tier_requested, tier_resolved, run_id, call_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        crypto.randomUUID(),
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
        liftedTag(event.tags, 'runId'),
        liftedTag(event.tags, 'callId'),
      );
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
