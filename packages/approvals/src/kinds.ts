/**
 * The approval-kind registry and tighten-only policy arithmetic.
 *
 * A package opts in with {@link defineApprovalKind}: the kind's defaults are
 * the loosest rules any tenant can run. A tenant {@link ApprovalPolicy} row
 * may raise the quorum, shorten the expiry, or add a required permission,
 * never the reverse; {@link assertPolicyTightens} refuses a loosening write
 * and {@link effectiveRules} clamps any stored row to the defaults, so a row
 * written around the service still cannot loosen a kind.
 *
 * @packageDocumentation
 */

import {
  ApprovalError,
  type ApprovalKind,
  type ApprovalKindInput,
  type EffectiveApprovalRules,
} from './types.js';

/** Upper bound on quorum: a gate, not a ballot. */
export const MAX_REQUIRED_APPROVALS = 25;

/** Default lifetime of a request: seven days. */
export const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Longest lifetime a kind may declare: one year. */
export const MAX_APPROVAL_TTL_MS = 366 * 24 * 60 * 60 * 1000;

/** Shortest lifetime anything may set: one minute. */
export const MIN_APPROVAL_TTL_MS = 60 * 1000;

const KIND_KEY = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const QUALIFIED_CLASS =
  /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:[A-Za-z_$][\w$]*$/;
const PERMISSION_SLUG = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/;

const kinds = new Map<string, ApprovalKind>();

/** True for a well-formed permission slug such as `social.approve-post`. */
export function isPermissionSlug(value: unknown): value is string {
  return typeof value === 'string' && PERMISSION_SLUG.test(value);
}

function assertQuorum(value: number, label: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_REQUIRED_APPROVALS
  ) {
    throw new ApprovalError(
      'APPROVAL_INVALID',
      `${label} must be an integer from 1 to ${MAX_REQUIRED_APPROVALS}, got ${String(value)}.`,
    );
  }
}

function assertTtl(value: number, label: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_APPROVAL_TTL_MS ||
    value > MAX_APPROVAL_TTL_MS
  ) {
    throw new ApprovalError(
      'APPROVAL_INVALID',
      `${label} must be an integer number of milliseconds from ${MIN_APPROVAL_TTL_MS} to ${MAX_APPROVAL_TTL_MS}, got ${String(value)}.`,
    );
  }
}

/**
 * Register an approval kind. Calling it again with an identical definition
 * returns the registered kind (module re-evaluation is harmless); a
 * different definition under the same key throws.
 *
 * @throws {ApprovalError} `APPROVAL_INVALID` or `APPROVAL_KIND_CONFLICT`.
 */
export function defineApprovalKind(input: ApprovalKindInput): ApprovalKind {
  if (!KIND_KEY.test(input.key ?? '')) {
    throw new ApprovalError(
      'APPROVAL_INVALID',
      `Approval kind key must be dotted lower case such as 'social.post.publish', got '${String(input.key)}'.`,
    );
  }
  if (!QUALIFIED_CLASS.test(input.subject ?? '')) {
    throw new ApprovalError(
      'APPROVAL_INVALID',
      `Approval kind '${input.key}' subject must be a qualified class name such as '@happyvertical/smrt-social:SocialPost', got '${String(input.subject)}'.`,
    );
  }
  if (!isPermissionSlug(input.permission)) {
    throw new ApprovalError(
      'APPROVAL_INVALID',
      `Approval kind '${input.key}' permission must be a slug such as 'social.approve-post', got '${String(input.permission)}'.`,
    );
  }
  const requiredApprovals = input.defaults?.requiredApprovals ?? 1;
  const ttlMs = input.defaults?.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
  assertQuorum(
    requiredApprovals,
    `Approval kind '${input.key}' requiredApprovals`,
  );
  assertTtl(ttlMs, `Approval kind '${input.key}' ttlMs`);

  const kind: ApprovalKind = Object.freeze({
    key: input.key,
    subject: input.subject,
    permission: input.permission,
    defaults: Object.freeze({ requiredApprovals, ttlMs }),
  });
  const existing = kinds.get(kind.key);
  if (existing) {
    if (
      existing.subject === kind.subject &&
      existing.permission === kind.permission &&
      existing.defaults.requiredApprovals === requiredApprovals &&
      existing.defaults.ttlMs === ttlMs
    ) {
      return existing;
    }
    throw new ApprovalError(
      'APPROVAL_KIND_CONFLICT',
      `Approval kind '${kind.key}' is already defined with different rules.`,
    );
  }
  kinds.set(kind.key, kind);
  return kind;
}

/** The registered kind for `key`, or `undefined`. */
export function getApprovalKind(key: string): ApprovalKind | undefined {
  return kinds.get(key);
}

/** Every registered kind, sorted by key. */
export function listApprovalKinds(): ApprovalKind[] {
  return [...kinds.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** The registered kind for `key`; throws when it is unknown. */
export function requireApprovalKind(key: string): ApprovalKind {
  const kind = kinds.get(key);
  if (!kind) {
    throw new ApprovalError(
      'APPROVAL_KIND_UNKNOWN',
      `Approval kind '${key}' is not defined in this process. Import the package that calls defineApprovalKind() for it.`,
    );
  }
  return kind;
}

/** Remove a kind (test helper). */
export function unregisterApprovalKind(key: string): boolean {
  return kinds.delete(key);
}

/** The tightening a tenant policy row may carry. `0`/`''` mean "inherit". */
export interface ApprovalPolicyRules {
  requiredApprovals?: number;
  ttlMs?: number;
  requiredPermission?: string;
}

/**
 * Refuse a policy that would loosen `kind`: a quorum below the default, an
 * expiry above the default, or a malformed permission slug.
 *
 * @throws {ApprovalError} `APPROVAL_POLICY_LOOSENS` or `APPROVAL_INVALID`.
 */
export function assertPolicyTightens(
  kind: ApprovalKind,
  rules: ApprovalPolicyRules,
): void {
  const quorum = rules.requiredApprovals ?? 0;
  if (quorum !== 0) {
    assertQuorum(quorum, `Approval policy for '${kind.key}' requiredApprovals`);
    if (quorum < kind.defaults.requiredApprovals) {
      throw new ApprovalError(
        'APPROVAL_POLICY_LOOSENS',
        `Approval policy for '${kind.key}' may only raise requiredApprovals (default ${kind.defaults.requiredApprovals}), got ${quorum}.`,
      );
    }
  }
  const ttl = rules.ttlMs ?? 0;
  if (ttl !== 0) {
    assertTtl(ttl, `Approval policy for '${kind.key}' ttlMs`);
    if (ttl > kind.defaults.ttlMs) {
      throw new ApprovalError(
        'APPROVAL_POLICY_LOOSENS',
        `Approval policy for '${kind.key}' may only shorten ttlMs (default ${kind.defaults.ttlMs}), got ${ttl}.`,
      );
    }
  }
  const permission = rules.requiredPermission ?? '';
  if (permission !== '' && !isPermissionSlug(permission)) {
    throw new ApprovalError(
      'APPROVAL_INVALID',
      `Approval policy for '${kind.key}' requiredPermission must be a permission slug, got '${permission}'.`,
    );
  }
}

/**
 * The rules a request runs under: the kind's defaults tightened by `policy`.
 * Clamps rather than trusts the row, so a stored row that would loosen the
 * kind (written around the service, or left over after a package raised its
 * defaults) is ignored for the loosening part; a malformed permission slug
 * fails closed by staying in the required set (no principal holds it).
 */
export function effectiveRules(
  kind: ApprovalKind,
  policy?: ApprovalPolicyRules | null,
): EffectiveApprovalRules {
  const policyQuorum = Number(policy?.requiredApprovals ?? 0);
  const policyTtl = Number(policy?.ttlMs ?? 0);
  const requiredApprovals =
    Number.isSafeInteger(policyQuorum) && policyQuorum > 0
      ? Math.min(
          Math.max(kind.defaults.requiredApprovals, policyQuorum),
          MAX_REQUIRED_APPROVALS,
        )
      : kind.defaults.requiredApprovals;
  const ttlMs =
    Number.isSafeInteger(policyTtl) && policyTtl > 0
      ? Math.max(Math.min(kind.defaults.ttlMs, policyTtl), MIN_APPROVAL_TTL_MS)
      : kind.defaults.ttlMs;
  const requiredPermissions = [kind.permission];
  const extra = String(policy?.requiredPermission ?? '').trim();
  if (extra && !requiredPermissions.includes(extra)) {
    requiredPermissions.push(extra);
  }
  return { requiredApprovals, ttlMs, requiredPermissions };
}
