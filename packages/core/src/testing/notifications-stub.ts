/**
 * In-process test double for the sql package's optional notification
 * capability (`db.notifications`, e.g. Postgres LISTEN/NOTIFY).
 *
 * Attaches a push-driven `notify`/`listen` pair to a database handle so tests
 * can exercise the cross-process / cross-replica paths of the collection cache
 * (#1498) and the change-signal bus (#1763) against a real in-memory SQLite
 * database that has no native notification support. `notify` records every
 * broadcast; `listen` exposes an async iterable that yields whatever `push`
 * delivers.
 *
 * Extracted from `__tests__/issue-1498-collection-cache.test.ts` so the same
 * double backs the change-signal bus tests without duplicating the stub.
 */

import type { DatabaseInterface } from '@happyvertical/sql';

/** One notification as delivered over the stubbed channel. */
export interface StubNotification {
  channel: string;
  // Payloads are arbitrary JSON-ish structures; callers assert on their shape.
  // biome-ignore lint/suspicious/noExplicitAny: notification payloads are untyped by design
  payload: any;
}

/** Handle returned by {@link stubNotifications}. */
export interface StubNotificationsHandle {
  /** Every broadcast recorded by `notify`, in call order. */
  broadcasts: StubNotification[];
  /** Deliver a notification to the active `listen` iterator (or queue it). */
  push: (notification: StubNotification) => void;
}

/**
 * Install a minimal `notifications` capability on `db` and return handles for
 * asserting broadcasts and pushing inbound notifications.
 *
 * `notify` appends to `broadcasts` and resolves; `listen` returns a
 * single-consumer async iterable whose `next()` resolves with the next pushed
 * (or previously queued) notification, and whose `return()` completes the
 * iterator so the background listener loop can be torn down.
 */
export function stubNotifications(
  db: DatabaseInterface,
): StubNotificationsHandle {
  const broadcasts: StubNotification[] = [];
  const waiters: Array<(value: StubNotification) => void> = [];
  const queue: StubNotification[] = [];

  const push = (notification: StubNotification): void => {
    const waiter = waiters.shift();
    if (waiter) waiter(notification);
    else queue.push(notification);
  };

  // biome-ignore lint/suspicious/noExplicitAny: attaching to the duck-typed capability slot
  (db as any).notifications = {
    async notify(channel: string, payload: unknown): Promise<number> {
      broadcasts.push({ channel, payload });
      return 1;
    },
    listen(_channel: string) {
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<StubNotification>> {
              const queued = queue.shift();
              if (queued) {
                return Promise.resolve({ value: queued, done: false });
              }
              return new Promise((resolve) => {
                waiters.push((value) => resolve({ value, done: false }));
              });
            },
            return(): Promise<IteratorResult<StubNotification>> {
              return Promise.resolve({
                value: undefined as unknown as StubNotification,
                done: true,
              });
            },
          };
        },
      };
    },
  };

  return { broadcasts, push };
}
