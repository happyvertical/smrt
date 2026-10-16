/**
 * Neutral participation boundary shared by record discussions and lightweight
 * reactions/votes. This package owns the generic policy/ban schema; hosts bind
 * only identity and entitlement facts through the authorizer.
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
  /** Trusted entitlement fact required by members_only policy. */
  member?: boolean;
  /** Immutable host-provided entitlement/roll evidence retained by the row. */
  snapshot?: Record<string, unknown>;
  /** Comments may enter the moderation queue without exposing host policy. */
  initialCommentStatus?: 'visible' | 'pending';
  reason?: string;
}

/**
 * The host supplies entitlement facts; the package's policy/ban/rate service
 * combines them with its tenant-scoped generic anti-abuse records.
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
