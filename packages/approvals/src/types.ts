/**
 * Public vocabulary of `@happyvertical/smrt-approvals`: statuses, event
 * types, principals, kind definitions, and the typed transition results.
 *
 * @packageDocumentation
 */

/** Every status an {@link ApprovalRequest} can hold. */
export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'changes_requested',
  'cancelled',
  'expired',
] as const;

/** Lifecycle status of an approval request. */
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Every event type the append-only ledger records. */
export const APPROVAL_EVENT_TYPES = [
  'created',
  'approved',
  'rejected',
  'changes_requested',
  'cancelled',
  'expired',
  'consumed',
] as const;

/** Type of an {@link ApprovalEvent} row. */
export type ApprovalEventType = (typeof APPROVAL_EVENT_TYPES)[number];

/** A decider's verdict. */
export type ApprovalDecision = 'approve' | 'reject' | 'request_changes';

/**
 * What kind of actor a principal is. Only `human` principals may decide;
 * `agent` (an autonomous principal: persona, assistant, worker) and
 * `service` (a job or integration) may request, consume, and expire.
 */
export type ApprovalPrincipalType = 'human' | 'agent' | 'service';

/** Every principal type, for validation. */
export const APPROVAL_PRINCIPAL_TYPES: readonly ApprovalPrincipalType[] = [
  'human',
  'agent',
  'service',
];

/**
 * An actor whose authority is a set of permission slugs resolved for ONE
 * tenant (the `principal.can(slug)` idiom shared with personas and support).
 * Build it from `PermissionResolver.resolvePermissions(userId, tenantId)` in
 * production; tests use {@link approvalPrincipalFromPermissions}.
 */
export interface ApprovalPrincipal {
  /** Stable actor id recorded on events (a user or profile id). */
  readonly id: string;
  /** The tenant the permissions were resolved for. Required. */
  readonly tenantId: string;
  /** Actor type. Only `human` may approve, reject, or request changes. */
  readonly type: ApprovalPrincipalType;
  /** Whether this actor holds the permission slug in {@link tenantId}. */
  can(slug: string): boolean;
}

/** Build an {@link ApprovalPrincipal} from an explicit set of granted slugs. */
export function approvalPrincipalFromPermissions(
  permissions: Iterable<string>,
  options: { id: string; tenantId: string; type: ApprovalPrincipalType },
): ApprovalPrincipal {
  const granted = new Set(permissions);
  return {
    id: options.id,
    tenantId: options.tenantId,
    type: options.type,
    can: (slug: string) => granted.has(slug),
  };
}

/** Package defaults a kind declares; tenant policy may only tighten them. */
export interface ApprovalKindDefaults {
  /** Distinct approvers needed. Integer, 1-25. Default 1. */
  requiredApprovals?: number;
  /** Lifetime of a request in milliseconds. Default seven days. */
  ttlMs?: number;
}

/** Input to {@link defineApprovalKind}. */
export interface ApprovalKindInput {
  /** Dotted, lower-case key, e.g. `social.post.publish`. Unique per process. */
  key: string;
  /** Qualified subject class, e.g. `@happyvertical/smrt-social:SocialPost`. */
  subject: string;
  /** Permission slug a principal must hold to decide a request of this kind. */
  permission: string;
  /** Package defaults. */
  defaults?: ApprovalKindDefaults;
}

/** A registered, normalized approval kind. */
export interface ApprovalKind {
  readonly key: string;
  readonly subject: string;
  readonly permission: string;
  readonly defaults: Readonly<Required<ApprovalKindDefaults>>;
}

/** The effective rules for one request: kind defaults tightened by policy. */
export interface EffectiveApprovalRules {
  requiredApprovals: number;
  ttlMs: number;
  /** Every slug a decider must hold (the kind's, plus policy additions). */
  requiredPermissions: string[];
}

/** Why a transition was refused. */
export type ApprovalRefusalReason =
  /** No request with that id in the principal's tenant (or malformed id). */
  | 'not_found'
  /** The principal's tenant does not match the active tenant context. */
  | 'tenant_mismatch'
  /** The request is not in a status this transition accepts. */
  | 'not_pending'
  /** The request's expiry has passed. */
  | 'expired'
  /** The requester tried to decide their own request. */
  | 'self_approval'
  /** A non-human principal tried to decide. */
  | 'not_human'
  /** The principal lacks a required permission. */
  | 'forbidden'
  /** This principal already recorded a decision on the request. */
  | 'already_decided'
  /** `consume` was called with a different subject revision hash. */
  | 'revision_mismatch'
  /** The request row says approved but its event ledger does not. */
  | 'unbacked_approval'
  /** The approval was already consumed. */
  | 'already_consumed'
  /** The request is not approved (consume) or not yet expired (expire). */
  | 'not_approved'
  | 'not_expired'
  /** A `requestKey` was reused for a different subject or revision. */
  | 'request_key_conflict'
  /** Concurrent transitions kept winning; retry later. */
  | 'contention';

/** Outcome of a transition. */
export type ApprovalTransitionOutcome =
  /** This call performed the transition. */
  | 'transitioned'
  /** The same request already existed (idempotent `requestKey` replay). */
  | 'already_applied'
  /** Fail-closed; see `refusal`. */
  | 'refused';

/** Result of every {@link ApprovalService} transition. */
export interface ApprovalTransitionResult<T = unknown> {
  outcome: ApprovalTransitionOutcome;
  /** The request re-read after commit; `null` when refused as not found. */
  request: T | null;
  /** Set exactly when `outcome` is `refused`. */
  refusal?: { reason: ApprovalRefusalReason; detail: string };
}

/** Typed error for invalid input (programming errors, not refusals). */
export class ApprovalError extends Error {
  /** Machine-readable code. */
  readonly code: ApprovalErrorCode;

  constructor(code: ApprovalErrorCode, message: string) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

/** Codes carried by {@link ApprovalError}. */
export type ApprovalErrorCode =
  | 'APPROVAL_INVALID'
  | 'APPROVAL_KIND_UNKNOWN'
  | 'APPROVAL_KIND_CONFLICT'
  | 'APPROVAL_POLICY_LOOSENS'
  | 'APPROVAL_FORBIDDEN'
  | 'APPROVAL_NO_TRANSACTION';
