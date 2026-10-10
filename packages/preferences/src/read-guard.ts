/**
 * Owner-safe reads of `UiPreferenceRecord` (#3727).
 *
 * A principal must never read another user's preferences, through the
 * store or any other in-process path to the model (a collection `list()` or
 * `get()`, raw `query()` hydration). Tenancy already confines every read to
 * the principal's tenant; this interceptor additionally drops user-scope
 * rows that are not the principal's own. Tenant-default rows stay visible to
 * everyone in the tenant. A row whose scope cannot be told (a `select`
 * without `scope_type` / `user_id`) is dropped: fail closed. Single-row
 * hydration (`new UiPreferenceRecord({ id }).initialize()`) is checked by
 * the model itself.
 *
 * @internal
 */
import { GlobalInterceptors, type SmrtObject } from '@happyvertical/smrt-core';
import { getPreferencePrincipal } from './context.js';

const GUARD_NAME = 'smrt-preferences:owner-reads';
const CLASS_NAME = 'UiPreferenceRecord';
const QUALIFIED_NAME = '@happyvertical/smrt-preferences:UiPreferenceRecord';

function field(row: unknown, camel: string, snake: string): unknown {
  if (!row || typeof row !== 'object') return undefined;
  const record = row as Record<string, unknown>;
  return record[camel] !== undefined ? record[camel] : record[snake];
}

/** Whether the ambient principal may see `row`. */
export function isPreferenceRowVisible(row: unknown): boolean {
  const scope = field(row, 'scopeType', 'scope_type');
  if (scope === 'tenant') return true;
  if (scope !== 'user') return false;
  const owner = field(row, 'userId', 'user_id');
  const userId = getPreferencePrincipal()?.userId;
  return Boolean(userId) && typeof owner === 'string' && owner === userId;
}

function isPreferenceClass(
  className: string,
  qualifiedClassName?: string,
): boolean {
  return qualifiedClassName === QUALIFIED_NAME || className === CLASS_NAME;
}

function filterRows<T>(
  className: string,
  rows: T[],
  qualifiedClassName?: string,
): T[] | undefined {
  if (!isPreferenceClass(className, qualifiedClassName)) return undefined;
  return rows.filter(isPreferenceRowVisible);
}

/**
 * Register the owner-read interceptor (idempotent). Called when the model
 * module loads and again before every store read, so a cleared interceptor
 * registry (tests, `GlobalInterceptors.clear()`) cannot silently drop it.
 */
export function ensurePreferenceReadGuard(): void {
  if (GlobalInterceptors.getAll().some((entry) => entry.name === GUARD_NAME)) {
    return;
  }
  GlobalInterceptors.register({
    name: GUARD_NAME,
    // After tenancy (priority 100) has scoped the read to the tenant.
    priority: 90,
    afterList<T extends SmrtObject>(
      className: string,
      results: T[],
      context: { qualifiedClassName?: string },
    ) {
      return filterRows(className, results, context.qualifiedClassName);
    },
    afterQuery<T extends SmrtObject>(
      className: string,
      results: T[],
      context: { qualifiedClassName?: string },
    ) {
      return filterRows(className, results, context.qualifiedClassName);
    },
    afterGet<T extends SmrtObject>(
      className: string,
      instance: T | null,
      context: { qualifiedClassName?: string },
    ) {
      if (
        !instance ||
        !isPreferenceClass(className, context.qualifiedClassName)
      ) {
        return undefined;
      }
      return isPreferenceRowVisible(instance) ? instance : null;
    },
  });
}
