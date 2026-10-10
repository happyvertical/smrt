/**
 * ApprovalService: the only write path for approval requests.
 *
 * Every transition is ONE guarded conditional `UPDATE ... WHERE id AND
 * tenant_id AND status AND version AND expiry ... RETURNING version` plus
 * one {@link ApprovalEvent} insert, in the same database transaction (the
 * `CliAuthRequestCollection.approvePendingRequest` and
 * `CommissionPayoutService.transitionPayoutForSource` shape):
 *
 * - The guarded UPDATE is the arbiter. Two concurrent transitions of one
 *   request both read version `v`; only one UPDATE can match `version = v`.
 *   The loser matches zero rows, writes nothing, and retries from a fresh
 *   read, where it sees the winner's state and is refused cleanly
 *   (`not_pending`, `already_decided`, `already_consumed`).
 * - PostgreSQL runs each transaction on its own pooled connection; the
 *   UPDATE's row lock serializes writers and READ COMMITTED re-evaluates the
 *   predicate after the winner commits. On embedded engines (SQLite,
 *   DuckDB) each transaction runs through core's embedded write queue
 *   (`withEmbeddedWriteTransaction`), which takes the queue before the
 *   connection lock and serializes writers per database; the predicate
 *   still decides.
 * - Every statement names the tenant explicitly and the work runs inside
 *   `withTenant(principal.tenantId)`, so tenancy interceptors and the raw
 *   predicate both pin the row; a cross-tenant id is `not_found`.
 * - Events are inserted through a collection bound to the transaction
 *   database (the tx-bound collection pattern), so a failed insert rolls
 *   the UPDATE back.
 *
 * @packageDocumentation
 */

import {
  appendChange,
  isEmbeddedDatabase,
  isUniqueViolationError,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import {
  getTenantId,
  isSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { ApprovalEventCollection } from './collections/ApprovalEventCollection.js';
import { ApprovalPolicyCollection } from './collections/ApprovalPolicyCollection.js';
import { ApprovalRequestCollection } from './collections/ApprovalRequestCollection.js';
import {
  type ApprovalPolicyRules,
  assertPolicyTightens,
  effectiveRules,
  isPermissionSlug,
  requireApprovalKind,
} from './kinds.js';
import type { ApprovalEvent } from './models/ApprovalEvent.js';
import type { ApprovalPolicy } from './models/ApprovalPolicy.js';
import type { ApprovalRequest } from './models/ApprovalRequest.js';
import {
  CANCEL_ANY_APPROVAL_PERMISSION,
  MANAGE_APPROVAL_POLICY_PERMISSION,
} from './permissions.js';
import {
  APPROVAL_PRINCIPAL_TYPES,
  type ApprovalDecision,
  ApprovalError,
  type ApprovalEventType,
  type ApprovalKind,
  type ApprovalPrincipal,
  type ApprovalRefusalReason,
  type ApprovalStatus,
  type ApprovalTransitionResult,
} from './types.js';
import { serviceWriteOption } from './write-capability.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest accepted id, key, or hash string. */
const MAX_TOKEN_LENGTH = 256;

/** Longest accepted reason or summary. */
const MAX_TEXT_LENGTH = 4000;

/** Attempts before a transition gives up as `contention`. */
const DEFAULT_MAX_ATTEMPTS = 8;

const REQUESTS_TABLE = 'approval_requests';

/** Adapter capabilities the service relies on. */
type TransactionCapableDatabase = DatabaseInterface & {
  transaction?: <T>(
    callback: (tx: DatabaseInterface) => Promise<T>,
  ) => Promise<T>;
};

/** What a transaction body reports across the commit boundary (ids only). */
type TxOutcome =
  | { kind: 'done'; outcome: 'transitioned' | 'already_applied'; id: string }
  | {
      kind: 'refused';
      reason: ApprovalRefusalReason;
      detail: string;
      id: string | null;
    }
  | { kind: 'retry' };

/** Options for {@link ApprovalService}. */
export interface ApprovalServiceOptions {
  /** The database every transition runs against. Must support transactions. */
  db: DatabaseInterface;
  /** Clock override for deterministic tests. */
  now?: () => Date;
  /** Attempts before a contended transition is refused. Default 8. */
  maxAttempts?: number;
}

/** Input for {@link ApprovalService.requestApproval}. */
export interface RequestApprovalInput {
  /** A kind registered with `defineApprovalKind` (or its key). */
  kind: ApprovalKind | string;
  /** The subject's id. */
  subjectId: string;
  /** Hash of the exact subject revision to approve. */
  subjectRevisionHash: string;
  /**
   * Idempotency key, unique per tenant. A replay with the same subject and
   * revision returns the existing request as `already_applied`; a replay with
   * different content is refused `request_key_conflict`. Default: random.
   */
  requestKey?: string;
  /** Short description shown to deciders. */
  summary?: string;
}

/** Input for {@link ApprovalService.decide}. */
export interface DecideInput {
  decision: ApprovalDecision;
  /** Required for `reject` and `request_changes`. */
  reason?: string;
}

/** Options for {@link ApprovalService.consume}. */
export interface ConsumeOptions {
  /**
   * Run inside the caller's open transaction (a `db.transaction()` callback
   * handle) so the consumer's own write commits or rolls back together with
   * the consumption. The caller owns the transaction. On embedded engines
   * (SQLite, DuckDB, libsql) the handle must come from
   * `withEmbeddedWriteTransaction(db, isEmbeddedDatabase(db), fn)` or
   * `SmrtObject.withTransaction()` so it holds core's embedded write queue;
   * a raw `db.transaction()` handle can deadlock against concurrent saves.
   */
  transaction?: DatabaseInterface;
}

/** Result type of every transition. */
export type ApprovalResult = ApprovalTransitionResult<ApprovalRequest>;

const DECISION_EVENT: Record<ApprovalDecision, ApprovalEventType> = {
  approve: 'approved',
  reject: 'rejected',
  request_changes: 'changes_requested',
};

function refusal(
  reason: ApprovalRefusalReason,
  detail: string,
  id: string | null = null,
): TxOutcome {
  return { kind: 'refused', reason, detail, id };
}

function isoNow(date: Date): string {
  return date.toISOString();
}

function assertToken(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > MAX_TOKEN_LENGTH) {
    throw new ApprovalError(
      'APPROVAL_INVALID',
      `${label} must be a non-empty string of at most ${MAX_TOKEN_LENGTH} characters.`,
    );
  }
  return text;
}

function assertText(value: unknown, label: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) {
    throw new ApprovalError(
      'APPROVAL_INVALID',
      `${label} must be a string of at most ${MAX_TEXT_LENGTH} characters.`,
    );
  }
  return value.trim();
}

/**
 * Refuse a malformed principal before any database work. A principal with
 * no tenant, an unknown type, or no `can` function is a programming error.
 */
function assertPrincipal(principal: ApprovalPrincipal): void {
  if (!principal || typeof principal.can !== 'function') {
    throw new ApprovalError(
      'APPROVAL_INVALID',
      'An approval principal must provide can(slug).',
    );
  }
  assertToken(principal.id, 'Approval principal id');
  if (
    typeof principal.tenantId !== 'string' ||
    !UUID_RE.test(principal.tenantId)
  ) {
    throw new ApprovalError(
      'APPROVAL_INVALID',
      'An approval principal must carry the UUID of the tenant its permissions were resolved for.',
    );
  }
  if (!APPROVAL_PRINCIPAL_TYPES.includes(principal.type)) {
    throw new ApprovalError(
      'APPROVAL_INVALID',
      `Approval principal type must be one of ${APPROVAL_PRINCIPAL_TYPES.join(', ')}.`,
    );
  }
}

/**
 * Distinct actors whose `approved` events count toward quorum: human
 * principals other than the requester (a forged or legacy event from an
 * agent, a service, or the requester never counts).
 */
function countedApprovers(
  approvals: readonly ApprovalEvent[],
  request: ApprovalRequest,
): Set<string> {
  return new Set(
    approvals
      .filter(
        (event) =>
          event.type === 'approved' &&
          event.actorType === 'human' &&
          event.actorId !== request.requestedBy,
      )
      .map((event) => event.actorId),
  );
}

function rowVersion(rows: unknown[] | undefined): number | null {
  const row = rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const version = Number(row.version);
  return Number.isSafeInteger(version) ? version : null;
}

/**
 * The decision gate. Construct it over the application's database; it binds
 * its own collections per call and per transaction.
 */
export class ApprovalService {
  private readonly db: TransactionCapableDatabase;
  private readonly clock: () => Date;
  private readonly maxAttempts: number;

  constructor(options: ApprovalServiceOptions) {
    if (!options?.db || typeof options.db.query !== 'function') {
      throw new ApprovalError(
        'APPROVAL_INVALID',
        'ApprovalService requires an initialized database.',
      );
    }
    if (
      typeof (options.db as TransactionCapableDatabase).transaction !==
      'function'
    ) {
      throw new ApprovalError(
        'APPROVAL_NO_TRANSACTION',
        'ApprovalService requires a database adapter with transaction support.',
      );
    }
    this.db = options.db as TransactionCapableDatabase;
    this.clock = options.now ?? (() => new Date());
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** One request in the principal's tenant, or `null`. */
  async getRequest(
    principal: ApprovalPrincipal,
    requestId: string,
  ): Promise<ApprovalRequest | null> {
    assertPrincipal(principal);
    if (!UUID_RE.test(String(requestId ?? ''))) return null;
    return await this.inTenant(principal, () =>
      this.loadRequest(this.db, principal.tenantId, requestId),
    );
  }

  /** A request's events in order, in the principal's tenant. */
  async listEvents(
    principal: ApprovalPrincipal,
    requestId: string,
  ): Promise<ApprovalEvent[]> {
    assertPrincipal(principal);
    if (!UUID_RE.test(String(requestId ?? ''))) return [];
    return await this.inTenant(principal, async () => {
      const events = await ApprovalEventCollection.create({ db: this.db });
      return await events.list({
        where: { tenantId: principal.tenantId, requestId },
        orderBy: 'sequence ASC',
        limit: 1000,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /**
   * Open a request for approval of one subject revision. Any principal type
   * may request. The quorum, expiry, and required permissions are fixed now
   * from the kind's defaults tightened by the tenant's policy.
   */
  async requestApproval(
    principal: ApprovalPrincipal,
    input: RequestApprovalInput,
  ): Promise<ApprovalResult> {
    assertPrincipal(principal);
    const kind = requireApprovalKind(
      typeof input.kind === 'string' ? input.kind : input.kind?.key,
    );
    const subjectId = assertToken(input.subjectId, 'subjectId');
    const subjectRevisionHash = assertToken(
      input.subjectRevisionHash,
      'subjectRevisionHash',
    );
    const requestKey =
      input.requestKey === undefined
        ? globalThis.crypto.randomUUID()
        : assertToken(input.requestKey, 'requestKey');
    const summary = assertText(input.summary, 'summary');
    const tenantId = principal.tenantId;

    const sameContent = (row: ApprovalRequest) =>
      row.kind === kind.key &&
      row.subjectType === kind.subject &&
      row.subjectId === subjectId &&
      row.subjectRevisionHash === subjectRevisionHash;

    if (this.contextMismatch(principal)) {
      return ApprovalService.mismatchResult();
    }
    return await this.inTenant(principal, async () => {
      let outcome: TxOutcome;
      try {
        outcome = await this.runTransaction(async (tx) => {
          const requests = await this.txCollection(
            ApprovalRequestCollection,
            tx,
          );
          const [existing] = await requests.list({
            where: { tenantId, requestKey },
            limit: 1,
          });
          if (existing) {
            return sameContent(existing)
              ? ({
                  kind: 'done',
                  outcome: 'already_applied',
                  id: String(existing.id),
                } as const)
              : refusal(
                  'request_key_conflict',
                  `requestKey '${requestKey}' already names a different request`,
                );
          }

          const policy = await this.loadPolicy(tx, tenantId, kind.key);
          const rules = effectiveRules(kind, policy);
          const now = this.clock();
          const request = await requests.create({
            tenantId,
            kind: kind.key,
            subjectType: kind.subject,
            subjectId,
            subjectRevisionHash,
            requestKey,
            requestedBy: principal.id,
            requestedByType: principal.type,
            summary,
            status: 'pending',
            requiredApprovals: rules.requiredApprovals,
            approvalCount: 0,
            requiredPermissions: JSON.stringify(rules.requiredPermissions),
            version: 1,
            expiresAt: new Date(now.getTime() + rules.ttlMs),
            // The only place a request insert is authorized.
            ...serviceWriteOption(),
          } as Parameters<ApprovalRequestCollection['create']>[0]);
          const id = String(request.id);
          await this.appendEvent(tx, {
            tenantId,
            requestId: id,
            type: 'created',
            principal,
            reason: summary,
            subjectRevisionHash,
            sequence: 1,
            now,
          });
          return { kind: 'done', outcome: 'transitioned', id } as const;
        });
      } catch (error) {
        // A concurrent request with the same key won the unique index.
        if (!isUniqueViolationError(error)) throw error;
        const requests = await ApprovalRequestCollection.create({
          db: this.db,
        });
        const [winner] = await requests.list({
          where: { tenantId, requestKey },
          limit: 1,
        });
        if (!winner) throw error;
        outcome = sameContent(winner)
          ? { kind: 'done', outcome: 'already_applied', id: String(winner.id) }
          : refusal(
              'request_key_conflict',
              `requestKey '${requestKey}' already names a different request`,
            );
      }
      return await this.toResult(principal.tenantId, outcome);
    });
  }

  /**
   * Record a decision. Only a `human` principal of the request's tenant who
   * is not the requester and holds every required permission may decide,
   * once, while the request is pending and unexpired. `approve` counts
   * toward the quorum of distinct approvers; `reject` and `request_changes`
   * end the request.
   */
  async decide(
    principal: ApprovalPrincipal,
    requestId: string,
    input: DecideInput,
  ): Promise<ApprovalResult> {
    assertPrincipal(principal);
    const eventType = DECISION_EVENT[input?.decision];
    if (!eventType) {
      throw new ApprovalError(
        'APPROVAL_INVALID',
        `Unknown decision '${String(input?.decision)}'.`,
      );
    }
    const reason = assertText(input.reason, 'reason');
    if (input.decision !== 'approve' && !reason) {
      throw new ApprovalError(
        'APPROVAL_INVALID',
        `A '${input.decision}' decision requires a reason.`,
      );
    }
    const tenantId = principal.tenantId;

    return await this.transition(
      principal,
      requestId,
      async (tx, request, now) => {
        if (principal.type !== 'human') {
          return refusal(
            'not_human',
            `a ${principal.type} principal cannot decide`,
            request.id,
          );
        }
        if (principal.id === request.requestedBy) {
          return refusal(
            'self_approval',
            'the requester cannot decide their own request',
            request.id,
          );
        }
        const missing = (await this.requiredPermissionsFor(tx, request)).filter(
          (slug) => !principal.can(slug),
        );
        if (missing.length > 0) {
          return refusal(
            'forbidden',
            `missing permission: ${missing.join(', ')}`,
            request.id,
          );
        }
        if (request.status !== 'pending') {
          return refusal(
            'not_pending',
            `request is ${request.status}`,
            request.id,
          );
        }
        if (!(request.expiresAtMs() > now.getTime())) {
          return refusal('expired', 'the request expired', request.id);
        }

        const events = await this.txCollection(ApprovalEventCollection, tx);
        const decided = await events.list({
          where: { tenantId, requestId: request.id, voteKey: principal.id },
          limit: 1,
        });
        if (decided.length > 0) {
          return refusal(
            'already_decided',
            'this principal already decided',
            request.id,
          );
        }

        const version = Number(request.version);
        const nowIso = isoNow(now);
        let updated: { rows?: unknown[] };
        if (input.decision === 'approve') {
          // Quorum counts distinct approvers from the ledger, not a counter.
          const approvals = await events.list({
            where: { tenantId, requestId: request.id, type: 'approved' },
            limit: 1000,
          });
          const voters = countedApprovers(approvals, request);
          voters.add(principal.id);
          const count = voters.size;
          const reached = count >= Number(request.requiredApprovals);
          updated = await tx.query(
            `UPDATE ${REQUESTS_TABLE}
              SET approval_count = ?, status = ?, decided_at = ${reached ? '?' : 'decided_at'},
                  version = version + 1, updated_at = ?
            WHERE id = ? AND tenant_id = ? AND status = 'pending'
              AND version = ? AND expires_at > ?
        RETURNING version`,
            ...[
              count,
              reached ? 'approved' : 'pending',
              ...(reached ? [nowIso] : []),
              nowIso,
              request.id,
              tenantId,
              version,
              nowIso,
            ],
          );
        } else {
          const status: ApprovalStatus =
            input.decision === 'reject' ? 'rejected' : 'changes_requested';
          updated = await tx.query(
            `UPDATE ${REQUESTS_TABLE}
              SET status = ?, decided_at = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND tenant_id = ? AND status = 'pending'
              AND version = ? AND expires_at > ?
        RETURNING version`,
            status,
            nowIso,
            nowIso,
            request.id,
            tenantId,
            version,
            nowIso,
          );
        }
        const next = rowVersion(updated.rows);
        if (next === null) return { kind: 'retry' };

        await this.appendEvent(tx, {
          tenantId,
          requestId: String(request.id),
          type: eventType,
          principal,
          reason,
          subjectRevisionHash: request.subjectRevisionHash,
          sequence: next,
          voteKey: principal.id,
          now,
        });
        await this.recordChange(tx, String(request.id), tenantId);
        return {
          kind: 'done',
          outcome: 'transitioned',
          id: String(request.id),
        };
      },
    );
  }

  /**
   * Cancel a pending request. The requester may cancel their own request;
   * anyone else needs `approvals.cancel-any`.
   */
  async cancel(
    principal: ApprovalPrincipal,
    requestId: string,
    input: { reason?: string } = {},
  ): Promise<ApprovalResult> {
    assertPrincipal(principal);
    const reason = assertText(input.reason, 'reason');
    const tenantId = principal.tenantId;
    return await this.transition(
      principal,
      requestId,
      async (tx, request, now) => {
        if (
          principal.id !== request.requestedBy &&
          !principal.can(CANCEL_ANY_APPROVAL_PERMISSION)
        ) {
          return refusal(
            'forbidden',
            `only the requester or a holder of ${CANCEL_ANY_APPROVAL_PERMISSION} may cancel`,
            request.id,
          );
        }
        if (request.status !== 'pending') {
          return refusal(
            'not_pending',
            `request is ${request.status}`,
            request.id,
          );
        }
        if (!(request.expiresAtMs() > now.getTime())) {
          return refusal('expired', 'the request expired', request.id);
        }
        const nowIso = isoNow(now);
        const updated = await tx.query(
          `UPDATE ${REQUESTS_TABLE}
            SET status = 'cancelled', decided_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND status = 'pending'
            AND version = ? AND expires_at > ?
      RETURNING version`,
          nowIso,
          nowIso,
          request.id,
          tenantId,
          Number(request.version),
          nowIso,
        );
        const next = rowVersion(updated.rows);
        if (next === null) return { kind: 'retry' };
        await this.appendEvent(tx, {
          tenantId,
          requestId: String(request.id),
          type: 'cancelled',
          principal,
          reason,
          subjectRevisionHash: request.subjectRevisionHash,
          sequence: next,
          now,
        });
        await this.recordChange(tx, String(request.id), tenantId);
        return {
          kind: 'done',
          outcome: 'transitioned',
          id: String(request.id),
        };
      },
    );
  }

  /**
   * Mark one request expired: a pending request, or an approved one that
   * was never consumed, whose expiry has passed. Needs no permission (it
   * only records what time already decided), so a job may call it.
   */
  async expire(
    principal: ApprovalPrincipal,
    requestId: string,
  ): Promise<ApprovalResult> {
    assertPrincipal(principal);
    const tenantId = principal.tenantId;
    return await this.transition(
      principal,
      requestId,
      async (tx, request, now) => {
        if (
          !(
            request.status === 'pending' ||
            (request.status === 'approved' && !request.isConsumed())
          )
        ) {
          return refusal(
            'not_pending',
            request.status === 'approved'
              ? 'the approval was consumed'
              : `request is ${request.status}`,
            request.id,
          );
        }
        if (request.expiresAtMs() > now.getTime()) {
          return refusal(
            'not_expired',
            'the request has not expired',
            request.id,
          );
        }
        const nowIso = isoNow(now);
        const updated = await tx.query(
          `UPDATE ${REQUESTS_TABLE}
            SET status = 'expired', decided_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND status IN ('pending', 'approved')
            AND consumed_at IS NULL AND version = ? AND expires_at <= ?
      RETURNING version`,
          nowIso,
          nowIso,
          request.id,
          tenantId,
          Number(request.version),
          nowIso,
        );
        const next = rowVersion(updated.rows);
        if (next === null) return { kind: 'retry' };
        await this.appendEvent(tx, {
          tenantId,
          requestId: String(request.id),
          type: 'expired',
          principal,
          reason: '',
          subjectRevisionHash: request.subjectRevisionHash,
          sequence: next,
          now,
        });
        await this.recordChange(tx, String(request.id), tenantId);
        return {
          kind: 'done',
          outcome: 'transitioned',
          id: String(request.id),
        };
      },
    );
  }

  /**
   * Expire every due request in the principal's tenant: pending requests
   * and unconsumed approvals past their deadline, oldest expiry first, at
   * most `limit`. Returns the ids this call expired.
   */
  async expireDue(
    principal: ApprovalPrincipal,
    options: { limit?: number } = {},
  ): Promise<string[]> {
    assertPrincipal(principal);
    const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 100)), 1000);
    const now = this.clock();
    const candidates = await this.inTenant(principal, async () => {
      const requests = await ApprovalRequestCollection.create({ db: this.db });
      return await requests.list({
        where: {
          tenantId: principal.tenantId,
          status: ['pending', 'approved'],
          // Exclude consumed approvals in the query, before the limit: they
          // never expire, so filtering them afterwards let a batch of them
          // starve every later due request.
          consumedAt: null,
          'expiresAt <=': now,
        },
        orderBy: 'expires_at ASC',
        limit,
      });
    });
    const expired: string[] = [];
    for (const candidate of candidates) {
      const result = await this.expire(principal, String(candidate.id));
      if (result.outcome === 'transitioned') expired.push(String(candidate.id));
    }
    return expired;
  }

  /**
   * Consume an approval exactly once. The presented hash must equal the
   * revision that was approved; the request must be approved, unconsumed,
   * and unexpired. Any principal type of the tenant may consume (the
   * consumer's own service is the executor). Pass `options.transaction` to
   * make the consumption part of the consumer's own transaction.
   */
  async consume(
    principal: ApprovalPrincipal,
    requestId: string,
    subjectRevisionHash: string,
    options: ConsumeOptions = {},
  ): Promise<ApprovalResult> {
    assertPrincipal(principal);
    const hash = assertToken(subjectRevisionHash, 'subjectRevisionHash');
    const tenantId = principal.tenantId;
    return await this.transition(
      principal,
      requestId,
      async (tx, request, now) => {
        if (request.status !== 'approved') {
          return refusal(
            'not_approved',
            `request is ${request.status}`,
            request.id,
          );
        }
        if (request.isConsumed()) {
          return refusal(
            'already_consumed',
            'the approval was already used',
            request.id,
          );
        }
        if (request.subjectRevisionHash !== hash) {
          return refusal(
            'revision_mismatch',
            'the subject changed after it was approved',
            request.id,
          );
        }
        if (!(request.expiresAtMs() > now.getTime())) {
          return refusal('expired', 'the approval expired', request.id);
        }
        if (!(await this.ledgerBacksApproval(tx, request))) {
          return refusal(
            'unbacked_approval',
            'the ledger does not record this approval',
            request.id,
          );
        }
        const nowIso = isoNow(now);
        const updated = await tx.query(
          `UPDATE ${REQUESTS_TABLE}
              SET consumed_at = ?, consumed_by = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND tenant_id = ? AND status = 'approved'
              AND consumed_at IS NULL AND subject_revision_hash = ?
              AND version = ? AND expires_at > ?
        RETURNING version`,
          nowIso,
          principal.id,
          nowIso,
          request.id,
          tenantId,
          hash,
          Number(request.version),
          nowIso,
        );
        const next = rowVersion(updated.rows);
        if (next === null) return { kind: 'retry' };
        await this.appendEvent(tx, {
          tenantId,
          requestId: String(request.id),
          type: 'consumed',
          principal,
          reason: '',
          subjectRevisionHash: hash,
          sequence: next,
          now,
        });
        await this.recordChange(tx, String(request.id), tenantId);
        return {
          kind: 'done',
          outcome: 'transitioned',
          id: String(request.id),
        };
      },
      options.transaction,
    );
  }

  // -------------------------------------------------------------------------
  // Policy
  // -------------------------------------------------------------------------

  /**
   * Write the tenant's tightening of a kind. Needs
   * `approvals.manage-policy`; a rule that would loosen the kind's defaults
   * throws `APPROVAL_POLICY_LOOSENS`. `0`/`''` clear a rule back to the
   * default. Applies to requests made afterwards.
   */
  async setPolicy(
    principal: ApprovalPrincipal,
    kindKey: ApprovalKind | string,
    rules: ApprovalPolicyRules,
  ): Promise<ApprovalPolicy> {
    assertPrincipal(principal);
    if (
      principal.type !== 'human' ||
      !principal.can(MANAGE_APPROVAL_POLICY_PERMISSION)
    ) {
      throw new ApprovalError(
        'APPROVAL_FORBIDDEN',
        `Setting approval policy needs a human principal holding ${MANAGE_APPROVAL_POLICY_PERMISSION}.`,
      );
    }
    const kind = requireApprovalKind(
      typeof kindKey === 'string' ? kindKey : kindKey?.key,
    );
    const normalized = {
      requiredApprovals: rules.requiredApprovals ?? 0,
      ttlMs: rules.ttlMs ?? 0,
      requiredPermission: String(rules.requiredPermission ?? '').trim(),
    };
    if (
      normalized.requiredPermission &&
      !isPermissionSlug(normalized.requiredPermission)
    ) {
      throw new ApprovalError(
        'APPROVAL_INVALID',
        `requiredPermission must be a permission slug, got '${normalized.requiredPermission}'.`,
      );
    }
    assertPolicyTightens(kind, normalized);
    const tenantId = principal.tenantId;
    return await this.inTenant(principal, async () => {
      const id = await this.runTransaction(async (tx) => {
        const policies = await this.txCollection(ApprovalPolicyCollection, tx);
        const [existing] = await policies.list({
          where: { tenantId, kind: kind.key },
          limit: 1,
        });
        if (existing) {
          existing.requiredApprovals = normalized.requiredApprovals;
          existing.ttlMs = normalized.ttlMs;
          existing.requiredPermission = normalized.requiredPermission;
          existing.updatedBy = principal.id;
          await existing.save();
          return String(existing.id);
        }
        const created = await policies.create({
          tenantId,
          kind: kind.key,
          ...normalized,
          updatedBy: principal.id,
        });
        return String(created.id);
      });
      const policies = await ApprovalPolicyCollection.create({ db: this.db });
      const [saved] = await policies.list({
        where: { tenantId, id },
        limit: 1,
      });
      if (!saved) {
        throw new ApprovalError(
          'APPROVAL_INVALID',
          'Saved approval policy vanished.',
        );
      }
      return saved;
    });
  }

  /** The effective rules a new request of `kind` would get in the tenant. */
  async rulesFor(principal: ApprovalPrincipal, kindKey: ApprovalKind | string) {
    assertPrincipal(principal);
    const kind = requireApprovalKind(
      typeof kindKey === 'string' ? kindKey : kindKey?.key,
    );
    return await this.inTenant(principal, async () =>
      effectiveRules(
        kind,
        await this.loadPolicy(this.db, principal.tenantId, kind.key),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Run a guarded transition with retry. `body` runs inside a transaction
   * on a fresh read of the request and returns `retry` when its guarded
   * UPDATE matched no row (a concurrent transition won).
   */
  private async transition(
    principal: ApprovalPrincipal,
    requestId: string,
    body: (
      tx: DatabaseInterface,
      request: ApprovalRequest,
      now: Date,
    ) => Promise<TxOutcome>,
    callerTransaction?: DatabaseInterface,
  ): Promise<ApprovalResult> {
    if (!UUID_RE.test(String(requestId ?? ''))) {
      return {
        outcome: 'refused',
        request: null,
        refusal: { reason: 'not_found', detail: 'not a request id' },
      };
    }
    if (this.contextMismatch(principal)) {
      return ApprovalService.mismatchResult();
    }
    const tenantId = principal.tenantId;
    return await this.inTenant(principal, async () => {
      const attempt = async (tx: DatabaseInterface): Promise<TxOutcome> => {
        const request = await this.loadRequest(tx, tenantId, requestId);
        if (!request) {
          return refusal('not_found', 'no such request in this tenant');
        }
        return await body(tx, request, this.clock());
      };

      if (callerTransaction) {
        // The caller owns the transaction: one attempt, no retry (a lost
        // race inside someone else's transaction is reported, not retried).
        const outcome = await attempt(callerTransaction);
        if (outcome.kind === 'retry') {
          return await this.toResult(
            tenantId,
            refusal('contention', 'a concurrent transition won', requestId),
            callerTransaction,
          );
        }
        return await this.toResult(tenantId, outcome, callerTransaction);
      }

      for (let i = 0; i < this.maxAttempts; i++) {
        let outcome: TxOutcome;
        try {
          outcome = await this.runTransaction(attempt);
        } catch (error) {
          // A unique ledger key lost to a concurrent writer: re-read and retry.
          if (isUniqueViolationError(error)) continue;
          throw error;
        }
        if (outcome.kind !== 'retry') {
          return await this.toResult(tenantId, outcome);
        }
      }
      return await this.toResult(
        tenantId,
        refusal('contention', 'concurrent transitions kept winning', requestId),
      );
    });
  }

  /** True when an active tenant context names a different tenant. */
  private contextMismatch(principal: ApprovalPrincipal): boolean {
    const active = getTenantId();
    return (
      !isSystemContext() &&
      active !== undefined &&
      active !== principal.tenantId
    );
  }

  /** The refusal returned when {@link contextMismatch} holds. */
  private static mismatchResult(): ApprovalResult {
    return {
      outcome: 'refused',
      request: null,
      refusal: {
        reason: 'tenant_mismatch',
        detail:
          "the principal's tenant does not match the active tenant context",
      },
    };
  }

  /** Pin the work to the principal's tenant; refuse a conflicting context. */
  private async inTenant<T>(
    principal: ApprovalPrincipal,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.contextMismatch(principal)) {
      throw new ApprovalError(
        'APPROVAL_FORBIDDEN',
        `The principal's tenant does not match the active tenant context.`,
      );
    }
    return await withTenant({ tenantId: principal.tenantId }, fn);
  }

  /**
   * Run `fn` in a transaction through core's embedded write queue.
   *
   * On embedded engines (SQLite, DuckDB, libsql) the transaction takes the
   * queue for its database BEFORE the adapter's connection lock, and the
   * model writes inside it (event inserts, change-feed appends) re-enter that
   * hold. Taking the connection lock first deadlocks against an unrelated
   * save that holds the queue and then opens its own write transaction, and
   * lets other root writes land inside this BEGIN..COMMIT. The queue also
   * serializes these transactions per database in-process, which is what
   * the former per-handle promise chain did, so that chain is gone.
   * PostgreSQL is not queued: each transaction has its own pooled
   * connection and the guarded UPDATE's row lock arbitrates.
   */
  private async runTransaction<T>(
    fn: (tx: DatabaseInterface) => Promise<T>,
  ): Promise<T> {
    return await withEmbeddedWriteTransaction(
      this.db,
      isEmbeddedDatabase(this.db),
      fn,
    );
  }

  /** A collection bound to a transaction database. */
  private async txCollection<C>(
    Collection: { create(options: Record<string, unknown>): Promise<C> },
    tx: DatabaseInterface,
  ): Promise<C> {
    return await Collection.create({
      db: tx,
      _reuseInitializedDb: true,
      _deferRuntimeInitialization: true,
    });
  }

  private async loadRequest(
    db: DatabaseInterface,
    tenantId: string,
    requestId: string,
  ): Promise<ApprovalRequest | null> {
    const requests =
      db === this.db
        ? await ApprovalRequestCollection.create({ db })
        : await this.txCollection(ApprovalRequestCollection, db);
    const [request] = await requests.list({
      where: { tenantId, id: requestId },
      limit: 1,
    });
    // Belt and braces: never act on a row from another tenant.
    return request && request.tenantId === tenantId ? request : null;
  }

  private async loadPolicy(
    db: DatabaseInterface,
    tenantId: string,
    kind: string,
  ): Promise<ApprovalPolicy | null> {
    const policies =
      db === this.db
        ? await ApprovalPolicyCollection.create({ db })
        : await this.txCollection(ApprovalPolicyCollection, db);
    const [policy] = await policies.list({
      where: { tenantId, kind },
      limit: 1,
    });
    return policy ?? null;
  }

  /**
   * Every slug a decider must hold now: the slugs fixed at request time
   * plus the kind's and the tenant policy's current ones (tightening only:
   * a later policy can add a slug, never remove one).
   */
  private async requiredPermissionsFor(
    tx: DatabaseInterface,
    request: ApprovalRequest,
  ): Promise<string[]> {
    const kind = requireApprovalKind(request.kind);
    const current = effectiveRules(
      kind,
      await this.loadPolicy(tx, request.tenantId, kind.key),
    );
    const slugs = new Set(request.getRequiredPermissions());
    for (const slug of current.requiredPermissions) slugs.add(slug);
    return [...slugs];
  }

  private async appendEvent(
    tx: DatabaseInterface,
    input: {
      tenantId: string;
      requestId: string;
      type: ApprovalEventType;
      principal: ApprovalPrincipal;
      reason: string;
      subjectRevisionHash: string;
      sequence: number;
      voteKey?: string;
      now: Date;
    },
  ): Promise<void> {
    const events = await this.txCollection(ApprovalEventCollection, tx);
    await events.create({
      tenantId: input.tenantId,
      requestId: input.requestId,
      type: input.type,
      actorId: input.principal.id,
      actorType: input.principal.type,
      reason: input.reason,
      subjectRevisionHash: input.subjectRevisionHash,
      sequence: input.sequence,
      voteKey: input.voteKey ?? null,
      occurredAt: input.now,
      // The only place an event insert is authorized.
      ...serviceWriteOption(),
    } as Parameters<ApprovalEventCollection['create']>[0]);
  }

  /**
   * Defence in depth for `consume`: the request row says `approved`, so the
   * ledger must agree. It needs the `created` event at sequence 1, no
   * terminal event, and approvals from at least `requiredApprovals` distinct
   * human actors other than the requester. Catches a status written around
   * the service (raw SQL); model-layer inserts are already capability-gated.
   */
  private async ledgerBacksApproval(
    tx: DatabaseInterface,
    request: ApprovalRequest,
  ): Promise<boolean> {
    const events = await this.txCollection(ApprovalEventCollection, tx);
    const ledger = await events.list({
      where: { tenantId: request.tenantId, requestId: request.id },
      limit: 1000,
    });
    const created = ledger.some(
      (event) => event.type === 'created' && Number(event.sequence) === 1,
    );
    const terminal = ledger.some((event) =>
      [
        'rejected',
        'changes_requested',
        'cancelled',
        'expired',
        'consumed',
      ].includes(event.type),
    );
    const approvers = countedApprovers(
      ledger.filter((event) => event.type === 'approved'),
      request,
    );
    return (
      created &&
      !terminal &&
      approvers.size >= Math.max(1, Number(request.requiredApprovals))
    );
  }

  /**
   * The guarded UPDATE bypasses save hooks, so record the change-feed entry
   * the save path would have written. Best effort, like the save path.
   */
  private async recordChange(
    tx: DatabaseInterface,
    requestId: string,
    tenantId: string,
  ): Promise<void> {
    try {
      await appendChange(tx, {
        table: REQUESTS_TABLE,
        rowId: requestId,
        operation: 'update',
        tenantId,
      });
    } catch {
      // The transition committed its own write; a missing feed entry is
      // recovered by a full resync, exactly as for a failed save append.
    }
  }

  /** Re-read the request after commit (ids only cross the boundary). */
  private async toResult(
    tenantId: string,
    outcome: TxOutcome,
    db: DatabaseInterface = this.db,
  ): Promise<ApprovalResult> {
    if (outcome.kind === 'retry') {
      throw new Error('ApprovalService: unresolved retry outcome');
    }
    const id = outcome.id;
    const request = id ? await this.loadRequest(db, tenantId, id) : null;
    if (outcome.kind === 'refused') {
      return {
        outcome: 'refused',
        request: outcome.reason === 'not_found' ? null : request,
        refusal: { reason: outcome.reason, detail: outcome.detail },
      };
    }
    return { outcome: outcome.outcome, request };
  }
}
