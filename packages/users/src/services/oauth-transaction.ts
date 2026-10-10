import { setTimeout } from 'node:timers/promises';
import type { DatabaseInterface } from '@happyvertical/sql';

/** Retry only rolled-back contention failures; never retry external side effects. */
export async function withOAuthTransaction<T>(
  db: DatabaseInterface,
  action: (tx: DatabaseInterface) => Promise<T>,
): Promise<T> {
  if (!db.transaction)
    throw new Error('OAuth persistence requires transaction support.');
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(action);
    } catch (error) {
      let current: unknown = error;
      let retryable = false;
      let invalidated = false;
      for (
        let depth = 0;
        depth < 4 && current && typeof current === 'object';
        depth++
      ) {
        const failure = current as {
          code?: unknown;
          cause?: unknown;
          connectionInvalidated?: boolean;
        };
        if (
          ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', '40001', '40P01'].includes(
            String(failure.code),
          )
        )
          retryable = true;
        invalidated ||= failure.connectionInvalidated === true;
        current = failure.cause;
      }
      if (attempt >= 6 || !retryable || invalidated) throw error;
      await setTimeout(5 * 2 ** attempt);
    }
  }
}
