/**
 * Conditional retry of failed dispatches (internal).
 *
 * One `UPDATE ... WHERE status = 'failed' AND <filters> RETURNING id` moves
 * matching failed rows back to `pending`. The status condition is evaluated
 * by the write itself, so a retry never reverts a row another worker has
 * meanwhile claimed, completed or retried; the count is the rows this call
 * changed (RETURNING), never a separate read or an adapter `rowCount`.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { pushTenantPredicate } from './collections/Dispatches.js';
import type { DispatchTenantScope } from './tenant-resolver.js';
import type { DispatchRetryOptions } from './types.js';

/**
 * Reset failed dispatches matching `options` (and the tenant scope) to
 * `pending`. Only `status` and `updated_at` change.
 *
 * @returns The number of rows this call moved to `pending`.
 */
export async function retryFailedDispatches(
  db: DatabaseInterface,
  options: DispatchRetryOptions = {},
  tenantScope?: DispatchTenantScope,
): Promise<number> {
  const params: unknown[] = [new Date().toISOString()];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const conditions: string[] = ["status = 'failed'"];

  if (options.maxAttempts) {
    // A legacy row with NULL attempts has made no recorded attempt.
    conditions.push(`COALESCE(attempts, 0) < ${bind(options.maxAttempts)}`);
  }

  if (options.olderThan) {
    conditions.push(`created_at < ${bind(options.olderThan.toISOString())}`);
  }

  if (options.signalTypes && options.signalTypes.length > 0) {
    conditions.push(`type IN (${options.signalTypes.map(bind).join(', ')})`);
  }

  pushTenantPredicate(conditions, params, tenantScope, `$${params.length + 1}`);

  const result = await db.query(
    `UPDATE _smrt_dispatch SET status = 'pending', updated_at = $1
     WHERE ${conditions.join(' AND ')}
     RETURNING id`,
    ...params,
  );
  return (result.rows ?? []).length;
}
