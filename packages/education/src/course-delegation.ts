import {
  CourseAuthoringAuthorizationError,
  CourseAuthoringValidationError,
} from './course-authoring-contracts.js';

/** Longest accepted host delegation id and delegating-guardian user id. */
export const MAX_DELEGATION_FIELD_LENGTH = 200;

/** A validated delegated-agent claim: both members, never one without the other. */
export interface CourseDelegation {
  delegatingGuardianUserId: string;
  delegationId: string;
}

type DelegationClaim = {
  actorUserId?: unknown;
  delegatingGuardianUserId?: unknown;
  delegationId?: unknown;
};

const present = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

function bounded(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_DELEGATION_FIELD_LENGTH ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new CourseAuthoringValidationError(
      `Delegation ${label} must be 1-${MAX_DELEGATION_FIELD_LENGTH} printable characters`,
    );
  return value;
}

/**
 * Reads and validates the delegation members of a trusted actor. The delegation
 * id and delegating guardian are validated as a unit, and the guardian can never
 * be the acting agent. Returns null for an ordinary (non-delegated) actor.
 * Passing validation grants nothing: the host authorizer and the guardian's live
 * membership/relationship still decide.
 */
export function readDelegation(
  claim: DelegationClaim,
): CourseDelegation | null {
  const hasGuardian = present(claim.delegatingGuardianUserId);
  const hasId = present(claim.delegationId);
  if (!hasGuardian && !hasId) return null;
  if (hasGuardian !== hasId)
    throw new CourseAuthoringValidationError(
      'A delegation id requires a delegating guardian, and the reverse',
    );
  const delegatingGuardianUserId = bounded(
    claim.delegatingGuardianUserId,
    'guardian',
  );
  const delegationId = bounded(claim.delegationId, 'id');
  if (delegatingGuardianUserId === claim.actorUserId)
    throw new CourseAuthoringAuthorizationError();
  return { delegatingGuardianUserId, delegationId };
}

/** Delegation members to spread into an actor or authorizer request (empty if none). */
export function delegationActorFields(
  claim: DelegationClaim,
): Partial<CourseDelegation> {
  return readDelegation(claim) ?? {};
}

/** Delegation columns for a decision record; empty strings when not delegated. */
export function delegationRecordFields(
  claim: DelegationClaim,
): CourseDelegation {
  return (
    readDelegation(claim) ?? { delegatingGuardianUserId: '', delegationId: '' }
  );
}
