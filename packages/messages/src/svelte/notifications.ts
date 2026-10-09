import type { UserNotification } from '../models/UserNotification.js';
import type { UserNotificationService } from '../services/UserNotificationService.js';

export interface NotificationBellItem {
  id: string;
  title: string;
  body?: string;
  href?: string | null;
  severity?: 'info' | 'success' | 'warning' | 'error';
  occurredAt: string;
  readAt?: string | null;
}

/** Structural counterpart of smrt-svelte's NotificationProvider; no UI dependency. */
export interface UserNotificationBellProvider {
  getUnreadCount(): Promise<number>;
  list(options?: { limit?: number }): Promise<NotificationBellItem[]>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface UserNotificationBellProviderOptions {
  service: UserNotificationService;
  /** Signed-in recipient, fixed at provider construction. */
  userId: string;
  /** Authorized tenant set, fixed at provider construction. */
  tenantIds: readonly string[];
  /** Host-owned live transport. It must only signal that the caller should reload. */
  subscribe?: (listener: () => void) => () => void;
}

function project(notification: UserNotification): NotificationBellItem {
  return {
    id: String(notification.id),
    title: notification.title,
    body: notification.body || undefined,
    href: notification.href,
    severity: notification.severity,
    occurredAt: notification.occurredAt.toISOString(),
    readAt: notification.readAt?.toISOString() ?? null,
  };
}

/**
 * Creates a provider for `NotificationBell` from the recipient-scoped service.
 * The user and tenant scope are closed over so browser callers cannot alter them.
 */
export function createUserNotificationBellProvider(
  options: UserNotificationBellProviderOptions,
): UserNotificationBellProvider {
  const userId = options.userId.trim();
  const tenantIds = [...new Set(options.tenantIds.filter(Boolean))];
  if (!userId)
    throw new Error('Notification bell provider requires a user id.');
  if (tenantIds.length === 0)
    throw new Error('Notification bell provider requires tenant ids.');
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const notificationScopes = new Map<string, string>();
  return {
    async getUnreadCount() {
      return options.service.countUnread(userId, { tenantIds });
    },
    async list(listOptions) {
      const rows = await options.service.listForUser(userId, {
        tenantIds,
        limit: listOptions?.limit,
      });
      for (const row of rows)
        notificationScopes.set(String(row.id), row.tenantId);
      return rows.map(project);
    },
    async markRead(id) {
      const tenantId = notificationScopes.get(id);
      if (!tenantId)
        throw new Error(
          'Notification must be loaded before it can be marked read.',
        );
      await options.service.markRead(userId, [id], { tenantId });
      emit();
    },
    async markAllRead() {
      await options.service.markAllRead(userId, { tenantIds });
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      const stopHost = options.subscribe?.(emit);
      return () => {
        listeners.delete(listener);
        stopHost?.();
      };
    },
  };
}
