/** A browser-safe notification supplied by an application-owned provider. */
export interface NotificationItem {
  id: string;
  title: string;
  body?: string;
  href?: string | null;
  severity?: 'info' | 'success' | 'warning' | 'error';
  occurredAt: string;
  readAt?: string | null;
}

/**
 * Application boundary for the notification bell.
 *
 * Providers authorize their own reads and writes. The component never accepts
 * a user id or tenant id, so it cannot broaden that authority.
 */
export interface NotificationProvider {
  getUnreadCount(): Promise<number>;
  list(options?: { limit?: number }): Promise<NotificationItem[]>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
  /** Optional live transport subscription. Returns an unsubscribe function. */
  subscribe?(listener: () => void): () => void;
}
