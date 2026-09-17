/**
 * Declared, read-only ancestor visibility policy.
 *
 * A membership is normally authority DOWNWARD only: a direct membership row in
 * the target tenant, or — opt-in, per role — the nearest ACTIVE ancestor
 * membership whose role is flagged `inheritsToDescendants`. Nothing a user
 * holds on a DESCENDANT tenant contributes anything when the permission
 * context is resolved at an ancestor, so a principal whose only membership is
 * on a child tenant resolves to the empty set at the root (smrt#2939).
 *
 * That is correct by default — a descendant membership is narrower authority
 * than its ancestor — but it prevents a legitimate, common shape: a
 * network-level LIST that members of the network's child tenants are meant to
 * read. This module describes the narrow, declared exception.
 *
 * Everything about it is deliberately restrictive:
 *
 * - **Off by default.** An application that declares no policy resolves
 *   exactly as before.
 * - **Declared, never inferred.** The application names the descendant role
 *   slugs and the collections. Nothing is derived from role names, catalog
 *   shape, or hierarchy position. Because a slug is not unique across a
 *   hierarchy — tenant-scoped custom roles are created by whoever administers
 *   that tenant — only a governed SYSTEM role (`tenantId` null and
 *   `isSystem: true`, what `RoleCollection.seedSystemRoles()` creates) can
 *   match a declared slug. A descendant cannot opt itself in by minting a
 *   same-named custom role.
 * - **Read only.** Only `<collection>.read` is ever contributed (`list`/`get`
 *   normalize to `read`). No `create`/`update`/`delete`, no custom action.
 * - **Never an escalation.** The contribution is intersected with the
 *   principal's EFFECTIVE permissions in the contributing tenant — that
 *   tenant's fully resolved set, including its DENY cascade and the
 *   membership GRANT/DENY overrides — so a principal can never gain at an
 *   ancestor something it does not hold at its own tenant, and a DENY that
 *   removed a permission at home removes it at the ancestor too.
 * - **Never lateral.** The policy grants the OPERATION at the ancestor. It is
 *   NOT visibility of a sibling tenant's rows — row scoping remains the
 *   executor's job (the `@happyvertical/smrt-tenancy` interceptor and the
 *   generated Postgres RLS policies), and a sibling's rows stay unreadable.
 *
 * @packageDocumentation
 */

import { getPackageConfig } from '@happyvertical/smrt-config';
import { normalizeOperationPermissionAction } from './PermissionCatalogService.js';

/**
 * Default number of hierarchy hops a descendant membership may travel upward
 * when the policy does not say. `1` is the immediate parent only.
 */
export const DEFAULT_ANCESTOR_READ_MAX_DEPTH = 1;

/**
 * The only action an ancestor-read grant can ever carry.
 */
export const ANCESTOR_READ_ACTION = 'read';

/**
 * Declared ancestor-read policy.
 *
 * @example
 * ```typescript
 * // smrt.config.ts
 * export default defineConfig({
 *   packages: {
 *     users: {
 *       permissions: {
 *         ancestorRead: {
 *           roles: ['member', 'editor'],
 *           collections: ['publications', 'tenants'],
 *           maxDepth: 2,
 *         },
 *       },
 *     },
 *   },
 * });
 * ```
 */
export interface AncestorReadPolicy {
  /**
   * Descendant role slugs whose memberships may contribute upward. Required
   * and non-empty: an omitted or empty list disables the policy entirely.
   * Matching is exact and case-insensitive on the role slug; no patterns.
   *
   * Only SYSTEM roles match — `tenantId` null and `isSystem: true`, as created
   * by `RoleCollection.seedSystemRoles()`. A tenant-scoped custom role sharing
   * the slug contributes nothing, so a descendant tenant's administrator
   * cannot mint its way into an ancestor's allow-list.
   */
  roles: readonly string[];
  /**
   * Collection slugs whose `read` permission may travel upward. Required and
   * non-empty. A trailing `*` wildcard is supported (`'site_*'`); `'*'` alone
   * means every collection the descendant role can already read.
   */
  collections: readonly string[];
  /**
   * Maximum number of hierarchy hops from the descendant membership up to the
   * tenant being resolved. Defaults to {@link DEFAULT_ANCESTOR_READ_MAX_DEPTH}
   * (immediate parent only). Values below 1 disable the policy.
   */
  maxDepth?: number;
}

/**
 * The `permissions.ancestorRead` slice of the `users` package config.
 */
export interface AncestorReadPackageConfig extends Record<string, unknown> {
  permissions?: {
    ancestorRead?: AncestorReadPolicy;
  };
}

/**
 * A validated policy: slugs lowercased and de-duplicated, depth clamped.
 */
export interface NormalizedAncestorReadPolicy {
  roleSlugs: ReadonlySet<string>;
  collectionPatterns: readonly string[];
  maxDepth: number;
}

function normalizeList(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim().toLowerCase();
    if (trimmed) {
      seen.add(trimmed);
    }
  }
  return Array.from(seen);
}

/**
 * Validate a declared policy. Returns `null` — the policy is OFF — whenever it
 * is absent, malformed, empty on either axis, or bounded to zero depth. There
 * is no partially-valid policy: an unusable declaration fails closed rather
 * than grants something the application did not fully describe.
 */
export function normalizeAncestorReadPolicy(
  policy: AncestorReadPolicy | null | undefined,
): NormalizedAncestorReadPolicy | null {
  if (!policy || typeof policy !== 'object') {
    return null;
  }

  const roleSlugs = normalizeList(policy.roles);
  const collectionPatterns = normalizeList(policy.collections);
  if (roleSlugs.length === 0 || collectionPatterns.length === 0) {
    return null;
  }

  const rawDepth = policy.maxDepth;
  const maxDepth =
    rawDepth === undefined || rawDepth === null
      ? DEFAULT_ANCESTOR_READ_MAX_DEPTH
      : Math.floor(Number(rawDepth));
  if (!Number.isFinite(maxDepth) || maxDepth < 1) {
    return null;
  }

  return {
    roleSlugs: new Set(roleSlugs),
    collectionPatterns,
    maxDepth,
  };
}

/**
 * Read the declared policy from the `users` package config. Returns `null`
 * when nothing is declared — the default for every existing application.
 */
export function getConfiguredAncestorReadPolicy(): NormalizedAncestorReadPolicy | null {
  const config = getPackageConfig<AncestorReadPackageConfig>('users', {});
  return normalizeAncestorReadPolicy(config.permissions?.ancestorRead);
}

function matchesCollectionPattern(
  collection: string,
  pattern: string,
): boolean {
  if (pattern === '*') {
    return true;
  }
  if (!pattern.includes('*')) {
    return collection === pattern;
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`).test(collection);
}

/**
 * Decide whether a permission slug the descendant role already holds may
 * travel upward under this policy.
 *
 * A slug qualifies only when it is a `<collection>.<action>` pair whose action
 * normalizes to `read` and whose collection matches a declared pattern. A slug
 * with no action segment, extra segments, or any non-read action is rejected —
 * this is the single place the read-only invariant is enforced, so a write
 * permission cannot reach an ancestor through any declaration.
 */
export function isAncestorReadableSlug(
  slug: string,
  policy: NormalizedAncestorReadPolicy,
): boolean {
  if (typeof slug !== 'string') {
    return false;
  }
  const parts = slug.trim().toLowerCase().split('.');
  if (parts.length !== 2) {
    return false;
  }
  const [collection, action] = parts;
  if (!collection || !action) {
    return false;
  }
  if (normalizeOperationPermissionAction(action) !== ANCESTOR_READ_ACTION) {
    return false;
  }
  return policy.collectionPatterns.some((pattern) =>
    matchesCollectionPattern(collection, pattern),
  );
}
