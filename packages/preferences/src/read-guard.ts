/**
 * Owner-safe reads of `UiPreferenceRecord` (#3727).
 *
 * A principal must never read another user's preferences, through the
 * store or any other in-process path to the model. Tenancy already confines
 * every read to the principal's tenant; this interceptor adds the owner
 * rule to the READ PREDICATE before any SQL runs, so `list`, `get`, `count`,
 * `facets`, semantic search and every other path that runs `beforeList` /
 * `beforeGet` inherit it: only rows whose `scope_key` is `'__tenant__'` (the
 * tenant default) or the principal's own user id; with no user id, tenant
 * rows only. `scope_key` is the column the model keeps in lockstep with
 * `scope_type` / `user_id` (a user row's key is its user id). A caller's own
 * `scopeKey in` condition is intersected, never replaced. Raw `query()` SQL
 * cannot carry the predicate and is refused. The after-read hooks re-check
 * every hydrated row as defence in depth (a row whose scope cannot be told
 * is dropped), and single-row hydration is also checked by the model.
 *
 * @internal
 */
import {
  GlobalInterceptors,
  resolveGetStringFilter,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import { getPreferencePrincipal, PreferenceAccessError } from './context.js';

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

const TENANT_KEY = '__tenant__';
/** No row has an empty scope key (`scopeKey` is required and synced). */
const NO_ROW_KEY = '';
const SCOPE_KEY_IN = ['scopeKey in', 'scope_key in'] as const;

/** The scope keys the ambient principal may read. */
function visibleScopeKeys(): string[] {
  const userId = getPreferencePrincipal()?.userId;
  return userId ? [TENANT_KEY, userId] : [TENANT_KEY];
}

/**
 * `where` AND the owner predicate. A caller's `scopeKey in` list is
 * intersected with the visible keys (an empty intersection matches no row).
 */
function withOwnerPredicate(
  where: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const visible = visibleScopeKeys();
  const next: Record<string, unknown> = { ...(where ?? {}) };
  let keys = visible;
  for (const key of SCOPE_KEY_IN) {
    if (!(key in next)) continue;
    const requested = next[key];
    delete next[key];
    const list = Array.isArray(requested) ? requested : [requested];
    keys = keys.filter((value) => list.includes(value));
  }
  next['scopeKey in'] = keys.length > 0 ? keys : [NO_ROW_KEY];
  return next;
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
    beforeList(className, options, context) {
      if (!isPreferenceClass(className, context.qualifiedClassName)) return;
      const where = options.where as unknown;
      if (Array.isArray(where)) {
        // DNF: every OR branch carries the owner predicate.
        return {
          ...options,
          where: where.map((group: Record<string, unknown>[]) => [
            ...group,
            withOwnerPredicate({}),
          ]),
        } as typeof options;
      }
      return {
        ...options,
        where: withOwnerPredicate(where as Record<string, unknown>),
      };
    },
    beforeGet(className, filter, context) {
      if (!isPreferenceClass(className, context.qualifiedClassName)) return;
      const resolved =
        typeof filter === 'string' ? resolveGetStringFilter(filter) : filter;
      return withOwnerPredicate(resolved);
    },
    beforeQuery(className, _options, context) {
      if (!isPreferenceClass(className, context.qualifiedClassName)) return;
      // Raw SQL cannot carry the owner predicate: refuse it.
      throw new PreferenceAccessError(
        'Raw queries over user-interface preferences are not allowed',
      );
    },
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
