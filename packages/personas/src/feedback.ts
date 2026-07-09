/**
 * Feedback — reinforcement signals for a persona's learning loop (#1889).
 *
 * A `Feedback` row captures one reinforcement signal against a persona and the
 * `LearningMemory` episode it pertains to. Two families of signal are modelled:
 *
 *   - **Human signals** — `accept` / `reject` / `correction` / `rating`: an
 *     operator's judgement on an agent's behaviour.
 *   - **Autonomous signals** — `outcome` / `metric`: a machine-observed result
 *     (a boolean success or a numeric measurement) captured without a human.
 *
 * Every signal carries a **correlation-id** back to the thing it judges — the
 * AI call, dispatch, or job whose result prompted the feedback — so a signal
 * can always be traced to its cause. Signals feed the confidence-scored
 * reinforcement in {@link LearningMemory} (#1886) via {@link toLearningOutcome}:
 * this is the automatic, confidence-only half of the loop. The gated half —
 * rewriting a persona's instructions — lives in the directive-proposal flow.
 *
 * @module
 */

import {
  field,
  foreignKey,
  type LearningOutcome,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/**
 * The kind of reinforcement signal a {@link Feedback} row carries.
 *
 * `accept` / `reject` / `correction` / `rating` are human judgements;
 * `outcome` / `metric` are machine-observed autonomous signals.
 */
export type FeedbackSignalType =
  | 'accept'
  | 'reject'
  | 'correction'
  | 'rating'
  | 'outcome'
  | 'metric';

/** Whether a signal originated from a person or an autonomous observation. */
export type FeedbackSource = 'human' | 'autonomous';

/** The human-authored signal types. */
export const HUMAN_SIGNAL_TYPES: readonly FeedbackSignalType[] = [
  'accept',
  'reject',
  'correction',
  'rating',
];

/**
 * Return the natural source for a signal type: the human judgement types are
 * `'human'`; `outcome` / `metric` are `'autonomous'`.
 */
export function feedbackSourceFor(signal: FeedbackSignalType): FeedbackSource {
  return HUMAN_SIGNAL_TYPES.includes(signal) ? 'human' : 'autonomous';
}

/** Options for {@link Feedback.toLearningOutcome}. */
export interface FeedbackOutcomeOptions {
  /**
   * The neutral point of a `rating` scale. A rating strictly above the neutral
   * reinforces as a success; at or below it decays as a failure. Default `0`
   * (any positive rating is a success), matching {@link LearningOutcome}'s
   * metric convention. Pass e.g. `3` for a 1–5 star scale.
   */
  ratingNeutral?: number;
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * A single reinforcement signal against a persona and a learning episode.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'agent_feedback',
  api: { include: ['list', 'get', 'create'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class Feedback extends SmrtObject {
  /** Owning tenant (optional — autonomous signals may be tenant-less). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The persona this signal judges. */
  @foreignKey('AgentPersona', { required: true })
  personaId: string = '';

  /** Canonical agent class the persona configures (denormalised for queries). */
  @field({ type: 'text' })
  agentClass: string = '';

  /**
   * Memory scope the signal reinforces — the partition key routing it to the
   * right {@link LearningMemory} so different personas reinforce independently.
   */
  @field({ type: 'text' })
  memoryScope: string = '';

  /** Learning episode scope this signal pertains to (`LearningEpisode.scope`). */
  @field({ type: 'text' })
  scope: string = '';

  /** Learning episode key this signal pertains to (`LearningEpisode.key`). */
  @field({ type: 'text' })
  key: string = '';

  /** The kind of signal (see {@link FeedbackSignalType}). */
  @field({ type: 'text' })
  signalType: FeedbackSignalType = 'outcome';

  /** Whether the signal is human or autonomous. */
  @field({ type: 'text' })
  source: FeedbackSource = 'autonomous';

  /**
   * Correlation-id back to the thing this signal judges — the AI call,
   * dispatch, or job id. Required so a signal is always traceable to its cause.
   */
  @field({ type: 'text', required: true })
  correlationId: string = '';

  /**
   * What kind of thing {@link correlationId} names (e.g. `'ai_call'`,
   * `'dispatch'`, `'job'`). `null` when the namespace is implicit.
   */
  @field({ type: 'text', nullable: true })
  correlationType: string | null = null;

  /** Numeric rating for a `rating` signal (scale is caller-defined). */
  @field({ type: 'decimal', nullable: true })
  rating: number | null = null;

  /** Observed measurement for a `metric` signal. */
  @field({ type: 'decimal', nullable: true })
  metric: number | null = null;

  /** Observed boolean result for an `outcome` signal. */
  @field({ type: 'boolean', nullable: true })
  success: boolean | null = null;

  /**
   * Corrected instructions/value for a `correction` signal — the human-supplied
   * replacement that should supersede the strategy that was judged wrong.
   */
  @field({ type: 'text', nullable: true })
  correction: string | null = null;

  /** Freeform note attached to the signal. */
  @field({ type: 'text', nullable: true })
  comment: string | null = null;

  /** The user id that authored a human signal (`null` for autonomous). */
  @field({ type: 'text', nullable: true })
  actorId: string | null = null;

  /** Arbitrary structured metadata, stored as a JSON string. */
  @field({ type: 'text' })
  metadata: string = '{}';

  /**
   * When this signal was applied to memory as reinforcement. `null` until a
   * reflection pass consumes it. Gates exactly-once reinforcement so a scheduled
   * runner never re-applies the same signal (which would amplify a single
   * accept/reject into many outcomes).
   */
  @field({ type: 'datetime', nullable: true })
  reinforcedAt: Date | null = null;

  /** Whether this is a human-authored signal. */
  isHuman(): boolean {
    return this.source === 'human';
  }

  /** Parse {@link metadata}, tolerating malformed JSON. */
  getMetadata(): Record<string, unknown> {
    return parseJsonObject(this.metadata);
  }

  /** Replace {@link metadata}. */
  setMetadata(value: Record<string, unknown>): void {
    this.metadata = JSON.stringify(value ?? {});
  }

  /** Shallow-merge into {@link metadata}. */
  updateMetadata(patch: Record<string, unknown>): void {
    this.setMetadata({ ...this.getMetadata(), ...patch });
  }

  /**
   * The strategy value a `correction` signal should persist into memory, so a
   * regenerated (corrected) strategy supersedes the one that was judged wrong.
   * `undefined` for non-correction signals (reinforce confidence only).
   */
  getCorrectionValue(): string | undefined {
    return this.signalType === 'correction' && this.correction != null
      ? this.correction
      : undefined;
  }

  /**
   * Map this signal onto a {@link LearningOutcome} for reinforcement, or `null`
   * when the signal carries no reinforcement value:
   *
   * - `accept` → success; `reject` / `correction` → failure.
   * - `outcome` → the recorded boolean `success`.
   * - `metric` → the recorded `metric` (positive → success).
   * - `rating` → `{ metric: rating - ratingNeutral }`.
   */
  toLearningOutcome(
    options: FeedbackOutcomeOptions = {},
  ): LearningOutcome | null {
    switch (this.signalType) {
      case 'accept':
        return { success: true };
      case 'reject':
      case 'correction':
        return { success: false, error: this.comment ?? undefined };
      case 'outcome':
        return this.success == null ? null : { success: this.success };
      case 'metric':
        return this.metric == null ? null : { metric: this.metric };
      case 'rating': {
        if (this.rating == null) {
          return null;
        }
        return { metric: this.rating - (options.ratingNeutral ?? 0) };
      }
      default:
        return null;
    }
  }
}

/**
 * Collection for {@link Feedback} rows.
 */
export class FeedbackCollection extends SmrtCollection<Feedback> {
  static readonly _itemClass = Feedback;

  /** All signals for a persona, newest first. */
  async forPersona(
    personaId: string,
    options: { limit?: number } = {},
  ): Promise<Feedback[]> {
    return this.list({
      where: { personaId },
      orderBy: 'created_at DESC',
      limit: options.limit,
    });
  }

  /** All signals filed under a memory scope, newest first. */
  async forScope(
    memoryScope: string,
    options: { limit?: number } = {},
  ): Promise<Feedback[]> {
    return this.list({
      where: { memoryScope },
      orderBy: 'created_at DESC',
      limit: options.limit,
    });
  }

  /** Every signal correlated to a given AI call / dispatch / job id. */
  async byCorrelation(correlationId: string): Promise<Feedback[]> {
    return this.list({
      where: { correlationId },
      orderBy: 'created_at DESC',
    });
  }
}

export default Feedback;
