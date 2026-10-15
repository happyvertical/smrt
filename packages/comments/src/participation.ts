/**
 * Neutral participation boundary shared by record discussions and lightweight
 * reactions/votes. Hosts bind identity, subscription entitlement, moderation
 * bans, and their atomic rate-limit store here; this package never imports
 * those product concerns.
 */
export type ParticipationAction = 'comment' | 'react' | 'vote';

export interface ParticipationTarget {
  tenantId: string;
  recordType: string;
  recordId: string;
}

export interface ParticipationRequest extends ParticipationTarget {
  actorUserId: string;
  action: ParticipationAction;
}

export interface ParticipationDecision {
  allowed: boolean;
  /** Immutable host-provided entitlement/roll evidence retained by the row. */
  snapshot?: Record<string, unknown>;
  /** Comments may enter the moderation queue without exposing host policy. */
  initialCommentStatus?: 'visible' | 'pending';
  reason?: string;
}

/**
 * The host must make this decision before mutation. Its implementation owns
 * tenant bans and an atomic rate-limit reservation as well as entitlement.
 */
export interface ParticipationAuthorizer {
  authorize(request: ParticipationRequest): Promise<ParticipationDecision>;
}

export class ParticipationDeniedError extends Error {
  constructor(readonly reason?: string) {
    super(reason ? `Participation denied: ${reason}` : 'Participation denied.');
    this.name = 'ParticipationDeniedError';
  }
}
