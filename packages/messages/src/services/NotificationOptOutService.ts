import {
  isUniqueViolationError,
  ObjectRegistry,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import { NotificationOptOutCollection } from '../collections/NotificationOptOutCollection.js';
import { withTenant } from '../host.js';
import {
  NOTIFICATION_DELIVERY_CHANNELS,
  type NotificationDeliveryChannel,
} from '../models/NotificationDelivery.js';
import {
  isValidNotificationOptOutScope,
  NOTIFICATION_OPT_OUT_ALL_SCOPE,
  NotificationOptOut,
} from '../models/NotificationOptOut.js';
import type { NotificationSuppressionRequest } from './NotificationOutboxService.js';

/** The signed-in person making a request, as the host authenticated them. */
export interface NotificationOptOutPrincipal {
  userId: string;
  /**
   * The tenant the principal is authenticated in. Required and must equal the
   * request's tenant: a principal never acts in another tenant. A host whose
   * recipient is authenticated elsewhere (e.g. a member of a child tenant)
   * authorizes the recipient itself and makes a trusted call without a
   * principal instead.
   */
  tenantId: string;
}

export interface NotificationOptOutKey {
  tenantId: string;
  recipientUserId: string;
  channel: NotificationDeliveryChannel;
  /** `*` or a host key such as `project:<uuid>`. */
  scope: string;
}

export interface NotificationOptOutChange extends NotificationOptOutKey {
  /**
   * The signed-in person, authenticated in this tenant. When present only the
   * recipient themself may change the row, and only in the principal's own
   * tenant; when omitted the call is trusted host code that has already
   * authenticated the recipient (e.g. a signed unsubscribe link, or a host
   * route whose member belongs to a child tenant of the delivery tenant).
   */
  principal?: NotificationOptOutPrincipal;
}

export interface NotificationOptOutListRequest {
  tenantId: string;
  recipientUserId: string;
  principal: NotificationOptOutPrincipal;
}

export type NotificationOptOutDenialReason = 'principal' | 'tenant';

/** Thrown when a principal tries to read or change another person's opt-out. */
export class NotificationOptOutDeniedError extends Error {
  constructor(
    readonly reason: NotificationOptOutDenialReason,
    message: string,
  ) {
    super(message);
    this.name = 'NotificationOptOutDeniedError';
  }
}

function requireText(value: string | undefined, name: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`A notification opt-out ${name} is required.`);
  return text;
}

function validate(key: NotificationOptOutKey): NotificationOptOutKey {
  const channel = key.channel;
  if (!NOTIFICATION_DELIVERY_CHANNELS.includes(channel)) {
    throw new Error(`Unknown notification channel '${String(channel)}'.`);
  }
  if (!isValidNotificationOptOutScope(key.scope)) {
    throw new Error(
      `Invalid notification opt-out scope '${String(key.scope)}': use '*' or a key like 'project:<id>'.`,
    );
  }
  return {
    tenantId: requireText(key.tenantId, 'tenant'),
    recipientUserId: requireText(key.recipientUserId, 'recipient'),
    channel,
    scope: key.scope,
  };
}

function authorize(
  principal: NotificationOptOutPrincipal | undefined,
  tenantId: string,
  recipientUserId: string,
): string {
  if (!principal) return 'system';
  if (!principal.tenantId || principal.tenantId !== tenantId) {
    throw new NotificationOptOutDeniedError(
      'tenant',
      'Principal does not belong to this tenant.',
    );
  }
  if (!principal.userId || principal.userId !== recipientUserId) {
    throw new NotificationOptOutDeniedError(
      'principal',
      'Only the recipient may change or list their notification opt-outs.',
    );
  }
  return principal.userId;
}

/**
 * The per-recipient opt-out ledger behind the outbox's `isSuppressed` hook.
 *
 * Writes are idempotent and, with a `principal`, limited to the recipient's
 * own rows. {@link isOptedOut} is a trusted read for suppression: it runs
 * where the recipient is not the caller (a manager enqueues, a worker
 * dispatches) and is always scoped to the given tenant.
 */
export class NotificationOptOutService {
  constructor(private readonly options: { db: SmrtClassOptions['db'] }) {}

  private collection(): Promise<NotificationOptOutCollection> {
    return NotificationOptOutCollection.create({ db: this.options.db });
  }

  /** Opt the recipient out of `scope`; a repeat leaves the row untouched. */
  async optOut(change: NotificationOptOutChange): Promise<NotificationOptOut> {
    return this.change(change, true);
  }

  /** Clear an opt-out; a repeat, or no row at all, is a no-op. */
  async optIn(change: NotificationOptOutChange): Promise<NotificationOptOut> {
    return this.change(change, false);
  }

  /**
   * Whether the recipient has opted out of `scope` (a `*` row matches every
   * scope). Trusted read: no principal, always under the tenant's scope.
   */
  async isOptedOut(key: NotificationOptOutKey): Promise<boolean> {
    const { tenantId, recipientUserId, channel, scope } = validate(key);
    const scopes =
      scope === NOTIFICATION_OPT_OUT_ALL_SCOPE
        ? [scope]
        : [scope, NOTIFICATION_OPT_OUT_ALL_SCOPE];
    return withTenant({ tenantId }, async () => {
      const rows = await (await this.collection()).list({
        where: { tenantId, recipientUserId, channel, 'scope in': scopes },
      });
      return rows.some((row) => row.optedOutAt !== null);
    });
  }

  /** The recipient's own active opt-outs, in one tenant. */
  async listForRecipient(
    request: NotificationOptOutListRequest,
  ): Promise<NotificationOptOut[]> {
    const tenantId = requireText(request.tenantId, 'tenant');
    const recipientUserId = requireText(request.recipientUserId, 'recipient');
    if (!request.principal) {
      throw new NotificationOptOutDeniedError(
        'principal',
        'A principal is required to list opt-outs.',
      );
    }
    authorize(request.principal, tenantId, recipientUserId);
    return withTenant({ tenantId }, async () => {
      const rows = await (await this.collection()).list({
        where: { tenantId, recipientUserId },
        orderBy: 'scope ASC',
      });
      return rows.filter((row) => row.optedOutAt !== null);
    });
  }

  private async change(
    change: NotificationOptOutChange,
    optedOut: boolean,
  ): Promise<NotificationOptOut> {
    const key = validate(change);
    const updatedBy = authorize(
      change.principal,
      key.tenantId,
      key.recipientUserId,
    );
    const { tenantId, recipientUserId, channel, scope } = key;

    return withTenant({ tenantId }, async () => {
      const rows = await this.collection();
      const find = async () =>
        (
          await rows.list({
            where: { tenantId, recipientUserId, channel, scope },
            limit: 1,
          })
        )[0];

      const apply = async (row: NotificationOptOut) => {
        if (row.isOptedOut === optedOut) return row; // already in that state
        row.optedOutAt = optedOut ? new Date() : null;
        row.updatedBy = updatedBy;
        await row.save();
        return row;
      };

      const existing = await find();
      if (existing) return apply(existing);
      if (!optedOut) {
        // Nothing to clear; return an unsaved, opted-in view of the key.
        return new (ObjectRegistry.resolveEffectiveConstructor(
          NotificationOptOut,
        ))({
          tenantId,
          recipientUserId,
          channel,
          scope,
          optedOutAt: null,
          updatedBy,
        });
      }
      try {
        return await rows.create({
          _insertOnly: true,
          tenantId,
          recipientUserId,
          channel,
          scope,
          optedOutAt: new Date(),
          updatedBy,
        });
      } catch (error) {
        if (!isUniqueViolationError(error)) throw error;
        const winner = await find();
        if (!winner) throw error;
        return apply(winner);
      }
    });
  }
}

/**
 * Build an `isSuppressed` function for `NotificationOutboxOptions` from the
 * ledger. `scopeOf` maps a notification to the scope a recipient can opt out
 * of (e.g. `project:<uuid>` from its `sourceRef`), or null when the
 * notification is not opt-out-able. A `*` opt-out suppresses any notification
 * `scopeOf` maps to a scope; returning `'*'` checks only the tenant-wide row.
 */
export function optOutSuppression(
  service: Pick<NotificationOptOutService, 'isOptedOut'>,
  scopeOf: (
    request: NotificationSuppressionRequest,
  ) => string | null | Promise<string | null>,
): (request: NotificationSuppressionRequest) => Promise<boolean> {
  return async (request) => {
    const scope = await scopeOf(request);
    if (scope === null || scope === undefined) return false;
    return service.isOptedOut({
      tenantId: request.tenantId,
      recipientUserId: request.recipientUserId,
      channel: request.channel,
      scope,
    });
  };
}
