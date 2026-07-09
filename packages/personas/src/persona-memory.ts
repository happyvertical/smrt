/**
 * Persona-scoped learning memory routing (#1889).
 *
 * A persona's `memoryScope` routes {@link LearningMemory} so different personas
 * of the same agent class learn independently. The scope becomes the memory
 * partition (`owner_id`), so two personas never share confidence-scored
 * strategies even when they run the identical agent class over the same tenant.
 *
 * The other direction of the loop — turning a {@link Feedback} signal into a
 * confidence adjustment — is {@link reinforceFromFeedback}: the automatic,
 * confidence-only reinforcement that stays ungated (only instruction rewrites
 * are gated).
 *
 * @module
 */

import {
  LearningMemory,
  type LearningMemoryConfig,
  type LearningMemoryRecord,
  type LearningSemanticSearch,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { Feedback, FeedbackOutcomeOptions } from './feedback.js';

/** The minimal persona shape the memory router needs. */
export interface PersonaMemoryLike {
  id?: string | null;
  memoryScope?: string;
  agentClass?: string;
  tenantId?: string | null;
}

/**
 * The effective memory partition key for a persona: its explicit `memoryScope`,
 * or a stable `persona:<id>` fallback when none is set.
 *
 * @throws if neither a `memoryScope` nor an id is available.
 */
export function personaMemoryScope(persona: PersonaMemoryLike): string {
  const explicit = persona.memoryScope?.trim();
  if (explicit) {
    return explicit;
  }
  if (persona.id) {
    return `persona:${persona.id}`;
  }
  throw new Error(
    'personaMemoryScope requires a persona with a memoryScope or an id',
  );
}

/**
 * Build a {@link LearningMemory} partitioned to a persona's memory scope.
 *
 * The persona's `memoryScope` is used as the memory `owner_id`, so recall and
 * capture are isolated per persona. `owner_class` defaults to the persona's
 * agent class (falling back to `'AgentPersona'`).
 */
export function personaLearningMemory(options: {
  db: DatabaseInterface;
  persona: PersonaMemoryLike;
  ownerClass?: string;
  tenantId?: string | null;
  semanticSearch?: LearningSemanticSearch;
  config?: Partial<LearningMemoryConfig>;
}): LearningMemory {
  const ownerClass =
    options.ownerClass ??
    (options.persona.agentClass?.trim() || 'AgentPersona');
  return new LearningMemory({
    db: options.db,
    ownerClass,
    ownerId: personaMemoryScope(options.persona),
    tenantId: options.tenantId ?? options.persona.tenantId ?? null,
    semanticSearch: options.semanticSearch,
    config: options.config,
  });
}

/**
 * Apply a single {@link Feedback} signal to a persona's memory as
 * confidence-only reinforcement.
 *
 * Maps the signal onto a `LearningOutcome` and captures it against the episode
 * the signal names (`feedback.scope` / `feedback.key`). A `correction` signal
 * additionally supersedes the stored strategy with the corrected value.
 *
 * @returns The updated/seeded memory record, or `null` when the signal carries
 *   no reinforcement value (or there was nothing to reinforce).
 */
export async function reinforceFromFeedback(
  memory: LearningMemory,
  feedback: Feedback,
  options: FeedbackOutcomeOptions = {},
): Promise<LearningMemoryRecord | null> {
  const outcome = feedback.toLearningOutcome(options);
  if (!outcome) {
    return null;
  }
  const value = feedback.getCorrectionValue();
  return memory.capture(
    {
      scope: feedback.scope,
      key: feedback.key,
      ...(value !== undefined ? { value } : {}),
    },
    outcome,
  );
}
