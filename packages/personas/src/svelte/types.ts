/**
 * Presentational types for the directive review-queue UI (#1889).
 *
 * Kept free of the `@smrt()` model classes so the Svelte bundle stays a thin
 * presentation layer — consumers map their {@link DirectiveProposal} rows to
 * {@link DirectiveProposalView} via {@link toDirectiveProposalView}.
 *
 * @module
 */

/** The proposal lifecycle statuses the queue renders. */
export type DirectiveReviewStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'superseded';

/** A plain, render-ready view of a directive proposal. */
export interface DirectiveProposalView {
  /** Proposal id. */
  id: string;
  /** Persona display name, if known. */
  personaName?: string;
  /** Canonical agent class the persona configures. */
  agentClass?: string;
  /** Lifecycle status. */
  status: DirectiveReviewStatus;
  /** Model-authored rationale for the change. */
  rationale: string;
  /** Current instructions (for the review diff). */
  currentInstructions: string;
  /** Proposed replacement instructions. */
  proposedInstructions: string;
  /** Aggregate confidence in `[0, 1]`, if known. */
  confidence?: number;
}

/** Map a proposal-shaped record onto a render-ready view. */
export function toDirectiveProposalView(proposal: {
  id?: string | null;
  status?: string;
  rationale?: string;
  currentInstructions?: string;
  proposedInstructions?: string;
  confidence?: number;
  agentClass?: string;
  personaName?: string;
}): DirectiveProposalView {
  return {
    id: proposal.id ?? '',
    personaName: proposal.personaName,
    agentClass: proposal.agentClass,
    status: (proposal.status as DirectiveReviewStatus) ?? 'pending',
    rationale: proposal.rationale ?? '',
    currentInstructions: proposal.currentInstructions ?? '',
    proposedInstructions: proposal.proposedInstructions ?? '',
    confidence: proposal.confidence,
  };
}

/** Badge variant for a proposal status (matches `@happyvertical/smrt-ui`). */
export function statusBadgeVariant(
  status: DirectiveReviewStatus,
): 'default' | 'success' | 'warning' | 'error' {
  switch (status) {
    case 'approved':
      return 'success';
    case 'rejected':
      return 'error';
    case 'pending':
      return 'warning';
    default:
      return 'default';
  }
}

/** Format a `[0, 1]` confidence as a rounded percentage string. */
export function confidencePercent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}
