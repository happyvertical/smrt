/**
 * LearningMemory — confidence-scored, self-correcting memory over the existing
 * `_smrt_contexts` (keyed recall) and `_smrt_embeddings` (semantic recall)
 * substrate.
 *
 * This is the L1 deep module of the tenant-learning-agents epic (#1885 / #1886).
 * It wires the reinforcement columns that ship on `_smrt_contexts` but were
 * never written — `success_count`, `failure_count`, and a `last_used_at` that
 * is refreshed on recall — and layers a confidence floor + decay on top of the
 * primitive `remember()` / `recall()` methods so a strategy that stops working
 * stops being reused.
 *
 * It generalises the confidence-scored parser cache anytown's `praeco` agent
 * hand-rolls: recall only reuses a memory at `confidence >= minConfidence`
 * (default 0.7); a validated success strengthens confidence toward 1.0; an
 * observed failure decays it toward `failureConfidence` (default 0.3) so a
 * single failure drops it below the reuse floor.
 *
 * @module
 */

import type { DatabaseInterface } from '@happyvertical/sql';

/**
 * A relevance-scored memory returned by {@link LearningMemory.recall}.
 *
 * Records sourced from keyed `_smrt_contexts` lookups carry reinforcement
 * counters; records sourced from semantic embedding search carry a
 * `similarity` score (mirrored into `confidence` for uniform ranking).
 */
export interface LearningMemoryRecord {
  /** Row id in `_smrt_contexts`, or the matched object id for semantic hits. */
  id: string;
  /** Hierarchical scope the memory is filed under. */
  scope: string;
  /** Lookup key within the scope. */
  key: string;
  /** The stored value (JSON-parsed for context rows; the matched object for semantic hits). */
  value: unknown;
  /** Confidence in `[0, 1]`. For semantic hits this equals `similarity`. */
  confidence: number;
  /** Number of captured successes reinforcing this memory. */
  successCount: number;
  /** Number of captured failures decaying this memory. */
  failureCount: number;
  /** Last time this memory was recalled or reinforced. */
  lastUsedAt: Date | null;
  /** Where the record came from. */
  source: 'context' | 'semantic';
  /** Cosine similarity for semantic hits (absent for context rows). */
  similarity?: number;
}

/**
 * The outcome of acting on a recalled (or freshly generated) memory.
 *
 * A boolean `success` signal is the common case; a numeric `metric` delta is
 * supported as a convenience (positive → success, non-positive → failure).
 */
export type LearningOutcome =
  | { success: boolean; error?: string }
  | { metric: number; error?: string };

/**
 * The episode being reinforced — the scope/key of the memory the agent acted
 * on, plus (for a first capture) the value to persist.
 */
export interface LearningEpisode {
  /** Scope the memory is filed under (e.g. `'sample/parse-invoice'`). */
  scope: string;
  /** Lookup key within the scope. */
  key: string;
  /**
   * Value to persist when no memory exists yet for `(scope, key)`. Ignored
   * when a memory already exists unless {@link LearningEpisode.updateValue} is
   * set — a captured outcome never silently rewrites a stored strategy.
   */
  value?: unknown;
  /**
   * When `true`, overwrite the stored value with {@link LearningEpisode.value}
   * even if a memory already exists (used to feed a corrected/failed attempt
   * back in for self-correction context).
   */
  updateValue?: boolean;
  /** Optional metadata to persist on a first capture. */
  metadata?: Record<string, unknown>;
  /** Optional expiry after which recall ignores the memory. */
  expiresAt?: Date;
}

/**
 * Tunable thresholds for the reinforcement loop. Defaults mirror the proven
 * `praeco` behaviour.
 */
export interface LearningMemoryConfig {
  /** Reuse floor — recall omits memories below this confidence. Default 0.7. */
  minConfidence: number;
  /** Confidence a brand-new memory is seeded at on a first success. Default 0.9. */
  successConfidence: number;
  /** Target a memory decays toward on failure. Default 0.3. */
  failureConfidence: number;
  /**
   * Blend weight in `[0, 1]` for each reinforcement step. At 0.5 a single
   * failure from any confident value (>= 0.7) always lands below the 0.7 floor
   * (`0.5·c + 0.15 <= 0.65`). Default 0.5.
   */
  reinforcement: number;
  /**
   * Optional half-life (ms) for time-based confidence decay. When set, recall
   * discounts a memory's stored confidence by `0.5 ^ (age / halfLife)` based on
   * `last_used_at`, so stale memory falls below the floor over time even
   * without an explicit failure. Off (no time decay) when undefined.
   */
  decayHalfLifeMs?: number;
}

/** Default reinforcement thresholds. */
export const DEFAULT_LEARNING_CONFIG: LearningMemoryConfig = {
  minConfidence: 0.7,
  successConfidence: 0.9,
  failureConfidence: 0.3,
  reinforcement: 0.5,
};

/**
 * A semantic search over stored embeddings, injected so `LearningMemory` never
 * reaches into a collection's internals. Matches the shape of
 * `SmrtCollection.semanticSearch`.
 */
export type LearningSemanticSearch = (
  query: string,
  options: {
    limit?: number;
    minSimilarity?: number;
    where?: Record<string, unknown>;
  },
) => Promise<
  Array<{ id?: string; _similarity: number } & Record<string, unknown>>
>;

/** Options for {@link LearningMemory.recall}. */
export interface LearningRecallOptions {
  /** Exact key to look up within the scope. Omit for a scope-wide recall. */
  key?: string;
  /** Free-text query for semantic recall (only used when a searcher is wired). */
  query?: string;
  /** Override the reuse floor for this call. */
  minConfidence?: number;
  /** Walk up the scope hierarchy when no match is found at `scope`. Default true. */
  includeAncestors?: boolean;
  /** Cap on returned records. */
  limit?: number;
  /** Cap on semantic hits requested from the searcher. Default 10. */
  semanticLimit?: number;
  /** Minimum cosine similarity for semantic hits. Default 0. */
  minSimilarity?: number;
  /** Reference time for decay/expiry evaluation (injectable for tests). */
  now?: Date;
}

/** Constructor options for {@link LearningMemory}. */
export interface LearningMemoryOptions {
  /** System database handle (an owning object's `systemDb`). */
  db: DatabaseInterface;
  /** `owner_class` the memories are filed under. */
  ownerClass: string;
  /** `owner_id` the memories are filed under (isolates memory per owner). */
  ownerId: string;
  /**
   * Optional tenant id. When set it is threaded into the semantic searcher's
   * `where` filter so embedding recall stays tenant-scoped. Keyed-context
   * recall is already isolated by `owner_id`.
   */
  tenantId?: string | null;
  /** Optional embedding search for the semantic recall arm. */
  semanticSearch?: LearningSemanticSearch;
  /** Threshold overrides; merged over {@link DEFAULT_LEARNING_CONFIG}. */
  config?: Partial<LearningMemoryConfig>;
}

const CONTEXTS_TABLE = '_smrt_contexts';
const CONFLICT_COLUMNS = ['owner_class', 'owner_id', 'scope', 'key', 'version'];

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeOutcome(outcome: LearningOutcome): {
  success: boolean;
  error?: string;
} {
  if ('success' in outcome) {
    return { success: outcome.success, error: outcome.error };
  }
  return { success: outcome.metric > 0, error: outcome.error };
}

function toDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    // Tolerate legacy/non-JSON payloads rather than throwing mid-recall.
    return raw;
  }
}

/**
 * Confidence-scored, self-correcting memory over `_smrt_contexts` and
 * (optionally) semantic embedding search.
 *
 * @example
 * ```typescript
 * const memory = new LearningMemory({
 *   db: agent.systemDb,
 *   ownerClass: 'InvoiceAgent',
 *   ownerId: agent.id,
 *   tenantId: agent.tenantId,
 * });
 *
 * // Recall a confident strategy for this task.
 * const [hit] = await memory.recall('parser/acme', { key: docUrl });
 * const strategy = hit?.value ?? (await generateStrategy(docUrl));
 *
 * // ...act on `strategy`, then reinforce the outcome.
 * await memory.capture(
 *   { scope: 'parser/acme', key: docUrl, value: strategy },
 *   { success: extracted.length > 0 },
 * );
 * ```
 */
export class LearningMemory {
  private readonly db: DatabaseInterface;
  private readonly ownerClass: string;
  private readonly ownerId: string;
  private readonly tenantId: string | null;
  private readonly semanticSearch?: LearningSemanticSearch;
  private readonly config: LearningMemoryConfig;

  constructor(options: LearningMemoryOptions) {
    this.db = options.db;
    this.ownerClass = options.ownerClass;
    this.ownerId = options.ownerId;
    this.tenantId = options.tenantId ?? null;
    this.semanticSearch = options.semanticSearch;
    this.config = { ...DEFAULT_LEARNING_CONFIG, ...(options.config ?? {}) };
  }

  /** The resolved reinforcement thresholds (defaults merged with overrides). */
  get thresholds(): LearningMemoryConfig {
    return { ...this.config };
  }

  /**
   * Recall confidence-filtered, relevant memories for a scope.
   *
   * Unions two arms:
   * 1. **Keyed context recall** over `_smrt_contexts` — owner-scoped (and thus
   *    tenant-isolated), filtered by the confidence floor, expiry, and optional
   *    time-decay, with hierarchical scope fallback. Surviving rows have their
   *    `last_used_at` refreshed.
   * 2. **Semantic recall** over stored embeddings (only when a searcher was
   *    wired and a `query` is given) — tenant-scoped via the searcher's `where`.
   *
   * @returns Records sorted by confidence (then similarity) descending.
   */
  async recall(
    scope: string,
    options: LearningRecallOptions = {},
  ): Promise<LearningMemoryRecord[]> {
    const floor = options.minConfidence ?? this.config.minConfidence;
    const now = options.now ?? new Date();
    const includeAncestors = options.includeAncestors ?? true;

    const contextRecords = await this.recallContexts(scope, {
      key: options.key,
      floor,
      now,
      includeAncestors,
    });

    // Wire the previously-dead refresh: recall marks a memory as used.
    await this.touch(
      contextRecords.map((r) => r.id),
      now,
    );

    let semanticRecords: LearningMemoryRecord[] = [];
    if (options.query && this.semanticSearch) {
      semanticRecords = await this.recallSemantic(options.query, {
        floor: options.minSimilarity ?? 0,
        limit: options.semanticLimit ?? 10,
      });
    }

    const merged = [...contextRecords, ...semanticRecords].sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return (b.similarity ?? 0) - (a.similarity ?? 0);
    });

    return options.limit != null ? merged.slice(0, options.limit) : merged;
  }

  /**
   * Reinforce a memory from an observed outcome.
   *
   * - Wires the dormant reinforcement columns: increments `success_count` on
   *   success, `failure_count` on failure.
   * - Adjusts `confidence`: success strengthens toward 1.0; failure decays
   *   toward `failureConfidence` (default 0.3), dropping a confident memory
   *   below the reuse floor in a single step.
   * - Refreshes `last_used_at` and `updated_at`.
   * - Seeds a new memory when none exists for `(scope, key)` and the episode
   *   carries a `value` (a failed first attempt is retained at low confidence
   *   for self-correction context).
   *
   * @returns The updated (or seeded) record, or `null` when there was nothing
   *   to reinforce (no existing memory and no value to seed).
   */
  async capture(
    episode: LearningEpisode,
    outcome: LearningOutcome,
  ): Promise<LearningMemoryRecord | null> {
    const { success, error } = normalizeOutcome(outcome);
    const now = new Date();

    const existing = await this.db.get(CONTEXTS_TABLE, {
      owner_class: this.ownerClass,
      owner_id: this.ownerId,
      scope: episode.scope,
      key: episode.key,
      version: 1,
    });

    if (existing) {
      const currentConfidence = Number(existing.confidence ?? 1);
      const nextConfidence = this.nextConfidence(currentConfidence, success);
      const successCount =
        Number(existing.success_count ?? 0) + (success ? 1 : 0);
      const failureCount =
        Number(existing.failure_count ?? 0) + (success ? 0 : 1);

      const data: Record<string, unknown> = {
        confidence: nextConfidence,
        success_count: successCount,
        failure_count: failureCount,
        last_used_at: now,
        updated_at: now,
      };
      if (episode.updateValue && episode.value !== undefined) {
        data.value = JSON.stringify(episode.value);
      }
      if (episode.metadata !== undefined) {
        data.metadata = JSON.stringify({
          ...this.parseMetadata(existing.metadata),
          ...episode.metadata,
          ...(error ? { lastError: error } : {}),
        });
      } else if (error) {
        data.metadata = JSON.stringify({
          ...this.parseMetadata(existing.metadata),
          lastError: error,
        });
      }

      await this.db.update(CONTEXTS_TABLE, { id: existing.id }, data);

      return {
        id: String(existing.id),
        scope: episode.scope,
        key: episode.key,
        value:
          episode.updateValue && episode.value !== undefined
            ? episode.value
            : parseValue(existing.value),
        confidence: nextConfidence,
        successCount,
        failureCount,
        lastUsedAt: now,
        source: 'context',
      };
    }

    // No existing memory: seed one only if the episode provides a value.
    if (episode.value === undefined) {
      return null;
    }

    const id = crypto.randomUUID();
    const confidence = success
      ? this.config.successConfidence
      : this.config.failureConfidence;
    const metadata =
      episode.metadata || error
        ? JSON.stringify({
            ...(episode.metadata ?? {}),
            ...(error ? { lastError: error } : {}),
          })
        : null;

    await this.db.upsert(CONTEXTS_TABLE, CONFLICT_COLUMNS, {
      id,
      owner_class: this.ownerClass,
      owner_id: this.ownerId,
      scope: episode.scope,
      key: episode.key,
      value: JSON.stringify(episode.value),
      metadata,
      version: 1,
      confidence,
      success_count: success ? 1 : 0,
      failure_count: success ? 0 : 1,
      created_at: now,
      updated_at: now,
      last_used_at: now,
      expires_at: episode.expiresAt ?? null,
    });

    return {
      id,
      scope: episode.scope,
      key: episode.key,
      value: episode.value,
      confidence,
      successCount: success ? 1 : 0,
      failureCount: success ? 0 : 1,
      lastUsedAt: now,
      source: 'context',
    };
  }

  /**
   * Compute the next confidence from the current value and an outcome.
   *
   * Success strengthens toward 1.0; failure blends toward `failureConfidence`.
   * Exposed as a pure step so callers/tests can reason about the curve.
   */
  nextConfidence(current: number, success: boolean): number {
    const r = this.config.reinforcement;
    if (success) {
      return clamp01(current + r * (1 - current));
    }
    return clamp01(current + r * (this.config.failureConfidence - current));
  }

  private async recallContexts(
    scope: string,
    opts: {
      key?: string;
      floor: number;
      now: Date;
      includeAncestors: boolean;
    },
  ): Promise<LearningMemoryRecord[]> {
    const scopes = opts.includeAncestors ? this.scopeChain(scope) : [scope];

    for (const candidateScope of scopes) {
      const rows = await this.selectContextRows(candidateScope, opts.key);
      const records = this.filterAndRank(rows, opts.floor, opts.now);
      if (records.length > 0) {
        return records;
      }
    }
    return [];
  }

  private async selectContextRows(
    scope: string,
    key?: string,
  ): Promise<Record<string, unknown>[]> {
    if (key !== undefined) {
      const { rows } = await this.db.query(
        `SELECT * FROM ${CONTEXTS_TABLE}
         WHERE owner_class = ? AND owner_id = ? AND scope = ? AND key = ?`,
        this.ownerClass,
        this.ownerId,
        scope,
        key,
      );
      return rows;
    }
    const { rows } = await this.db.query(
      `SELECT * FROM ${CONTEXTS_TABLE}
       WHERE owner_class = ? AND owner_id = ? AND scope = ?`,
      this.ownerClass,
      this.ownerId,
      scope,
    );
    return rows;
  }

  private filterAndRank(
    rows: Record<string, unknown>[],
    floor: number,
    now: Date,
  ): LearningMemoryRecord[] {
    const records: LearningMemoryRecord[] = [];

    for (const row of rows) {
      const expiresAt = toDate(row.expires_at);
      if (expiresAt && expiresAt.getTime() <= now.getTime()) {
        continue;
      }

      const lastUsedAt = toDate(row.last_used_at);
      const stored = Number(row.confidence ?? 1);
      const effective = this.applyTimeDecay(stored, lastUsedAt, now);
      if (effective < floor) {
        continue;
      }

      records.push({
        id: String(row.id),
        scope: String(row.scope),
        key: String(row.key),
        value: parseValue(row.value),
        confidence: effective,
        successCount: Number(row.success_count ?? 0),
        failureCount: Number(row.failure_count ?? 0),
        lastUsedAt,
        source: 'context',
      });
    }

    // Highest confidence first; break ties on the higher version.
    return records.sort((a, b) => b.confidence - a.confidence);
  }

  private applyTimeDecay(
    confidence: number,
    lastUsedAt: Date | null,
    now: Date,
  ): number {
    const halfLife = this.config.decayHalfLifeMs;
    if (!halfLife || halfLife <= 0 || !lastUsedAt) {
      return confidence;
    }
    const age = now.getTime() - lastUsedAt.getTime();
    if (age <= 0) return confidence;
    return clamp01(confidence * 0.5 ** (age / halfLife));
  }

  private async recallSemantic(
    query: string,
    opts: { floor: number; limit: number },
  ): Promise<LearningMemoryRecord[]> {
    if (!this.semanticSearch) return [];

    const where: Record<string, unknown> | undefined =
      this.tenantId != null ? { tenant_id: this.tenantId } : undefined;

    const hits = await this.semanticSearch(query, {
      limit: opts.limit,
      minSimilarity: opts.floor,
      where,
    });

    return hits.map((hit) => ({
      id: hit.id != null ? String(hit.id) : crypto.randomUUID(),
      scope: 'semantic',
      key: hit.id != null ? String(hit.id) : query,
      value: hit,
      confidence: hit._similarity,
      successCount: 0,
      failureCount: 0,
      lastUsedAt: null,
      source: 'semantic',
      similarity: hit._similarity,
    }));
  }

  private async touch(ids: string[], now: Date): Promise<void> {
    for (const id of ids) {
      await this.db.update(CONTEXTS_TABLE, { id }, { last_used_at: now });
    }
  }

  private scopeChain(scope: string): string[] {
    const chain: string[] = [scope];
    const parts = scope.split('/');
    while (parts.length > 0) {
      parts.pop();
      chain.push(parts.join('/') || 'global');
    }
    // De-dupe while preserving order (guards against a leading 'global').
    return [...new Set(chain)];
  }

  private parseMetadata(raw: unknown): Record<string, unknown> {
    if (typeof raw !== 'string' || raw.length === 0) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
}
