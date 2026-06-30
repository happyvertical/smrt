/**
 * AccessRequestService — the mechanism behind the "request access / waitlist"
 * identity primitive, plus graduation of an approved request into a `User`.
 *
 * ## Responsibilities
 *
 * - **Public-safe creation** ({@link AccessRequestService.createAccessRequest}):
 *   validates + normalizes the email and de-duplicates against any open request
 *   for the same email. Intended to be called *unauthenticated* by consuming
 *   apps from their own rate-limited endpoint (the app owns rate-limiting).
 * - **Operator triage** (`list` / `get` / `approve` / `decline` / `cancel`):
 *   gated behind capabilities (see {@link AccessRequestAuthorizer}).
 * - **Graduation** ({@link AccessRequestService.graduateAccessRequest}): creates
 *   or links a `User` from the request — reusing the existing user / membership
 *   / tenant collections rather than duplicating them — and (optionally)
 *   attaches the user to a brand-new tenant (requester as owner), an existing
 *   tenant, or no tenant at all. Idempotent.
 * - **Events** ({@link AccessRequestEventHandler}): emits
 *   `access-request.created | approved | declined | canceled | graduated` so
 *   apps can react (send a magic-link/invite on `graduated`, notify ops on
 *   `created`, …). This service deliberately does **not** own email/notification
 *   delivery — bridge the event hook to your delivery channel (a function, an
 *   `EventEmitter`, the core `DispatchBus`, …).
 *
 * @remarks
 * **Security.** Operator methods are gated only when an {@link AccessRequestAuthorizer}
 * is supplied via {@link AccessRequestServiceOptions.authorize}; without one
 * they are ungated, exactly like {@link TerminalAuthService.approveRequest}
 * trusts its caller to authenticate first. Production apps that expose these
 * methods MUST either provide an `authorize` hook or perform their own
 * capability checks at the route layer. `createAccessRequest` is *always*
 * ungated by design (public-safe). The model's generated REST/MCP/CLI surface
 * is closed, so there is no unauthenticated network route by default.
 *
 * @packageDocumentation
 */

import { createLogger } from '@happyvertical/logger';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { AccessRequestCollection } from '../collections/AccessRequestCollection.js';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import type { AccessRequest } from '../models/AccessRequest.js';
import type { Membership } from '../models/Membership.js';
import type { Tenant } from '../models/Tenant.js';
import type { User } from '../models/User.js';
import { isValidEmail, normalizeEmail } from '../models/User.js';
import {
  AccessRequestStatus,
  DEFAULT_ROLE_SLUGS,
  MembershipStatus,
  type TenantStatus,
  UserStatus,
} from '../types/index.js';

const logger = createLogger({ level: 'info' });

/**
 * Capabilities that gate the operator-facing methods of
 * {@link AccessRequestService}.
 */
export const ACCESS_REQUEST_CAPABILITIES = {
  /** Read the access-request queue (`list` / `get`). */
  READ: 'access-requests:read',
  /** Decide requests (`approve` / `decline` / `cancel` / `graduate`). */
  MANAGE: 'access-requests:manage',
} as const;

/**
 * One of the capability slugs in {@link ACCESS_REQUEST_CAPABILITIES}.
 */
export type AccessRequestCapability =
  (typeof ACCESS_REQUEST_CAPABILITIES)[keyof typeof ACCESS_REQUEST_CAPABILITIES];

/**
 * Context passed to an {@link AccessRequestAuthorizer} before an operator method
 * runs.
 */
export interface AccessRequestAuthorizationContext {
  /** The capability the operation requires. */
  capability: AccessRequestCapability;
  /** The operator user id supplied to the method (`by`), if any. */
  by?: string | null;
  /** The target access-request id, when the operation targets a specific row. */
  accessRequestId?: string;
}

/**
 * Hook that authorizes an operator action. Throw (or reject) to deny — the
 * thrown error propagates to the caller unchanged. Resolve/return to allow.
 *
 * Wire this to your permission system, e.g. resolve the operator's permissions
 * and assert the required capability:
 *
 * ```typescript
 * const service = await AccessRequestService.create({
 *   db,
 *   authorize: async ({ capability, by }) => {
 *     if (!by || !(await isPlatformOperator(by, capability))) {
 *       throw new Error(`Missing capability: ${capability}`);
 *     }
 *   },
 * });
 * ```
 */
export type AccessRequestAuthorizer = (
  context: AccessRequestAuthorizationContext,
) => void | Promise<void>;

/**
 * Lifecycle event types emitted by {@link AccessRequestService}.
 */
export type AccessRequestEventType =
  | 'access-request.created'
  | 'access-request.approved'
  | 'access-request.declined'
  | 'access-request.canceled'
  | 'access-request.graduated';

/**
 * Payload delivered to an {@link AccessRequestEventHandler}.
 */
export interface AccessRequestEvent {
  /** Which lifecycle transition fired. */
  type: AccessRequestEventType;
  /** The access request after the transition. */
  accessRequest: AccessRequest;
  /** When the event was emitted. */
  at: Date;
  /** Operator user id responsible, for operator-driven transitions. */
  by?: string | null;
  /** Graduated user (only on `access-request.graduated`). */
  user?: User;
  /** Membership created/linked on graduation, when a tenant was attached. */
  membership?: Membership;
  /** Tenant created/linked on graduation, when a tenant was attached. */
  tenant?: Tenant;
}

/**
 * Event hook apps provide to react to access-request lifecycle changes.
 * Delivery is best-effort: a throwing handler is logged and swallowed so it
 * never rolls back an already-persisted transition. Do not rely on it for
 * critical-path work that must share the request's transaction.
 */
export type AccessRequestEventHandler = (
  event: AccessRequestEvent,
) => void | Promise<void>;

/**
 * Options for {@link AccessRequestService}.
 */
export interface AccessRequestServiceOptions extends SmrtClassOptions {
  /** Optional capability gate for operator methods (see {@link AccessRequestAuthorizer}). */
  authorize?: AccessRequestAuthorizer;
  /** Optional lifecycle event hook (see {@link AccessRequestEventHandler}). */
  onEvent?: AccessRequestEventHandler;
}

/**
 * Input for {@link AccessRequestService.createAccessRequest}. Only `email` is
 * required.
 */
export interface CreateAccessRequestInput {
  /** Requester email (validated + normalized to lowercase). */
  email: string;
  /** Requester display name. */
  name?: string | null;
  /** Where the request came from, e.g. `www`, `sdk`. */
  source?: string;
  /** Free-form metadata (intended use, company, message, referrer, …). */
  context?: Record<string, unknown>;
  /** Optional requested org/tenant hint (advisory). */
  tenantHint?: Record<string, unknown> | null;
  /** Optional initial note. */
  note?: string | null;
}

/**
 * Filter for {@link AccessRequestService.listAccessRequests}.
 */
export interface ListAccessRequestsFilter {
  /** Restrict to one status or any of several. */
  status?: AccessRequestStatus | AccessRequestStatus[];
  /** Restrict to a single (normalized) email. */
  email?: string;
  /** Restrict to a single source. */
  source?: string;
  /** Operator user id, forwarded to the authorizer as `by`. */
  by?: string | null;
  /** Max rows to return. */
  limit?: number;
  /** Rows to skip. */
  offset?: number;
  /** Order-by clause (defaults to `created_at DESC`). */
  orderBy?: string;
}

/**
 * Options shared by the operator decision methods.
 */
export interface DecideAccessRequestOptions {
  /** Operator user id recorded as `decidedBy` and forwarded to the authorizer. */
  by?: string | null;
}

/**
 * Options for {@link AccessRequestService.approveAccessRequest}.
 */
export interface ApproveAccessRequestOptions
  extends DecideAccessRequestOptions {
  /** Operator note stored on the request. */
  note?: string | null;
}

/**
 * Options for {@link AccessRequestService.declineAccessRequest}.
 */
export interface DeclineAccessRequestOptions
  extends DecideAccessRequestOptions {
  /** Decision reason stored as the request's note. */
  reason?: string | null;
}

/**
 * Options for {@link AccessRequestService.cancelAccessRequest}.
 */
export interface CancelAccessRequestOptions extends DecideAccessRequestOptions {
  /** Cancellation reason stored as the request's note. */
  reason?: string | null;
}

/**
 * Graduate into a **new** tenant, enrolling the requester (owner by default).
 */
export interface GraduateNewTenantOption {
  /** New tenant attributes — `name` is required. */
  create: {
    name: string;
    slug?: string;
    description?: string;
    status?: TenantStatus;
  };
  /** Role slug for the requester's membership (default `owner`). */
  role?: string;
}

/**
 * Graduate into an **existing** tenant, enrolling the requester.
 */
export interface GraduateExistingTenantOption {
  /** Target tenant id. */
  tenantId: string;
  /** Role slug for the requester's membership (default `member`). */
  role?: string;
}

/**
 * Tenant handling at graduation: create a new tenant, attach to an existing
 * one, or `'none'` (user only, no membership).
 */
export type GraduateTenantOption =
  | GraduateNewTenantOption
  | GraduateExistingTenantOption
  | 'none';

/**
 * Options for {@link AccessRequestService.graduateAccessRequest}.
 */
export interface GraduateAccessRequestOptions
  extends DecideAccessRequestOptions {
  /** Tenant handling (default `'none'`). */
  tenant?: GraduateTenantOption;
  /** Status applied to the user produced/linked by graduation (default `ACTIVE`). */
  activate?: UserStatus;
  /**
   * Convenience: allow graduating directly from `REQUESTED` (skipping the
   * `APPROVED` step). Defaults to `false`.
   */
  allowFromRequested?: boolean;
  /** Operator note stored on the request. */
  note?: string | null;
}

/**
 * Result of {@link AccessRequestService.graduateAccessRequest}.
 */
export interface GraduateAccessRequestResult {
  /** The graduated (created or linked) user. */
  user: User;
  /** The membership, when a tenant was attached. */
  membership?: Membership;
  /** The tenant, when one was created or attached. */
  tenant?: Tenant;
  /** The access request, now `GRADUATED`. */
  accessRequest: AccessRequest;
  /** Whether a brand-new user was created (`false` when an existing one was linked). */
  created: boolean;
}

/**
 * Error codes raised by {@link AccessRequestError}.
 */
export type AccessRequestErrorCode =
  | 'INVALID_EMAIL'
  | 'NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'TENANT_NOT_FOUND'
  | 'ROLE_NOT_FOUND';

/**
 * Error thrown for access-request domain failures the caller is expected to
 * surface (invalid email, unknown id, illegal state transition, …). Authorizer
 * denials are not wrapped — those propagate from the supplied authorizer
 * unchanged.
 */
export class AccessRequestError extends Error {
  readonly code: AccessRequestErrorCode;

  constructor(message: string, code: AccessRequestErrorCode) {
    super(message);
    this.name = 'AccessRequestError';
    this.code = code;
  }
}

/**
 * Source statuses each transition may legally start from. Idempotent no-ops
 * (e.g. approving an already-`APPROVED` request) are handled separately, before
 * these guards run.
 */
const APPROVE_FROM: AccessRequestStatus[] = [AccessRequestStatus.REQUESTED];
const DECLINE_FROM: AccessRequestStatus[] = [
  AccessRequestStatus.REQUESTED,
  AccessRequestStatus.APPROVED,
];
const CANCEL_FROM: AccessRequestStatus[] = [
  AccessRequestStatus.REQUESTED,
  AccessRequestStatus.APPROVED,
];

/**
 * High-level orchestration for the access-request lifecycle and graduation.
 */
export class AccessRequestService {
  readonly #options: AccessRequestServiceOptions;
  readonly #authorize?: AccessRequestAuthorizer;
  readonly #onEvent?: AccessRequestEventHandler;

  #requests!: AccessRequestCollection;
  #users!: UserCollection;
  #tenants!: TenantCollection;
  #memberships!: MembershipCollection;
  #roles!: RoleCollection;
  #rolesSeeded = false;

  constructor(options: AccessRequestServiceOptions) {
    this.#options = options;
    this.#authorize = options.authorize;
    this.#onEvent = options.onEvent;
  }

  /**
   * Initialize the backing collections (creates/verifies their tables).
   */
  async initialize(): Promise<void> {
    // SmrtClassOptions carries `authorize`/`onEvent` too; the collection factory
    // only reads the db/ai keys and ignores the rest, so passing the whole
    // options bag is harmless and keeps the db config in one place.
    this.#requests = await AccessRequestCollection.create(this.#options);
    this.#users = await UserCollection.create(this.#options);
    this.#tenants = await TenantCollection.create(this.#options);
    this.#memberships = await MembershipCollection.create(this.#options);
    this.#roles = await RoleCollection.create(this.#options);
  }

  /**
   * Static factory — construct and initialize in one call.
   */
  static async create(
    options: AccessRequestServiceOptions,
  ): Promise<AccessRequestService> {
    const service = new AccessRequestService(options);
    await service.initialize();
    return service;
  }

  /**
   * The underlying collection, for advanced read scenarios. Prefer the service
   * methods, which apply normalization, the state machine, capability gating,
   * and events.
   */
  get collection(): AccessRequestCollection {
    return this.#requests;
  }

  // ============= Public-safe creation =============

  /**
   * Create an access request. **Public-safe**: no capability check — meant to be
   * callable unauthenticated by apps (which add their own rate-limiting).
   *
   * Validates and normalizes the email, then de-duplicates: if an open
   * (`REQUESTED`) request already exists for the email, this merges any newly
   * supplied context/name/source/hint into it and returns it instead of
   * creating a duplicate (no second `created` event).
   *
   * @remarks
   * De-duplication is **best-effort, not atomic**: it is a read-then-write
   * (`findOpenByEmail` → `create`) with no DB-level partial-unique constraint
   * (the table is append-style, keyed on `id`, because the same email may
   * accumulate many requests over its lifetime). Two requests for the same
   * email racing concurrently can therefore both create an open row. This is by
   * design — the spec makes dedup configurable and pushes abuse control to the
   * app (rate-limiting on the public endpoint). Operators triaging two open rows
   * for one email is benign; apps needing a hard single-open-request guarantee
   * should add a partial unique index (`UNIQUE(email) WHERE status='requested'`)
   * in their migration.
   *
   * @throws {@link AccessRequestError} (`INVALID_EMAIL`) when the email is invalid.
   */
  async createAccessRequest(
    input: CreateAccessRequestInput,
  ): Promise<AccessRequest> {
    const email = normalizeEmail(input.email);
    if (!isValidEmail(email)) {
      throw new AccessRequestError(
        'A valid email address is required to request access.',
        'INVALID_EMAIL',
      );
    }

    // Dedup against an existing open request for this email (idempotent).
    const existing = await this.#requests.findOpenByEmail(email);
    if (existing) {
      let changed = false;
      if (input.context && Object.keys(input.context).length > 0) {
        existing.setRequestContext({
          ...existing.getRequestContext(),
          ...input.context,
        });
        changed = true;
      }
      if (input.tenantHint) {
        existing.setTenantHint({
          ...(existing.getTenantHint() ?? {}),
          ...input.tenantHint,
        });
        changed = true;
      }
      if (input.name && !existing.name) {
        existing.name = input.name;
        changed = true;
      }
      if (input.source && !existing.source) {
        existing.source = input.source;
        changed = true;
      }
      if (changed) await existing.save();
      return existing;
    }

    const request = await this.#requests.create({
      email,
      name: input.name ?? null,
      source: input.source ?? '',
      status: AccessRequestStatus.REQUESTED,
      requestedAt: new Date(),
      requestContext: JSON.stringify(input.context ?? {}),
      tenantHint: input.tenantHint ? JSON.stringify(input.tenantHint) : null,
      note: input.note ?? null,
    });

    await this.#emit({
      type: 'access-request.created',
      accessRequest: request,
      at: new Date(),
    });

    return request;
  }

  // ============= Operator reads =============

  /**
   * List access requests (operator-facing). Requires the `access-requests:read`
   * capability when an authorizer is configured.
   */
  async listAccessRequests(
    filter: ListAccessRequestsFilter = {},
  ): Promise<AccessRequest[]> {
    await this.#requireCapability(ACCESS_REQUEST_CAPABILITIES.READ, {
      by: filter.by,
    });

    const where: Record<string, unknown> = {};
    if (filter.status !== undefined) where.status = filter.status;
    if (filter.email !== undefined) where.email = normalizeEmail(filter.email);
    if (filter.source !== undefined) where.source = filter.source;

    return await this.#requests.list({
      where,
      limit: filter.limit,
      offset: filter.offset,
      orderBy: filter.orderBy ?? 'created_at DESC',
    });
  }

  /**
   * Get a single access request by id (operator-facing). Requires the
   * `access-requests:read` capability when an authorizer is configured.
   */
  async getAccessRequest(
    id: string,
    options: { by?: string | null } = {},
  ): Promise<AccessRequest | null> {
    await this.#requireCapability(ACCESS_REQUEST_CAPABILITIES.READ, {
      by: options.by,
      accessRequestId: id,
    });
    return await this.#requests.get(id);
  }

  // ============= Operator decisions =============

  /**
   * Approve a request: `REQUESTED → APPROVED`. Idempotent (re-approving an
   * already-`APPROVED` request is a no-op returning it). Requires
   * `access-requests:manage`.
   *
   * @throws {@link AccessRequestError} (`INVALID_TRANSITION`) from a terminal state.
   */
  async approveAccessRequest(
    id: string,
    options: ApproveAccessRequestOptions = {},
  ): Promise<AccessRequest> {
    await this.#requireCapability(ACCESS_REQUEST_CAPABILITIES.MANAGE, {
      by: options.by,
      accessRequestId: id,
    });

    const request = await this.#load(id);
    if (request.status === AccessRequestStatus.APPROVED) return request;
    this.#assertTransition(request, APPROVE_FROM, 'approve');

    request.status = AccessRequestStatus.APPROVED;
    request.decidedAt = new Date();
    if (options.by) request.decidedBy = options.by;
    if (options.note != null) request.note = options.note;
    await request.save();

    await this.#emit({
      type: 'access-request.approved',
      accessRequest: request,
      at: new Date(),
      by: options.by,
    });
    return request;
  }

  /**
   * Decline a request: `REQUESTED | APPROVED → DECLINED`. Idempotent. Requires
   * `access-requests:manage`.
   *
   * @throws {@link AccessRequestError} (`INVALID_TRANSITION`) from a terminal state.
   */
  async declineAccessRequest(
    id: string,
    options: DeclineAccessRequestOptions = {},
  ): Promise<AccessRequest> {
    await this.#requireCapability(ACCESS_REQUEST_CAPABILITIES.MANAGE, {
      by: options.by,
      accessRequestId: id,
    });

    const request = await this.#load(id);
    if (request.status === AccessRequestStatus.DECLINED) return request;
    this.#assertTransition(request, DECLINE_FROM, 'decline');

    request.status = AccessRequestStatus.DECLINED;
    request.decidedAt = new Date();
    if (options.by) request.decidedBy = options.by;
    if (options.reason != null) request.note = options.reason;
    await request.save();

    await this.#emit({
      type: 'access-request.declined',
      accessRequest: request,
      at: new Date(),
      by: options.by,
    });
    return request;
  }

  /**
   * Cancel a request: `REQUESTED | APPROVED → CANCELED`. Idempotent. Requires
   * `access-requests:manage`.
   *
   * @throws {@link AccessRequestError} (`INVALID_TRANSITION`) from a terminal state.
   */
  async cancelAccessRequest(
    id: string,
    options: CancelAccessRequestOptions = {},
  ): Promise<AccessRequest> {
    await this.#requireCapability(ACCESS_REQUEST_CAPABILITIES.MANAGE, {
      by: options.by,
      accessRequestId: id,
    });

    const request = await this.#load(id);
    if (request.status === AccessRequestStatus.CANCELED) return request;
    this.#assertTransition(request, CANCEL_FROM, 'cancel');

    request.status = AccessRequestStatus.CANCELED;
    request.decidedAt = new Date();
    if (options.by) request.decidedBy = options.by;
    if (options.reason != null) request.note = options.reason;
    await request.save();

    await this.#emit({
      type: 'access-request.canceled',
      accessRequest: request,
      at: new Date(),
      by: options.by,
    });
    return request;
  }

  // ============= Graduation =============

  /**
   * Graduate an approved request into a `User`, optionally attaching a tenant.
   *
   * Valid from `APPROVED` (or from `REQUESTED` when
   * {@link GraduateAccessRequestOptions.allowFromRequested} is set). Creates a
   * user when none exists for the email, or **links** the existing one
   * otherwise (reusing {@link UserCollection}). Idempotent: a second call on an
   * already-`GRADUATED` request returns the same user (and an existing
   * membership for the requested tenant, if any) without re-creating anything.
   *
   * Requires `access-requests:manage`.
   *
   * @throws {@link AccessRequestError} — `NOT_FOUND` (unknown id),
   *   `INVALID_TRANSITION` (terminal/declined/canceled or `REQUESTED` without
   *   `allowFromRequested`), `TENANT_NOT_FOUND`, or `ROLE_NOT_FOUND`.
   */
  async graduateAccessRequest(
    id: string,
    options: GraduateAccessRequestOptions = {},
  ): Promise<GraduateAccessRequestResult> {
    await this.#requireCapability(ACCESS_REQUEST_CAPABILITIES.MANAGE, {
      by: options.by,
      accessRequestId: id,
    });

    const request = await this.#load(id);
    const tenantOption = options.tenant ?? 'none';

    // Idempotent re-graduation: return the same user (and existing membership
    // for the requested tenant, if resolvable) without mutating anything.
    if (
      request.status === AccessRequestStatus.GRADUATED &&
      request.resultingUserId
    ) {
      const existingUser = await this.#users.get(request.resultingUserId);
      if (existingUser) {
        const membership = await this.#resolveExistingMembership(
          existingUser.id as string,
          tenantOption,
        );
        return {
          user: existingUser,
          membership: membership ?? undefined,
          accessRequest: request,
          created: false,
        };
      }
      // resultingUserId is stale/missing — fall through and re-link by email.
    }

    // State-machine guard for a fresh graduation.
    if (request.status !== AccessRequestStatus.GRADUATED) {
      const allowFromRequested = options.allowFromRequested ?? false;
      const canGraduate =
        request.status === AccessRequestStatus.APPROVED ||
        (request.status === AccessRequestStatus.REQUESTED &&
          allowFromRequested);
      if (!canGraduate) {
        const hint =
          request.status === AccessRequestStatus.REQUESTED
            ? ' (approve it first, or pass allowFromRequested)'
            : '';
        throw new AccessRequestError(
          `Cannot graduate an access request in status "${request.status}"${hint}.`,
          'INVALID_TRANSITION',
        );
      }
    }

    // Validate the tenant option BEFORE any write (user / tenant / membership):
    // an invalid role slug or missing tenant must fail fast so graduation never
    // leaves an orphan user or tenant behind (codex review #1713).
    if (tenantOption !== 'none') {
      await this.#ensureRolesSeeded();
      await this.#validateTenantOption(tenantOption);
    }

    // Create-or-link the user by normalized email. A brand-new user defaults to
    // ACTIVE (or `options.activate`). An existing linked user keeps its current
    // status unless the operator *explicitly* passes `activate` — so graduation
    // never silently un-suspends an already-managed account.
    const email = normalizeEmail(request.email);
    let user = await this.#users.findByEmail(email);
    let created = false;
    if (!user) {
      user = await this.#users.create({
        email,
        status: options.activate ?? UserStatus.ACTIVE,
      });
      created = true;
    } else if (
      options.activate !== undefined &&
      user.status !== options.activate
    ) {
      user.status = options.activate;
      await user.save();
    }

    // Attach a tenant if requested.
    let membership: Membership | undefined;
    let tenant: Tenant | undefined;
    if (tenantOption !== 'none') {
      const attached = await this.#attachTenant(
        user.id as string,
        tenantOption,
      );
      membership = attached.membership;
      tenant = attached.tenant;
    }

    // Mark graduated.
    request.status = AccessRequestStatus.GRADUATED;
    request.resultingUserId = user.id as string;
    request.decidedAt = new Date();
    if (options.by) request.decidedBy = options.by;
    if (options.note != null) request.note = options.note;
    await request.save();

    await this.#emit({
      type: 'access-request.graduated',
      accessRequest: request,
      at: new Date(),
      by: options.by,
      user,
      membership,
      tenant,
    });

    return { user, membership, tenant, accessRequest: request, created };
  }

  // ============= Internals =============

  /**
   * Load a request or throw `NOT_FOUND`.
   */
  async #load(id: string): Promise<AccessRequest> {
    const request = await this.#requests.get(id);
    if (!request) {
      throw new AccessRequestError('Access request not found.', 'NOT_FOUND');
    }
    return request;
  }

  /**
   * Guard a state transition; throw `INVALID_TRANSITION` if the current status
   * is not an allowed source.
   */
  #assertTransition(
    request: AccessRequest,
    allowedFrom: AccessRequestStatus[],
    action: string,
  ): void {
    if (!allowedFrom.includes(request.status)) {
      throw new AccessRequestError(
        `Cannot ${action} an access request in status "${request.status}".`,
        'INVALID_TRANSITION',
      );
    }
  }

  /**
   * Run the configured authorizer (if any). Absent an authorizer, operator
   * methods are ungated — see the class-level security note.
   */
  async #requireCapability(
    capability: AccessRequestCapability,
    context: { by?: string | null; accessRequestId?: string },
  ): Promise<void> {
    if (!this.#authorize) return;
    await this.#authorize({
      capability,
      by: context.by ?? null,
      accessRequestId: context.accessRequestId,
    });
  }

  /**
   * Best-effort event delivery — a throwing handler is logged and swallowed so
   * it cannot roll back an already-persisted transition.
   */
  async #emit(event: AccessRequestEvent): Promise<void> {
    if (!this.#onEvent) return;
    try {
      await this.#onEvent(event);
    } catch (error) {
      logger.error(
        `AccessRequest event handler threw for "${event.type}" (request ${event.accessRequest.id})`,
        { error },
      );
    }
  }

  /**
   * Throw `ROLE_NOT_FOUND` if no role with `roleSlug` is resolvable (tenant-
   * specific first, then system). Roles must already be seeded.
   */
  async #assertRoleExists(roleSlug: string, tenantId?: string): Promise<void> {
    if (!(await this.#roles.findBySlug(roleSlug, tenantId))) {
      throw new AccessRequestError(
        `Role "${roleSlug}" not found — seed system roles or pass a valid role slug.`,
        'ROLE_NOT_FOUND',
      );
    }
  }

  /**
   * Validate a graduation tenant option with NO side effects: the target tenant
   * must exist (existing-tenant variant) and the role slug must resolve. Run
   * before any persistence so a bad option can't leave orphan rows.
   */
  async #validateTenantOption(
    option: GraduateNewTenantOption | GraduateExistingTenantOption,
  ): Promise<void> {
    if ('tenantId' in option) {
      const tenant = await this.#tenants.get(option.tenantId);
      if (!tenant) {
        throw new AccessRequestError(
          `Target tenant "${option.tenantId}" not found.`,
          'TENANT_NOT_FOUND',
        );
      }
      await this.#assertRoleExists(
        option.role ?? DEFAULT_ROLE_SLUGS.MEMBER,
        option.tenantId,
      );
    } else {
      // A brand-new tenant has no tenant-specific roles yet, so the role must
      // resolve as a system role.
      await this.#assertRoleExists(option.role ?? DEFAULT_ROLE_SLUGS.OWNER);
    }
  }

  /**
   * Create-or-attach the requester to a tenant, reusing the tenant / role /
   * membership collections (no duplication of user/membership logic).
   */
  async #attachTenant(
    userId: string,
    option: GraduateNewTenantOption | GraduateExistingTenantOption,
  ): Promise<{ tenant: Tenant; membership: Membership }> {
    await this.#ensureRolesSeeded();

    if ('tenantId' in option) {
      const tenant = await this.#tenants.get(option.tenantId);
      if (!tenant) {
        throw new AccessRequestError(
          `Target tenant "${option.tenantId}" not found.`,
          'TENANT_NOT_FOUND',
        );
      }
      const membership = await this.#getOrCreateMembership(
        userId,
        tenant.id as string,
        option.role ?? DEFAULT_ROLE_SLUGS.MEMBER,
      );
      return { tenant, membership };
    }

    const tenant = await this.#tenants.create({
      name: option.create.name,
      slug: option.create.slug,
      description: option.create.description,
      status: option.create.status,
    });
    const membership = await this.#getOrCreateMembership(
      userId,
      tenant.id as string,
      option.role ?? DEFAULT_ROLE_SLUGS.OWNER,
    );
    return { tenant, membership };
  }

  /**
   * Resolve (creating if needed) the user's membership in a tenant with the
   * given role slug. Idempotent — returns any existing membership for the pair.
   */
  async #getOrCreateMembership(
    userId: string,
    tenantId: string,
    roleSlug: string,
  ): Promise<Membership> {
    const existing = await this.#memberships.findByUserAndTenant(
      userId,
      tenantId,
    );
    if (existing) return existing;

    const role = await this.#roles.findBySlug(roleSlug, tenantId);
    if (!role) {
      throw new AccessRequestError(
        `Role "${roleSlug}" not found — seed system roles or pass a valid role slug.`,
        'ROLE_NOT_FOUND',
      );
    }

    return await this.#memberships.create({
      userId,
      tenantId,
      roleId: role.id as string,
      status: MembershipStatus.ACTIVE,
    });
  }

  /**
   * For idempotent re-graduation: find an existing membership for the requested
   * tenant. Only the existing-tenant variant is resolvable (a `{ create }`
   * variant has no known tenant id on a re-call).
   */
  async #resolveExistingMembership(
    userId: string,
    tenantOption: GraduateTenantOption,
  ): Promise<Membership | null> {
    if (tenantOption === 'none' || !('tenantId' in tenantOption)) return null;
    return await this.#memberships.findByUserAndTenant(
      userId,
      tenantOption.tenantId,
    );
  }

  /**
   * Lazily seed the default system roles (owner/admin/member/viewer) the first
   * time graduation attaches a tenant — so the public create path never incurs
   * the write.
   */
  async #ensureRolesSeeded(): Promise<void> {
    if (this.#rolesSeeded) return;
    await this.#roles.seedSystemRoles();
    this.#rolesSeeded = true;
  }
}
