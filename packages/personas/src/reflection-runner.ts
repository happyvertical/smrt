/**
 * ReflectionRunner — the scheduled consolidation step of the learning loop (#1889).
 *
 * Runs under the **autonomous reflection principal**, which deliberately lacks
 * the `personas.activate-directive` permission. For a persona it:
 *
 *   1. Applies recent {@link Feedback} to the persona's {@link LearningMemory}
 *      as automatic, confidence-only reinforcement (ungated).
 *   2. Consolidates the resulting episodes + feedback and asks an injected
 *      reflector (the AI boundary, mocked in tests) for a candidate rewrite of
 *      the persona's instructions.
 *   3. Records that rewrite as a **pending** {@link DirectiveProposal} with
 *      rationale + evidence — deduped by fingerprint so an already-seen (e.g.
 *      rejected) rewrite is never re-surfaced.
 *
 * It cannot activate anything: writing the persona override is gated by the
 * permission its principal does not hold. That split is the whole gate.
 *
 * The runner is transport-agnostic; schedule it through an `AgentSchedule` /
 * background job by calling {@link run} on a cadence.
 *
 * @module
 */

import type {
  LearningMemory,
  LearningMemoryRecord,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { DirectivePrincipal } from './directive-principal.js';
import {
  computeDirectiveFingerprint,
  type DirectiveProposal,
  DirectiveProposalCollection,
} from './directive-proposal.js';
import { type Feedback, FeedbackCollection } from './feedback.js';
import { reinforceFromFeedback } from './persona-memory.js';
import {
  ensurePersonaInstructionsPrompt,
  personaInstructionsPromptKey,
  resolvePersonaInstructions,
} from './persona-prompt.js';

/** The (normalised) persona shape handed to the reflector. */
export interface ReflectionPersona {
  id: string;
  tenantId: string;
  agentClass?: string;
  name?: string;
  instructions?: string;
  memoryScope?: string;
}

/**
 * The persona a run consolidates over — accepts a persisted `AgentPersona`
 * directly (its `id` / `tenantId` are validated at run time).
 */
export interface ReflectionPersonaInput {
  id?: string | null;
  tenantId?: string | null;
  agentClass?: string;
  name?: string;
  instructions?: string;
  memoryScope?: string;
}

/** The consolidated input handed to the reflector (the AI boundary). */
export interface ReflectionInput {
  persona: ReflectionPersona;
  /** The persona's current effective instructions (resolved via prompts). */
  currentInstructions: string;
  /** Recent episodes for the persona's memory scope. */
  episodes: LearningMemoryRecord[];
  /** Recent feedback signals for the persona. */
  feedback: Feedback[];
}

/** A candidate rewrite returned by the reflector. */
export interface DirectiveDraft {
  /** Proposed replacement instructions. */
  instructions: string;
  /** Model-authored explanation. */
  rationale: string;
  /** Optional aggregate confidence in `[0, 1]`. */
  confidence?: number;
}

/**
 * The reflection boundary: consolidate episodes + feedback into a proposed
 * instruction rewrite, or `null` to propose nothing. Injected so the AI call is
 * the only thing mocked in tests.
 */
export type DirectiveReflector = (
  input: ReflectionInput,
) => Promise<DirectiveDraft | null> | DirectiveDraft | null;

/** Options for {@link ReflectionRunner}. */
export interface ReflectionRunnerOptions {
  db: DatabaseInterface;
  /** The autonomous principal — must NOT hold `personas.activate-directive`. */
  principal: DirectivePrincipal;
  /** The reflection boundary (AI call), injected. */
  reflect: DirectiveReflector;
  proposals?: DirectiveProposalCollection;
  feedback?: FeedbackCollection;
  /** Clock, injectable for deterministic lookback in tests. */
  now?: () => Date;
}

/** Options for a single {@link ReflectionRunner.run} pass over one persona. */
export interface ReflectionRunOptions {
  persona: ReflectionPersonaInput;
  /** The persona-scoped learning memory (see `personaLearningMemory`). */
  memory: LearningMemory;
  /** Episode scope to recall for evidence. Omit to skip episode gathering. */
  episodeScope?: string;
  /** Only consider feedback newer than this many ms ago. */
  lookbackMs?: number;
  /** Cap on feedback rows considered. Default 50. */
  feedbackLimit?: number;
  /** Neutral point for `rating` signals during reinforcement. Default 0. */
  ratingNeutral?: number;
  /** Override the target prompt key (default the persona instructions key). */
  promptKey?: string;
}

/** Result of a {@link ReflectionRunner.run} pass. */
export interface ReflectionRunResult {
  /** Newly created pending proposals (0 or 1). */
  proposals: DirectiveProposal[];
  /** Number of feedback signals that adjusted memory reinforcement. */
  reinforced: number;
  /** Number of candidate rewrites suppressed (deduped / no-op). */
  skipped: number;
}

function normalizePersona(input: ReflectionPersonaInput): ReflectionPersona {
  if (!input.id) {
    throw new Error(
      'ReflectionRunner.run requires a persisted persona (missing id)',
    );
  }
  if (!input.tenantId) {
    throw new Error(
      'ReflectionRunner.run requires a tenant-scoped persona (missing tenantId)',
    );
  }
  return {
    id: input.id,
    tenantId: input.tenantId,
    agentClass: input.agentClass,
    name: input.name,
    instructions: input.instructions,
    memoryScope: input.memoryScope,
  };
}

function meanConfidence(episodes: LearningMemoryRecord[]): number {
  if (episodes.length === 0) {
    return 0.5;
  }
  const sum = episodes.reduce((acc, e) => acc + e.confidence, 0);
  return sum / episodes.length;
}

/**
 * Consolidates feedback + episodes into pending directive proposals under a
 * principal that cannot activate them.
 */
export class ReflectionRunner {
  private readonly db: DatabaseInterface;
  private readonly reflect: DirectiveReflector;
  private readonly now: () => Date;
  private readonly _principal: DirectivePrincipal;
  private proposalsCol?: DirectiveProposalCollection;
  private feedbackCol?: FeedbackCollection;

  constructor(options: ReflectionRunnerOptions) {
    this.db = options.db;
    this._principal = options.principal;
    this.reflect = options.reflect;
    this.now = options.now ?? (() => new Date());
    this.proposalsCol = options.proposals;
    this.feedbackCol = options.feedback;
  }

  /**
   * The autonomous principal this runner acts as. Exposed so callers can prove
   * it cannot activate a proposal (it lacks `personas.activate-directive`).
   */
  get principal(): DirectivePrincipal {
    return this._principal;
  }

  /**
   * Run one reflection pass for a persona.
   */
  async run(options: ReflectionRunOptions): Promise<ReflectionRunResult> {
    const { memory } = options;
    const persona = normalizePersona(options.persona);
    const feedbackCol = await this.feedbackCollection();

    // 1. Recent feedback for the persona (optionally windowed).
    const feedbackLimit = options.feedbackLimit ?? 50;
    let feedback = await feedbackCol.forPersona(persona.id, {
      limit: feedbackLimit,
    });
    if (options.lookbackMs != null) {
      const cutoff = this.now().getTime() - options.lookbackMs;
      feedback = feedback.filter((f) => {
        const created = f.created_at ? new Date(f.created_at).getTime() : 0;
        return created >= cutoff;
      });
    }

    // 2. Automatic, confidence-only reinforcement — applied EXACTLY ONCE per
    //    signal. A signal already consumed (`reinforcedAt` set) is skipped, so a
    //    scheduled runner never re-applies it and amplifies one accept/reject
    //    into many outcomes. Directive review signals (accept/reject of a
    //    proposal) judge a proposal, not an episode, so they are marked consumed
    //    without reinforcing.
    let reinforced = 0;
    for (const signal of feedback) {
      if (signal.reinforcedAt) {
        continue;
      }
      if (signal.correlationType !== 'directive_proposal') {
        const record = await reinforceFromFeedback(memory, signal, {
          ratingNeutral: options.ratingNeutral,
        });
        if (record) {
          reinforced += 1;
        }
      }
      signal.reinforcedAt = this.now();
      await signal.save();
    }

    // 3. Gather episodes as evidence (all confidences, including decayed ones).
    const episodes = options.episodeScope
      ? await memory.recall(options.episodeScope, {
          minConfidence: 0,
          includeAncestors: true,
        })
      : [];

    // 4. Resolve the persona's current instructions, then ask the reflector.
    ensurePersonaInstructionsPrompt(persona);
    const currentInstructions = await resolvePersonaInstructions({
      persona,
      db: this.db,
    });

    const draft = await this.reflect({
      persona,
      currentInstructions,
      episodes,
      feedback,
    });

    if (!draft || draft.instructions.trim() === currentInstructions.trim()) {
      // Nothing to propose, or a no-op rewrite.
      return { proposals: [], reinforced, skipped: draft ? 1 : 0 };
    }

    // 5. Dedup by fingerprint so an already-seen (e.g. rejected) rewrite is
    //    never re-surfaced.
    const promptKey =
      options.promptKey ?? personaInstructionsPromptKey(persona);
    const fingerprint = computeDirectiveFingerprint(
      persona.id,
      promptKey,
      draft.instructions,
    );
    const proposals = await this.proposalsCollection();
    const existing = await proposals.findByFingerprint(persona.id, fingerprint);
    if (existing.length > 0) {
      return { proposals: [], reinforced, skipped: 1 };
    }

    // 6. Record the pending proposal (rationale + evidence). It is inert until a
    //    permissioned human activates it.
    const proposal = await proposals.create({
      tenantId: persona.tenantId,
      personaId: persona.id,
      agentClass: persona.agentClass ?? '',
      promptKey,
      proposedInstructions: draft.instructions,
      currentInstructions,
      rationale: draft.rationale,
      status: 'pending',
      fingerprint,
      confidence: draft.confidence ?? meanConfidence(episodes),
      proposedBy: this._principal.id ?? 'reflection',
      evidence: JSON.stringify({
        episodeIds: episodes.map((e) => e.id),
        feedbackIds: feedback
          .map((f) => f.id)
          .filter((id): id is string => Boolean(id)),
      }),
    });

    return { proposals: [proposal], reinforced, skipped: 0 };
  }

  private async proposalsCollection(): Promise<DirectiveProposalCollection> {
    if (!this.proposalsCol) {
      this.proposalsCol = await DirectiveProposalCollection.create({
        db: this.db,
      });
    }
    return this.proposalsCol;
  }

  private async feedbackCollection(): Promise<FeedbackCollection> {
    if (!this.feedbackCol) {
      this.feedbackCol = await FeedbackCollection.create({ db: this.db });
    }
    return this.feedbackCol;
  }
}
