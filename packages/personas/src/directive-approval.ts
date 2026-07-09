/**
 * DirectiveApprovalService — the human-in-the-loop gate (#1889).
 *
 * The review queue's write side. A reviewer who holds the
 * `personas.activate-directive` permission can **approve** (optionally editing
 * the text), or **reject**, a pending {@link DirectiveProposal}:
 *
 *   - **approve** activates the persona-scoped `prompt_override` (through
 *     `PromptOverride.save()`, so a non-editable prompt template is refused by
 *     `validatePromptOverride`) and records an `accept` signal.
 *   - **reject** records a `reject` signal and closes the proposal so the
 *     reflection runner never re-surfaces the same rewrite (it dedups on
 *     fingerprint against non-pending proposals too).
 *
 * The gate is purely the permission check: an actor lacking the slug — the
 * autonomous reflection principal included — is denied before anything is
 * written. Confidence-only reinforcement is unaffected; it never passes here.
 *
 * @module
 */

import type { PromptOverride } from '@happyvertical/smrt-prompts';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  ACTIVATE_DIRECTIVE_PERMISSION,
  type DirectivePrincipal,
} from './directive-principal.js';
import {
  DirectiveProposal,
  DirectiveProposalCollection,
} from './directive-proposal.js';
import { type Feedback, FeedbackCollection } from './feedback.js';
import { upsertPromptTemplateOverride } from './persona-prompt.js';

/** Raised when a principal without the activation permission attempts to review. */
export class DirectiveActivationDeniedError extends Error {
  constructor(
    message = `Principal lacks the '${ACTIVATE_DIRECTIVE_PERMISSION}' permission required to review persona directives`,
  ) {
    super(message);
    this.name = 'DirectiveActivationDeniedError';
  }
}

/** Raised when a review is attempted on a proposal that is not pending. */
export class DirectiveNotPendingError extends Error {
  constructor(status: string) {
    super(`Directive proposal is not pending (status: ${status})`);
    this.name = 'DirectiveNotPendingError';
  }
}

/** Options for {@link DirectiveApprovalService}. */
export interface DirectiveApprovalServiceOptions {
  db: DatabaseInterface;
  proposals?: DirectiveProposalCollection;
  feedback?: FeedbackCollection;
}

/** Result of approving a proposal. */
export interface DirectiveApprovalResult {
  proposal: DirectiveProposal;
  /** The activated persona-scoped override. */
  override: PromptOverride;
  /** The recorded `accept` signal. */
  signal: Feedback;
}

/** Result of rejecting a proposal. */
export interface DirectiveRejectionResult {
  proposal: DirectiveProposal;
  /** The recorded `reject` signal. */
  signal: Feedback;
}

/** A proposal reference: the row, or its id. */
export type ProposalRef = DirectiveProposal | string;

/**
 * The permission-gated review surface for persona directives.
 */
export class DirectiveApprovalService {
  private readonly db: DatabaseInterface;
  private proposals?: DirectiveProposalCollection;
  private feedback?: FeedbackCollection;

  constructor(options: DirectiveApprovalServiceOptions) {
    this.db = options.db;
    this.proposals = options.proposals;
    this.feedback = options.feedback;
  }

  /**
   * Assert a principal is authorised to review directives. The single gate:
   * everything privileged in this service calls it first.
   *
   * @throws {DirectiveActivationDeniedError} when the principal lacks the slug.
   */
  assertCanActivate(principal: DirectivePrincipal): void {
    if (!principal.can(ACTIVATE_DIRECTIVE_PERMISSION)) {
      throw new DirectiveActivationDeniedError();
    }
  }

  /**
   * Approve a pending proposal: activate the persona-scoped override and record
   * an `accept` signal. Pass `editedInstructions` to activate a revised text
   * (the proposal keeps the model's original as its audit record; the override
   * holds what was activated).
   *
   * @throws {DirectiveActivationDeniedError} when the principal lacks the slug.
   * @throws {DirectiveNotPendingError} when the proposal is already reviewed.
   */
  async approve(
    ref: ProposalRef,
    principal: DirectivePrincipal,
    options: { note?: string; editedInstructions?: string } = {},
  ): Promise<DirectiveApprovalResult> {
    this.assertCanActivate(principal);
    const proposal = await this.loadPending(ref);

    const template =
      options.editedInstructions ?? proposal.proposedInstructions;

    // Activation is exactly writing the persona-scoped override. This flows
    // through PromptOverride.save() → validatePromptOverride, so a non-editable
    // template is refused here (the error propagates to the reviewer).
    const override = await upsertPromptTemplateOverride({
      db: this.db,
      key: proposal.promptKey,
      tenantId: proposal.tenantId,
      template,
    });

    proposal.status = 'approved';
    proposal.reviewedBy = principal.id ?? null;
    proposal.reviewedAt = new Date();
    proposal.reviewNote = options.note ?? null;
    proposal.activatedOverrideId = override.id ?? null;
    await proposal.save();

    const signal = await this.recordSignal(proposal, 'accept', principal, {
      note: options.note,
      edited: options.editedInstructions !== undefined,
    });

    return { proposal, override, signal };
  }

  /**
   * Reject a pending proposal: record a `reject` signal and close it so it is
   * never re-surfaced.
   *
   * @throws {DirectiveActivationDeniedError} when the principal lacks the slug.
   * @throws {DirectiveNotPendingError} when the proposal is already reviewed.
   */
  async reject(
    ref: ProposalRef,
    principal: DirectivePrincipal,
    options: { note?: string } = {},
  ): Promise<DirectiveRejectionResult> {
    this.assertCanActivate(principal);
    const proposal = await this.loadPending(ref);

    proposal.status = 'rejected';
    proposal.reviewedBy = principal.id ?? null;
    proposal.reviewedAt = new Date();
    proposal.reviewNote = options.note ?? null;
    await proposal.save();

    const signal = await this.recordSignal(proposal, 'reject', principal, {
      note: options.note,
    });

    return { proposal, signal };
  }

  private async loadPending(ref: ProposalRef): Promise<DirectiveProposal> {
    const proposal =
      ref instanceof DirectiveProposal ? ref : await this.getProposal(ref);
    if (!proposal) {
      throw new Error(`Directive proposal not found: ${String(ref)}`);
    }
    if (proposal.status !== 'pending') {
      throw new DirectiveNotPendingError(proposal.status);
    }
    return proposal;
  }

  private async getProposal(id: string): Promise<DirectiveProposal | null> {
    const proposals = await this.proposalsCollection();
    return proposals.get({ id });
  }

  private async recordSignal(
    proposal: DirectiveProposal,
    signalType: 'accept' | 'reject',
    principal: DirectivePrincipal,
    options: { note?: string; edited?: boolean } = {},
  ): Promise<Feedback> {
    const feedback = await this.feedbackCollection();
    return feedback.create({
      tenantId: proposal.tenantId,
      personaId: proposal.personaId,
      agentClass: proposal.agentClass,
      memoryScope: '',
      scope: 'persona/directive',
      key: proposal.id ?? '',
      signalType,
      source: 'human',
      // The correlation-id ties the signal back to the reviewed proposal.
      correlationId: proposal.id ?? '',
      correlationType: 'directive_proposal',
      actorId: principal.id ?? null,
      comment: options.note ?? null,
      metadata: JSON.stringify({ edited: options.edited ?? false }),
    });
  }

  private async proposalsCollection(): Promise<DirectiveProposalCollection> {
    if (!this.proposals) {
      this.proposals = await DirectiveProposalCollection.create({
        db: this.db,
      });
    }
    return this.proposals;
  }

  private async feedbackCollection(): Promise<FeedbackCollection> {
    if (!this.feedback) {
      this.feedback = await FeedbackCollection.create({ db: this.db });
    }
    return this.feedback;
  }
}
