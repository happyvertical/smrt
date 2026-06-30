/**
 * AccessRequest model — the "request access / join the waitlist" identity
 * primitive.
 *
 * Captures a prospective user from a public form *before* they are a real
 * {@link User}: an operator triages the record, then either declines it or
 * approves and **graduates** it into a `User` (optionally attached to a
 * tenant). This keeps the `User` table clean — unverified/spam signups live as
 * requests, not users — while still giving operators a triage queue.
 *
 * The generated REST/MCP/CLI surface is intentionally CLOSED (`include: []`):
 * every read and mutation must go through {@link AccessRequestService} so the
 * public-safe creation path (email normalization + dedup), the lifecycle state
 * machine, capability gating, and event emission can never be bypassed by a
 * generated CRUD route. Creation is meant to be exposed *unauthenticated* by
 * consuming apps via their own rate-limited endpoint calling
 * `createAccessRequest`. The model is still registered (and its table created
 * via the consumer's normal migrate flow) regardless of the empty generation
 * config.
 *
 * @packageDocumentation
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { AccessRequestStatus } from '../types/index.js';
import { normalizeEmail } from './User.js';

/**
 * Options accepted by the {@link AccessRequest} constructor / collection
 * `create`. `requestContext` and `tenantHint` are stored as JSON *strings* —
 * use {@link AccessRequest.setRequestContext} / {@link AccessRequest.setTenantHint}
 * (or pass pre-serialized strings) rather than raw objects.
 */
export interface AccessRequestOptions {
  email?: string;
  name?: string | null;
  status?: AccessRequestStatus;
  source?: string;
  requestContext?: string;
  note?: string | null;
  requestedAt?: Date;
  decidedAt?: Date | null;
  decidedBy?: string | null;
  resultingUserId?: string | null;
  tenantHint?: string | null;
  [key: string]: unknown;
}

/**
 * A prospective user's request for access, captured before they become a
 * {@link User}.
 *
 * @example
 * ```typescript
 * // Public, unauthenticated path (app adds rate-limiting):
 * const request = await service.createAccessRequest({
 *   email: 'Jane@Example.com',
 *   name: 'Jane Doe',
 *   source: 'www',
 *   context: { company: 'Acme', intendedUse: 'evaluation' },
 * });
 * // request.email === 'jane@example.com', request.status === 'requested'
 * ```
 */
@smrt({
  tableName: 'access_requests',
  // Append-style: the natural key is the surrogate id, so a new request never
  // upserts over an existing row. Without this, SMRT defaults to upserting on
  // `slug`/`context`, and `slug` is derived from `name` — two public submissions
  // sharing a display name (e.g. two "Jane Doe"s with different emails) would
  // collide and overwrite each other. Open-request dedup is handled explicitly
  // by AccessRequestService.createAccessRequest, not by the storage conflict key.
  conflictColumns: ['id'],
  // CLOSED generated surface — all access flows through AccessRequestService.
  api: { include: [] },
  mcp: { include: [] },
  cli: { include: [] },
})
export class AccessRequest extends SmrtObject {
  /**
   * Requester's email address. Required, normalized to lowercase, and indexed
   * for lookup + open-request dedup. NOT unique: the same email may accumulate
   * multiple requests over time (e.g. an old GRADUATED record plus a new
   * REQUESTED one); dedup is enforced on *open* requests by the service.
   */
  @field({ required: true, indexed: true })
  email: string = '';

  /**
   * Requester's display name, if supplied on the form.
   */
  @field({ nullable: true })
  name: string | null = null;

  /**
   * Lifecycle status. Indexed so the operator triage queue can filter by status
   * efficiently.
   */
  @field({ type: 'text', indexed: true })
  status: AccessRequestStatus = AccessRequestStatus.REQUESTED;

  /**
   * Where the request came from, e.g. `www`, `sdk`. Indexed for per-source
   * filtering in the operator queue.
   */
  @field({ indexed: true })
  source: string = '';

  /**
   * Free-form JSON metadata captured with the request (intended use, company,
   * message, referrer, etc.), stored as a JSON string.
   *
   * NOT named `context`: {@link SmrtObject} reserves the `context` field for
   * slug scoping, so this mirrors smrt-chat's `sessionContext` convention. Use
   * {@link getRequestContext} / {@link setRequestContext} for typed access.
   */
  @field()
  requestContext: string = '{}';

  /**
   * Operator note / decision reason (set on approve / decline / cancel).
   */
  @field({ nullable: true })
  note: string | null = null;

  /**
   * When the request was submitted. Defaults to creation time.
   */
  @field()
  requestedAt: Date = new Date();

  /**
   * When an operator decided the request (approve / decline / cancel /
   * graduate). Null while still `REQUESTED`.
   */
  @field({ nullable: true })
  decidedAt: Date | null = null;

  /**
   * User id of the operator who decided the request. Null while still pending.
   */
  @field({ nullable: true })
  decidedBy: string | null = null;

  /**
   * Id of the `User` produced (or linked) when the request graduated. Null
   * until graduation.
   */
  @field({ nullable: true })
  resultingUserId: string | null = null;

  /**
   * Optional JSON hint about the org/tenant the requester wants, stored as a
   * JSON string (null when absent). Advisory only — the operator decides the
   * actual tenant at graduation time. Use {@link getTenantHint} /
   * {@link setTenantHint} for typed access.
   */
  @field({ nullable: true })
  tenantHint: string | null = null;

  constructor(options: AccessRequestOptions = {}) {
    super(options);
    if (options.email !== undefined) this.email = normalizeEmail(options.email);
    if (options.name !== undefined) this.name = options.name;
    if (options.status !== undefined) this.status = options.status;
    if (options.source !== undefined) this.source = options.source;
    if (options.requestContext !== undefined)
      this.requestContext = options.requestContext;
    if (options.note !== undefined) this.note = options.note;
    if (options.requestedAt !== undefined)
      this.requestedAt = options.requestedAt;
    if (options.decidedAt !== undefined) this.decidedAt = options.decidedAt;
    if (options.decidedBy !== undefined) this.decidedBy = options.decidedBy;
    if (options.resultingUserId !== undefined)
      this.resultingUserId = options.resultingUserId;
    if (options.tenantHint !== undefined) this.tenantHint = options.tenantHint;
  }

  /**
   * Parse {@link requestContext} into an object. Returns `{}` on missing or
   * malformed JSON (graceful — never throws).
   */
  getRequestContext(): Record<string, unknown> {
    try {
      const parsed = JSON.parse(this.requestContext);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /**
   * Serialize and store {@link requestContext} from an object.
   */
  setRequestContext(value: Record<string, unknown>): void {
    this.requestContext = JSON.stringify(value ?? {});
  }

  /**
   * Parse {@link tenantHint} into an object, or `null` when unset / malformed.
   */
  getTenantHint(): Record<string, unknown> | null {
    if (!this.tenantHint) return null;
    try {
      const parsed = JSON.parse(this.tenantHint);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Serialize and store {@link tenantHint} from an object (or clear with null).
   */
  setTenantHint(value: Record<string, unknown> | null): void {
    this.tenantHint = value ? JSON.stringify(value) : null;
  }

  /**
   * Whether the request is still open (awaiting a decision).
   */
  isOpen(): boolean {
    return this.status === AccessRequestStatus.REQUESTED;
  }

  /**
   * Whether the request has been approved (and not yet graduated).
   */
  isApproved(): boolean {
    return this.status === AccessRequestStatus.APPROVED;
  }

  /**
   * Whether the request reached a terminal state (declined, graduated, or
   * canceled) and can no longer transition.
   */
  isTerminal(): boolean {
    return (
      this.status === AccessRequestStatus.DECLINED ||
      this.status === AccessRequestStatus.GRADUATED ||
      this.status === AccessRequestStatus.CANCELED
    );
  }
}
