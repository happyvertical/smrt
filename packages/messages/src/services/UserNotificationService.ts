import {
  isUniqueViolationError,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { UserNotificationCollection } from '../collections/UserNotificationCollection.js';
import {
  USER_NOTIFICATION_SEVERITIES,
  type UserNotification,
  type UserNotificationSeverity,
} from '../models/UserNotification.js';

/** What to tell one person. */
export interface UserNotificationInput {
  tenantId: string;
  recipientUserId: string;
  /** Host-defined type, e.g. `social-post.failed`. */
  kind: string;
  title: string;
  body?: string;
  href?: string | null;
  severity?: UserNotificationSeverity;
  /**
   * Dedupe key for the underlying event (e.g. `social-post:<id>:failed`). A
   * second `notify()` with the same `(tenantId, recipientUserId, sourceRef)`
   * returns the existing row untouched, read state included. Omit for
   * one-off notifications; a unique ref is generated.
   */
  sourceRef?: string;
  /** When the event happened (default: now). */
  occurredAt?: Date;
}

export interface UserNotificationNotifyResult {
  notification: UserNotification;
  /** False when `sourceRef` matched an existing notification. */
  created: boolean;
}

export interface UserNotificationListOptions {
  /** Tenants to read (at least one). Each is read under its own tenant scope. */
  tenantIds: readonly string[];
  /** Only rows not yet read. */
  unreadOnly?: boolean;
  /** Include dismissed rows (default false). */
  includeDismissed?: boolean;
  /** Only rows that happened at or after this time. */
  since?: Date;
  /** Newest-first cap across all tenants (default 50, max 200). */
  limit?: number;
}

export interface UserNotificationScope {
  tenantId: string;
}

/** Notification ids are uuids; anything else can match no row. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function requireText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`A notification ${name} is required.`);
  return text;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Notification list limit must be a positive integer.');
  }
  return Math.min(limit, MAX_LIMIT);
}

/**
 * Creates, lists, and updates per-user notifications (`UserNotification`).
 *
 * The service is the authorization boundary for the model: every read and
 * write is filtered to one recipient and runs under an explicit tenant
 * scope. The host decides who may be notified (e.g. the poster of a failed
 * social post) and passes the signed-in user's id for reads; it never lets
 * a request choose another user's id.
 */
export class UserNotificationService {
  constructor(private readonly options: { db: SmrtClassOptions['db'] }) {}

  private collection(): Promise<UserNotificationCollection> {
    return UserNotificationCollection.create({ db: this.options.db });
  }

  /** Store a notification unless its `sourceRef` already exists. */
  async notify(
    input: UserNotificationInput,
  ): Promise<UserNotificationNotifyResult> {
    const tenantId = requireText(input.tenantId, 'tenant');
    const recipientUserId = requireText(input.recipientUserId, 'recipient');
    const kind = requireText(input.kind, 'kind');
    const title = requireText(input.title, 'title');
    const severity = input.severity ?? 'info';
    if (!USER_NOTIFICATION_SEVERITIES.includes(severity)) {
      throw new Error(`Unknown notification severity '${severity}'.`);
    }
    const sourceRef =
      input.sourceRef?.trim() || `notification:${crypto.randomUUID()}`;

    return withTenant({ tenantId }, async () => {
      const notifications = await this.collection();
      const findExisting = async () =>
        (
          await notifications.list({
            where: { tenantId, recipientUserId, sourceRef },
            limit: 1,
          })
        )[0];
      const existing = await findExisting();
      if (existing) return { notification: existing, created: false };

      // Insert-only: a concurrent notify() for the same event may have stored
      // the row since the lookup above. An upsert would then overwrite it —
      // title, and read/dismissed state reset to null — so a collision is
      // resolved by returning the stored row untouched instead.
      let notification: UserNotification;
      try {
        notification = await notifications.create({
          _insertOnly: true,
          tenantId,
          recipientUserId,
          kind,
          title,
          body: input.body?.trim() ?? '',
          href: input.href ?? null,
          severity,
          sourceRef,
          occurredAt: input.occurredAt ?? new Date(),
          readAt: null,
          dismissedAt: null,
        });
      } catch (error) {
        if (!isUniqueViolationError(error)) throw error;
        const winner = await findExisting();
        if (!winner) throw error;
        return { notification: winner, created: false };
      }
      return { notification, created: true };
    });
  }

  /** `notify()` for each recipient (duplicates in the list are ignored). */
  async notifyMany(
    recipientUserIds: readonly string[],
    input: Omit<UserNotificationInput, 'recipientUserId'>,
  ): Promise<UserNotificationNotifyResult[]> {
    const results: UserNotificationNotifyResult[] = [];
    for (const recipientUserId of new Set(recipientUserIds)) {
      results.push(await this.notify({ ...input, recipientUserId }));
    }
    return results;
  }

  /** A user's notifications across the given tenants, newest first. */
  async listForUser(
    userId: string,
    options: UserNotificationListOptions,
  ): Promise<UserNotification[]> {
    const recipientUserId = requireText(userId, 'recipient');
    const limit = clampLimit(options.limit);
    const tenantIds = [...new Set(options.tenantIds.filter(Boolean))];
    const notifications = await this.collection();

    const perTenant = await Promise.all(
      tenantIds.map((tenantId) =>
        withTenant({ tenantId }, () =>
          notifications.list({
            where: {
              tenantId,
              recipientUserId,
              ...(options.includeDismissed ? {} : { dismissedAt: null }),
              ...(options.unreadOnly ? { readAt: null } : {}),
              ...(options.since ? { 'occurredAt >=': options.since } : {}),
            },
            orderBy: 'occurredAt DESC',
            limit,
          }),
        ),
      ),
    );

    return perTenant
      .flat()
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, limit);
  }

  /** Unread, undismissed count across the given tenants. */
  async countUnread(
    userId: string,
    options: Pick<UserNotificationListOptions, 'tenantIds' | 'since'>,
  ): Promise<number> {
    const recipientUserId = requireText(userId, 'recipient');
    const notifications = await this.collection();
    const counts = await Promise.all(
      [...new Set(options.tenantIds.filter(Boolean))].map((tenantId) =>
        withTenant({ tenantId }, () =>
          notifications.count({
            where: {
              tenantId,
              recipientUserId,
              readAt: null,
              dismissedAt: null,
              ...(options.since ? { 'occurredAt >=': options.since } : {}),
            },
          }),
        ),
      ),
    );
    return counts.reduce((sum, count) => sum + Number(count), 0);
  }

  /** Mark the user's own notifications read; returns how many changed. */
  async markRead(
    userId: string,
    ids: readonly string[],
    scope: UserNotificationScope,
  ): Promise<number> {
    return this.stamp(userId, ids, scope, 'readAt');
  }

  /** Dismiss (and mark read) the user's own notifications. */
  async dismiss(
    userId: string,
    ids: readonly string[],
    scope: UserNotificationScope,
  ): Promise<number> {
    return this.stamp(userId, ids, scope, 'dismissedAt');
  }

  /** Mark every unread notification of the user in these tenants read. */
  async markAllRead(
    userId: string,
    options: Pick<UserNotificationListOptions, 'tenantIds'>,
  ): Promise<number> {
    const recipientUserId = requireText(userId, 'recipient');
    const notifications = await this.collection();
    const now = new Date();
    let changed = 0;
    for (const tenantId of new Set(options.tenantIds.filter(Boolean))) {
      changed += await withTenant({ tenantId }, async () => {
        const unread = await notifications.list({
          where: { tenantId, recipientUserId, readAt: null },
        });
        for (const notification of unread) {
          notification.readAt = now;
          await notification.save();
        }
        return unread.length;
      });
    }
    return changed;
  }

  private async stamp(
    userId: string,
    ids: readonly string[],
    scope: UserNotificationScope,
    column: 'readAt' | 'dismissedAt',
  ): Promise<number> {
    const recipientUserId = requireText(userId, 'recipient');
    const tenantId = requireText(scope.tenantId, 'tenant');
    // Ids come from requests. A malformed one can match no row, and on a
    // native uuid column (PostgreSQL) it would fail the whole query (22P02)
    // instead, so drop it before querying.
    const wanted = [
      ...new Set(
        ids.filter(
          (id): id is string => typeof id === 'string' && UUID_PATTERN.test(id),
        ),
      ),
    ];
    if (wanted.length === 0) return 0;

    return withTenant({ tenantId }, async () => {
      const notifications = await this.collection();
      // The recipient filter is the authorization check: another user's id
      // simply matches nothing.
      const rows = await notifications.list({
        where: { tenantId, recipientUserId, 'id in': wanted },
      });
      const now = new Date();
      let changed = 0;
      for (const notification of rows) {
        if (notification[column] !== null) continue;
        notification[column] = now;
        if (column === 'dismissedAt' && notification.readAt === null) {
          notification.readAt = now;
        }
        await notification.save();
        changed += 1;
      }
      return changed;
    });
  }
}
