/**
 * Conditional retry of failed dispatches (internal).
 *
 * One `UPDATE ... WHERE status = 'failed' AND <filters> RETURNING id` moves
 * matching failed rows back to `pending`. The status condition is evaluated
 * by the write itself, so a retry never reverts a row another worker has
 * meanwhile claimed, completed or retried; the count is the rows this call
 * changed (RETURNING), never a separate read or an adapter `rowCount`.
 *
 * A retried row keeps its attempt count unless `resetAttempts` is passed, and
 * its stale lease token and expiry are cleared. Without `maxAttempts` or
 * `resetAttempts`, only rows whose claim budget is not yet spent are retried
 * (a row at its budget would not be claimed again).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { pushTenantPredicate } from './collections/Dispatches.js';
import type { DispatchTenantScope } from './tenant-resolver.js';
import type { DispatchRetryOptions } from './types.js';

/**
 * Reset failed dispatches matching `options` (and the tenant scope) to
 * `pending`.
 *
 * @param defaultMaxAttempts - The bus claim budget, for rows without a
 *   stamped `max_attempts`.
 * @returns The number of rows this call moved to `pending`.
 */
export async function retryFailedDispatches(
  db: DatabaseInterface,
  options: DispatchRetryOptions = {},
  tenantScope: DispatchTenantScope | undefined,
  defaultMaxAttempts: number,
): Promise<number> {
  const params: unknown[] = [new Date().toISOString()];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const conditions: string[] = ["status = 'failed'"];

  if (!options.resetAttempts) {
    // A legacy row with NULL attempts has made no recorded attempt.
    conditions.push(
      options.maxAttempts
        ? `COALESCE(attempts, 0) < ${bind(options.maxAttempts)}`
        : `COALESCE(attempts, 0) < COALESCE(max_attempts, ${bind(defaultMaxAttempts)})`,
    );
  }

  if (options.olderThan) {
    conditions.push(`created_at < ${bind(options.olderThan.toISOString())}`);
  }

  if (options.signalTypes && options.signalTypes.length > 0) {
    conditions.push(`type IN (${options.signalTypes.map(bind).join(', ')})`);
  }

  pushTenantPredicate(conditions, params, tenantScope, `$${params.length + 1}`);

  const reset = options.resetAttempts ? ', attempts = 0' : '';
  const result = await db.query(
    `UPDATE _smrt_dispatch
        SET status = 'pending', lease_token = NULL, claimed_until = NULL,
            updated_at = $1${reset}
     WHERE ${conditions.join(' AND ')}
     RETURNING id`,
    ...params,
  );
  return (result.rows ?? []).length;
}
