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
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** How much a notification matters to its recipient. */
export type UserNotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export const USER_NOTIFICATION_SEVERITIES: readonly UserNotificationSeverity[] =
  ['info', 'success', 'warning', 'error'];

export interface UserNotificationOptions extends SmrtObjectOptions {
  tenantId?: string;
  recipientUserId?: string;
  kind?: string;
  title?: string;
  body?: string;
  href?: string | null;
  severity?: UserNotificationSeverity;
  sourceRef?: string;
  occurredAt?: Date;
  readAt?: Date | null;
  dismissedAt?: Date | null;
}

/**
 * One in-app notification for one person, with its own read state.
 *
 * The in-app channel of smrt-messages: where `Message` is delivered through
 * an external provider, a `UserNotification` is stored for a user and shown
 * by the host (a bell, a notifications page). Create, list, and change read
 * state through `UserNotificationService`, which checks the recipient on
 * every write; the generated REST/MCP/CLI surfaces are off because a plain
 * tenant-scoped list would show every member's notifications.
 *
 * `sourceRef` is the dedupe key: one row per `(tenant, recipient, sourceRef)`
 * (the conflict identity), so re-deriving the same event (a failed social
 * post, a failed render) never notifies twice. The service generates a unique
 * ref when the caller has none.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'user_notifications',
  api: false,
  mcp: false,
  cli: false,
  conflictColumns: ['tenant_id', 'recipient_user_id', 'source_ref'],
  // The bell reads a recipient's newest rows in one tenant.
  indexes: [
    {
      name: 'user_notifications_recipient_occurred_idx',
      columns: ['tenantId', 'recipientUserId', 'occurredAt'],
    },
  ],
})
export class UserNotification extends SmrtObject {
  @tenantId()
  tenantId = '';

  /** The person this notification is for (`smrt-users:User`, uuid). */
  @crossPackageRef('@happyvertical/smrt-users:User', { required: true })
  recipientUserId = '';

  /** Host-defined type, e.g. `social-post.failed` (used for icons/filters). */
  @field({ required: true })
  kind = '';

  /** One short plain sentence. */
  @field({ required: true })
  title = '';

  /** Optional detail line. */
  body = '';

  /** Where the notification leads (host-relative path or URL). */
  href: string | null = null;

  severity: UserNotificationSeverity = 'info';

  /** Dedupe key, unique per tenant and recipient (see class docs). */
  @field({ required: true })
  sourceRef = '';

  /** When the underlying event happened (sort key). */
  occurredAt = new Date();

  /** Set when the recipient has seen it. */
  readAt: Date | null = null;

  /** Set when the recipient has cleared it; dismissed rows are hidden. */
  dismissedAt: Date | null = null;

  constructor(options: UserNotificationOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.recipientUserId !== undefined)
      this.recipientUserId = options.recipientUserId;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.title !== undefined) this.title = options.title;
    if (options.body !== undefined) this.body = options.body;
    if (options.href !== undefined) this.href = options.href;
    if (options.severity !== undefined) this.severity = options.severity;
    if (options.sourceRef !== undefined) this.sourceRef = options.sourceRef;
    if (options.occurredAt !== undefined) this.occurredAt = options.occurredAt;
    if (options.readAt !== undefined) this.readAt = options.readAt;
    if (options.dismissedAt !== undefined)
      this.dismissedAt = options.dismissedAt;
  }

  get isRead(): boolean {
    return this.readAt !== null;
  }

  get isDismissed(): boolean {
    return this.dismissedAt !== null;
  }
}
