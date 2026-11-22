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
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
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
 * Prefix of the `owner_class` persona memory is filed under (#5449).
 *
 * A persona's memory is owned by its scope string, not by an object. Core's
 * object delete removes `_smrt_contexts` rows whose `owner_class` is the
 * deleted object's class and whose `owner_id` is its id, in every tenant
 * partition. Class names are identifiers and cannot contain `:`, so a
 * prefixed owner class never names a class, and a `memoryScope` that happens
 * to equal some object's id is never removed with that object.
 */
export const PERSONA_MEMORY_OWNER_PREFIX = 'persona-scope:';

/**
 * The tenant partition a persona's memory uses.
 *
 * A caller-supplied tenant (the turn, feedback row, or reflection pass the
 * memory serves) wins, so a tenantless persona — a manifest default shared by
 * every tenant — learns per tenant instead of in the global partition. A
 * persona that belongs to a different tenant than the caller's is refused
 * before any memory is read or written.
 *
 * The active tenant context (`withTenant`) counts as a caller tenant too, so
 * a direct caller inside a tenant cannot reach the global partition or
 * another tenant's memory by omitting `tenantId`.
 *
 * @throws when any two of `tenantId`, the active tenant and the persona's own
 *   tenant are set and differ.
 */
export function personaMemoryTenant(
  persona: PersonaMemoryLike,
  tenantId?: string | null,
): string | null {
  const own = persona.tenantId || null;
  const active = getCurrentTenant()?.tenantId || null;
  const requested = tenantId || null;
  const bound = [requested, active, own].filter(
    (value): value is string => value !== null,
  );
  if (new Set(bound).size > 1) {
    throw new Error(
      `Persona ${persona.id ?? '(unsaved)'} belongs to another tenant; its ` +
        'learning memory cannot be used for this tenant',
    );
  }
  return bound[0] ?? null;
}

/**
 * Build a {@link LearningMemory} partitioned to a persona's memory scope.
 *
 * The persona's `memoryScope` is used as the memory `owner_id`, so recall and
 * capture are isolated per persona. `owner_class` is the persona's agent class
 * (falling back to `'AgentPersona'`, or `ownerClass` when given) behind
 * {@link PERSONA_MEMORY_OWNER_PREFIX}. The tenant partition comes from
 * {@link personaMemoryTenant}: pass the tenant the memory serves as
 * `tenantId`.
 */
export function personaLearningMemory(options: {
  db: DatabaseInterface;
  persona: PersonaMemoryLike;
  ownerClass?: string;
  tenantId?: string | null;
  semanticSearch?: LearningSemanticSearch;
  config?: Partial<LearningMemoryConfig>;
}): LearningMemory {
  const baseClass =
    options.ownerClass ??
    (options.persona.agentClass?.trim() || 'AgentPersona');
  const ownerClass = baseClass.startsWith(PERSONA_MEMORY_OWNER_PREFIX)
    ? baseClass
    : `${PERSONA_MEMORY_OWNER_PREFIX}${baseClass}`;
  return new LearningMemory({
    db: options.db,
    ownerClass,
    ownerId: personaMemoryScope(options.persona),
    tenantId: personaMemoryTenant(options.persona, options.tenantId),
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
  // A signal belongs to the tenant its row was saved under; it may only move
  // memory in that tenant's partition (#5449).
  const signalTenant = feedback.tenantId || null;
  if (signalTenant !== memory.partitionTenantId) {
    throw new Error(
      "reinforceFromFeedback: the feedback signal's tenant does not match " +
        "the memory's partition",
    );
  }
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
