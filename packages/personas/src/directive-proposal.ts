/**
 * DirectiveProposal — a pending, human-reviewable edit to a persona's
 * instructions (#1889).
 *
 * The autonomous {@link ReflectionRunner} consolidates recent episodes and
 * {@link Feedback} into candidate rewrites of a persona's instructions and
 * records each as a pending `DirectiveProposal` (rationale + evidence). A
 * proposal is inert data: it changes nothing until a human who holds the
 * `personas.activate-directive` permission approves it through the review
 * queue, at which point the persona-scoped `prompt_override` is written.
 *
 * The reflection principal deliberately lacks that permission, so it can only
 * *propose* — the permission split is the gate. See {@link DirectiveApprovalService}.
 *
 * @module
 */

import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/**
 * Lifecycle status of a proposal:
 *
 * - `pending` — awaiting review; surfaced in the queue.
 * - `approved` — a reviewer activated it; the override was written.
 * - `rejected` — a reviewer declined it; recorded as a signal and never
 *   re-surfaced (the runner dedups against it by fingerprint).
 * - `superseded` — a newer proposal replaced it before review.
 */
export type DirectiveProposalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'superseded';

/**
 * Structured evidence backing a proposal — the ids of the learning episodes and
 * feedback signals the reflection consolidated. Pure references so the proposal
 * stays auditable without duplicating payloads.
 */
export interface DirectiveEvidence {
  /** `_smrt_contexts` row ids of the episodes considered. */
  episodeIds?: string[];
  /** {@link Feedback} row ids considered. */
  feedbackIds?: string[];
  /** Free-form supporting notes (e.g. counts, aggregate metrics). */
  notes?: string[];
  [key: string]: unknown;
}

/**
 * A stable content fingerprint for `(personaId, promptKey, proposedInstructions)`.
 *
 * Used to dedup proposals so an already-reviewed rewrite — in particular a
 * rejected one — is never re-surfaced. Pure FNV-1a so it needs no crypto import
 * and stays identical across Node and browser bundles.
 */
export function computeDirectiveFingerprint(
  personaId: string,
  promptKey: string,
  proposedInstructions: string,
): string {
  const input = `${personaId} ${promptKey} ${proposedInstructions}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // FNV prime multiply, kept in 32-bit unsigned space.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function parseEvidence(raw: unknown): DirectiveEvidence {
  if (typeof raw !== 'string' || raw.length === 0) {
    return raw && typeof raw === 'object' ? (raw as DirectiveEvidence) : {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as DirectiveEvidence)
      : {};
  } catch {
    return {};
  }
}

/**
 * A pending, human-reviewable proposed edit to a persona's instructions.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'directive_proposals',
  // Read-only generated surface: activation/rejection go through the
  // permission-gated DirectiveApprovalService, not generated CRUD writes.
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class DirectiveProposal extends SmrtObject {
  /** Owning tenant (required — proposals always target a tenant's persona). */
  @tenantId()
  tenantId: string = '';

  /** The persona whose instructions this proposal would rewrite. */
  @foreignKey('AgentPersona', { required: true })
  personaId: string = '';

  /** Canonical agent class the persona configures (denormalised for queries). */
  @field({ type: 'text' })
  agentClass: string = '';

  /**
   * The registered prompt key whose template the persona's instructions map to.
   * Activation writes/updates the tenant-scoped override for this key.
   */
  @field({ type: 'text' })
  promptKey: string = '';

  /** The proposed replacement instructions (the new prompt template). */
  @field({ type: 'text' })
  proposedInstructions: string = '';

  /** Snapshot of the instructions at proposal time (for a review diff). */
  @field({ type: 'text' })
  currentInstructions: string = '';

  /** Model-authored explanation for the proposed change. */
  @field({ type: 'text' })
  rationale: string = '';

  /** Structured evidence, stored as a JSON string (see {@link getEvidence}). */
  @field({ type: 'text' })
  evidence: string = '{}';

  /** Lifecycle status. */
  @field({ type: 'text' })
  status: DirectiveProposalStatus = 'pending';

  /**
   * Content fingerprint for dedup / not-re-surfacing. Set from
   * {@link computeDirectiveFingerprint} at creation time.
   */
  @field({ type: 'text' })
  fingerprint: string = '';

  /** Aggregate confidence in the proposal, in `[0, 1]`. */
  confidence: number = 0.0;

  /** Id of the principal (autonomous reflection actor) that proposed it. */
  @field({ type: 'text' })
  proposedBy: string = '';

  /** The reviewer (user id) that approved/rejected it, once reviewed. */
  @field({ type: 'text', nullable: true })
  reviewedBy: string | null = null;

  /** When the proposal was reviewed. */
  @field({ type: 'datetime', nullable: true })
  reviewedAt: Date | null = null;

  /** Reviewer note attached on approve/reject. */
  @field({ type: 'text', nullable: true })
  reviewNote: string | null = null;

  /** The `prompt_override` id written on activation (`null` until approved). */
  @field({ type: 'text', nullable: true })
  activatedOverrideId: string | null = null;

  /** Parse {@link evidence}, tolerating malformed JSON. */
  getEvidence(): DirectiveEvidence {
    return parseEvidence(this.evidence);
  }

  /** Replace {@link evidence}. */
  setEvidence(value: DirectiveEvidence): void {
    this.evidence = JSON.stringify(value ?? {});
  }

  /** Whether the proposal is still awaiting review. */
  isPending(): boolean {
    return this.status === 'pending';
  }
}

/**
 * Collection for {@link DirectiveProposal} rows — the review queue.
 */
export class DirectiveProposalCollection extends SmrtCollection<DirectiveProposal> {
  static readonly _itemClass = DirectiveProposal;

  /**
   * The review queue: pending proposals, oldest first. Optionally scoped to a
   * persona.
   */
  async pending(
    options: { personaId?: string; limit?: number } = {},
  ): Promise<DirectiveProposal[]> {
    const where: Record<string, unknown> = { status: 'pending' };
    if (options.personaId) {
      where.personaId = options.personaId;
    }
    return this.list({
      where,
      orderBy: 'created_at ASC',
      limit: options.limit,
    });
  }

  /**
   * Existing proposals for a persona carrying a given fingerprint, in any
   * status — used to avoid re-surfacing an already-seen (e.g. rejected) rewrite.
   */
  async findByFingerprint(
    personaId: string,
    fingerprint: string,
  ): Promise<DirectiveProposal[]> {
    return this.list({ where: { personaId, fingerprint } });
  }
}

export default DirectiveProposal;
