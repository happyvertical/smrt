import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
// Register the package manifest before this module's @smrt() decorator
// runs, whichever chunk the library build places it in (#3098).
import '../__smrt-register__.js';
import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy/decorators';
import type { NotificationDeliveryChannel } from './NotificationDelivery.js';

/** `*` (everything in the tenant) or a host key such as `project:<uuid>`. */
export const NOTIFICATION_OPT_OUT_SCOPE_PATTERN =
  /^(?:\*|[a-z][a-z0-9-]*:[A-Za-z0-9._:-]{1,200})$/;

/** The scope that matches every notification of the channel in the tenant. */
export const NOTIFICATION_OPT_OUT_ALL_SCOPE = '*';

export function isValidNotificationOptOutScope(
  scope: unknown,
): scope is string {
  return (
    typeof scope === 'string' && NOTIFICATION_OPT_OUT_SCOPE_PATTERN.test(scope)
  );
}

export interface NotificationOptOutOptions extends SmrtObjectOptions {
  tenantId?: string;
  recipientUserId?: string;
  channel?: NotificationDeliveryChannel;
  scope?: string;
  optedOutAt?: Date | null;
  updatedBy?: string;
}

/**
 * One person's opt-out of one notification channel for one scope, in one
 * tenant: the preference store behind the outbox's `isSuppressed` hook.
 *
 * Identity is `(tenant, recipient, channel, scope)` (the conflict identity).
 * `optedOutAt` is set while the person is opted out and cleared by an opt-in,
 * so the row keeps its history. `scope` is a host-defined key validated by
 * {@link NOTIFICATION_OPT_OUT_SCOPE_PATTERN}. Read and change rows through
 * `NotificationOptOutService`; the generated REST/MCP/CLI are off because the
 * service is the authorization boundary.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'notification_opt_outs',
  api: false,
  mcp: false,
  cli: false,
  conflictColumns: ['tenant_id', 'recipient_user_id', 'channel', 'scope'],
})
export class NotificationOptOut extends SmrtObject {
  @tenantId()
  tenantId = '';

  /** The person who opted out (`smrt-users:User`, uuid). */
  @crossPackageRef('@happyvertical/smrt-users:User', { required: true })
  recipientUserId = '';

  /** Channel opted out of; only `email` today. */
  @field({ required: true })
  channel: NotificationDeliveryChannel = 'email';

  /** `*` or a host key such as `project:<uuid>`. */
  @field({ required: true })
  scope = '';

  /** When the opt-out took effect; null once the person opted back in. */
  optedOutAt: Date | null = null;

  /** Who last changed the row: the person's user id, or `system` for host code. */
  updatedBy = '';

  constructor(options: NotificationOptOutOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.recipientUserId !== undefined)
      this.recipientUserId = options.recipientUserId;
    if (options.channel !== undefined) this.channel = options.channel;
    if (options.scope !== undefined) this.scope = options.scope;
    if (options.optedOutAt !== undefined) this.optedOutAt = options.optedOutAt;
    if (options.updatedBy !== undefined) this.updatedBy = options.updatedBy;
  }

  get isOptedOut(): boolean {
    return this.optedOutAt !== null;
  }
}
