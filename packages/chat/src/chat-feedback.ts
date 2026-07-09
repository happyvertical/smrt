/**
 * Chat feedback capture — turn an in-conversation judgement into a first-class
 * learning signal (L3 of the learning-agents epic, #1891).
 *
 * A tenant end-user accepting or rejecting an applied change, giving a
 * thumbs-up/down, or typing an inline correction produces a {@link Feedback}
 * row — carrying the conversation's **correlation-id** back to the turn it
 * judges — and (by default) immediately reinforces the persona's learning
 * memory. Because recall draws on that same memory next turn, captured feedback
 * *influences subsequent behaviour*: a rejected strategy decays below the reuse
 * floor and stops resurfacing; a correction supersedes it with the corrected
 * value.
 *
 * This is the human-signal half of the loop the personas package already models
 * ({@link reinforceFromFeedback}); the gated half — rewriting a persona's
 * instructions — stays in the directive-proposal flow.
 *
 * @module
 */

import type {
  LearningMemoryRecord,
  LearningSemanticSearch,
  SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  type Feedback,
  FeedbackCollection,
  type FeedbackSignalType,
  feedbackSourceFor,
  personaLearningMemory,
  personaMemoryScope,
  reinforceFromFeedback,
} from '@happyvertical/smrt-personas';
import { getDatabase } from '@happyvertical/sql';

/** The minimal persona shape chat feedback needs to route the signal. */
export interface ChatFeedbackPersona {
  /** Persona id — required (a signal always judges a specific persona). */
  id?: string | null;
  /** Owning tenant. */
  tenantId?: string | null;
  /** Canonical agent class the persona configures (denormalised onto the row). */
  agentClass?: string;
  /** Learning memory partition key. */
  memoryScope?: string;
}

/**
 * Options for {@link captureChatFeedback}.
 */
export interface CaptureChatFeedbackOptions {
  /** Database handle. */
  db: SmrtClassOptions['db'];
  /** The persona the signal judges. */
  persona: ChatFeedbackPersona;
  /** The kind of signal. */
  signalType: FeedbackSignalType;
  /** Correlation-id of the conversation turn this signal judges. */
  correlationId: string;
  /** What {@link correlationId} names. Default `'chat_message'`. */
  correlationType?: string;
  /** Learning episode scope the signal reinforces (matches recall/capture). */
  scope: string;
  /** Learning episode key the signal reinforces. */
  key: string;
  /** The user id that authored the signal (null for autonomous). */
  actorId?: string | null;
  /** Numeric rating for a `rating` signal. */
  rating?: number | null;
  /** Corrected value for a `correction` signal. */
  correction?: string | null;
  /** Freeform note. */
  comment?: string | null;
  /** Structured metadata persisted on the row. */
  metadata?: Record<string, unknown>;
  /** Apply the signal to memory immediately. Default `true`. */
  reinforce?: boolean;
  /** Optional embedding search wired into the reinforced memory. */
  semanticSearch?: LearningSemanticSearch;
  /** Neutral point of a `rating` scale (see `FeedbackOutcomeOptions`). Default 0. */
  ratingNeutral?: number;
}

/** The outcome of capturing chat feedback. */
export interface ChatFeedbackResult {
  /** The persisted feedback row. */
  feedback: Feedback;
  /** The memory record the signal reinforced, or `null` when it carried none. */
  reinforced: LearningMemoryRecord | null;
}

/**
 * Capture one in-chat feedback signal as a {@link Feedback} row and (by default)
 * reinforce the persona's learning memory from it.
 *
 * @throws when the persona has no id (a signal must name a persisted persona).
 */
export async function captureChatFeedback(
  options: CaptureChatFeedbackOptions,
): Promise<ChatFeedbackResult> {
  if (!options.persona.id) {
    throw new Error(
      'captureChatFeedback requires a persisted persona (missing id)',
    );
  }
  const memoryScope = personaMemoryScope(options.persona);

  const feedbacks = await FeedbackCollection.create({ db: options.db });
  const feedback = await feedbacks.create({
    tenantId: options.persona.tenantId ?? null,
    personaId: options.persona.id,
    agentClass: options.persona.agentClass ?? '',
    memoryScope,
    scope: options.scope,
    key: options.key,
    signalType: options.signalType,
    source: feedbackSourceFor(options.signalType),
    correlationId: options.correlationId,
    correlationType: options.correlationType ?? 'chat_message',
    rating: options.rating ?? null,
    correction: options.correction ?? null,
    comment: options.comment ?? null,
    actorId: options.actorId ?? null,
  });
  if (options.metadata) {
    feedback.setMetadata(options.metadata);
  }
  await feedback.save();

  let reinforced: LearningMemoryRecord | null = null;
  if (options.reinforce !== false) {
    // LearningMemory operates on a resolved DB handle; `getDatabase` accepts a
    // config or a handle and returns a handle (idempotent for a handle).
    const memory = personaLearningMemory({
      db: await getDatabase(options.db as Parameters<typeof getDatabase>[0]),
      persona: options.persona,
      semanticSearch: options.semanticSearch,
    });
    reinforced = await reinforceFromFeedback(memory, feedback, {
      ratingNeutral: options.ratingNeutral,
    });
    // Gate exactly-once reinforcement so a later reflection pass never
    // re-applies this signal (mirrors the personas reflection runner).
    feedback.reinforcedAt = new Date();
    await feedback.save();
  }

  return { feedback, reinforced };
}

/** Shared options for the signal-typed convenience wrappers. */
export type ChatFeedbackBase = Omit<
  CaptureChatFeedbackOptions,
  'signalType' | 'rating' | 'correction'
>;

/**
 * Accept an applied change — reinforces the judged strategy as a success.
 */
export function acceptAppliedChange(
  options: ChatFeedbackBase,
): Promise<ChatFeedbackResult> {
  return captureChatFeedback({ ...options, signalType: 'accept' });
}

/**
 * Reject an applied change — decays the judged strategy toward the failure floor
 * so it stops being recalled.
 */
export function rejectAppliedChange(
  options: ChatFeedbackBase & { comment?: string | null },
): Promise<ChatFeedbackResult> {
  return captureChatFeedback({ ...options, signalType: 'reject' });
}

/**
 * Record an inline correction — decays the wrong strategy AND supersedes its
 * stored value with the corrected one, so the next recall returns the fix.
 */
export function correctResponse(
  options: ChatFeedbackBase & { correction: string; comment?: string | null },
): Promise<ChatFeedbackResult> {
  return captureChatFeedback({
    ...options,
    signalType: 'correction',
    correction: options.correction,
  });
}

/**
 * Record a numeric rating for a response (scale is caller-defined; pass
 * `ratingNeutral` for a mid-point).
 */
export function rateResponse(
  options: ChatFeedbackBase & { rating: number },
): Promise<ChatFeedbackResult> {
  return captureChatFeedback({
    ...options,
    signalType: 'rating',
    rating: options.rating,
  });
}

/** Thumbs-up — a `+1` rating (reinforces as a success against neutral 0). */
export function thumbsUp(
  options: ChatFeedbackBase,
): Promise<ChatFeedbackResult> {
  return captureChatFeedback({ ...options, signalType: 'rating', rating: 1 });
}

/** Thumbs-down — a `-1` rating (decays as a failure against neutral 0). */
export function thumbsDown(
  options: ChatFeedbackBase,
): Promise<ChatFeedbackResult> {
  return captureChatFeedback({ ...options, signalType: 'rating', rating: -1 });
}
