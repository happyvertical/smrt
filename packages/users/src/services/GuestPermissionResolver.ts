/**
 * GuestPermissionResolver - the permission set an unauthenticated (guest)
 * caller holds in a tenant (#5196).
 *
 * The set is the tenant's `TenantGuestGrant` slugs, minus every DENY in the
 * tenant inheritance chain, narrowed by a CODE CEILING that no stored row can
 * widen. Nothing is cached: every call reads live rows, so a revoked grant, a
 * new DENY or a suspended tenant takes effect on the next request.
 *
 * This module only computes the set. It is not wired into requests; the
 * guest principal entry is a later slice.
 *
 * @packageDocumentation
 */

import {
  classifyDatabaseError,
  isEffectivelySensitiveClass,
  isRlsBypassingRole,
  isRuntimeModelClass,
  ObjectRegistry,
  resolveOperationPermissionAlias,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  isTenancyEnabled,
  withSystemContext,
} from '@happyvertical/smrt-tenancy';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { TenantGuestGrantCollection } from '../collections/TenantGuestGrantCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import { withoutListBounds } from './authorization-read-options.js';
import { PermissionResolver } from './PermissionResolver.js';
import {
  generatePostgresPermissionSql,
  type PostgresPermissionPolicyTarget,
} from './PostgresPermissionPolicies.js';

/** The app's guest configuration (`permissions.guest`). */
export interface GuestPermissionConfig {
  /** Collections guests may be granted access to. Anything else is dropped. */
  collections: string[];
  /**
   * Collections that additionally opt in to guest `create` (a contact form).
   * `<collection>.create` survives only for a collection listed here.
   */
  createCollections?: string[];
}

/** The only guest permission kinds; everything else never survives. */
export type GuestPermissionKind = 'read' | 'create';

/** Generated CRUD operations each guest kind may authorize. */
const GUEST_KIND_OPERATIONS: Record<GuestPermissionKind, readonly string[]> = {
  read: ['list', 'get'],
  create: ['create'],
};

const USERS_PACKAGE_PREFIX = '@happyvertical/smrt-users:';

function splitSlug(
  slug: string,
): { collection: string; kind: GuestPermissionKind } | null {
  const dot = slug.lastIndexOf('.');
  if (dot <= 0) return null;
  const collection = slug.slice(0, dot);
  const kind = slug.slice(dot + 1);
  if (kind !== 'read' && kind !== 'create') return null;
  return { collection, kind };
}

/**
 * The guest permission kind an operation is authorized by, or `null`.
 *
 * Decided by the operation itself, never by the slug it would be checked
 * against: only the generated CRUD operations (`list`/`get` for read,
 * `create` for create) map to a guest kind. A custom method, even one aliased
 * onto `read` or `create` through `operationPermissions`, maps to nothing, so
 * a `products.read` grant never opens it.
 */
export function guestOperationKind(
  model: string,
  operation: string,
): GuestPermissionKind | null {
  let aliased = false;
  try {
    aliased =
      resolveOperationPermissionAlias(
        ObjectRegistry.getConfig(model),
        operation,
      ) !== undefined;
  } catch {
    return null;
  }
  if (aliased) return null;
  for (const kind of ['read', 'create'] as const) {
    if (GUEST_KIND_OPERATIONS[kind].includes(operation)) return kind;
  }
  return null;
}

/**
 * Whether a guest holding `permissions` may run `operation` on `collection`
 * (the collection slug prefix). Fails closed on custom and aliased methods.
 */
export function isGuestOperationAllowed(
  permissions: ReadonlySet<string>,
  model: string,
  collection: string,
  operation: string,
): boolean {
  const kind = guestOperationKind(model, operation);
  return kind !== null && permissions.has(`${collection}.${kind}`);
}

/** Whether the class's generated CRUD config exposes `operation`. */
function crudOperationGenerated(config: unknown, operation: string): boolean {
  const api = (config as { api?: unknown } | undefined)?.api;
  if (api === false) return false;
  if (api && typeof api === 'object') {
    const { include, exclude } = api as {
      include?: unknown;
      exclude?: unknown;
    };
    if (Array.isArray(include) && !include.includes(operation)) return false;
    if (Array.isArray(exclude) && exclude.includes(operation)) return false;
  }
  return true;
}

function sameSlugs(actual: string[] | undefined, expected: string): boolean {
  return Array.isArray(actual) && actual.length === 1 && actual[0] === expected;
}

/**
 * Whether one `(collection, kind)` pair passes the code ceiling.
 * Exported for tests and for the later request wiring.
 */
export function collectionPassesGuestCeiling(
  target: PostgresPermissionPolicyTarget | undefined,
  kind: GuestPermissionKind,
): boolean {
  if (!target?.collection) return false;
  const qualifiedName = target.qualifiedName;
  if (!qualifiedName) return false;
  // Never the identity/RBAC package's own tables.
  if (qualifiedName.startsWith(USERS_PACKAGE_PREFIX)) return false;

  const registered = ObjectRegistry.getClass(qualifiedName);
  if (!registered) return false;
  if (isRuntimeModelClass(qualifiedName)) return false;
  if (isEffectivelySensitiveClass(qualifiedName)) return false;

  // Required-mode tenant table (the generator only targets those, and skips
  // shared tables) with the generated tenant-match policy.
  if (registered.tenantScopedConfig?.mode !== 'required') return false;
  if (registered.tenantScopedConfig.autoFilter === false) return false;
  const config = ObjectRegistry.getConfig(qualifiedName);
  // An owner-scoped model derives access from the principal; a guest has no
  // user id, so it is never a guest collection.
  if ((config as { principalContext?: unknown }).principalContext === true) {
    return false;
  }

  // The policy for this action must be exactly the generated slug, with no
  // extra explicit binding (a custom binding could be owner-scoped).
  const action = kind === 'read' ? 'SELECT' : 'INSERT';
  if (!sameSlugs(target.actions[action], `${target.collection}.${kind}`)) {
    return false;
  }

  // The slug must map to a generated CRUD operation of the class.
  return GUEST_KIND_OPERATIONS[kind].some((operation) =>
    crudOperationGenerated(config, operation),
  );
}

/**
 * Apply the code ceiling to a set of slugs. Only exact `<collection>.read`
 * and `<collection>.create` can survive, `create` only for a collection the
 * app lists in `createCollections`, and only for collections the app lists in
 * `collections` that pass {@link collectionPassesGuestCeiling}.
 */
export function applyGuestCeiling(
  slugs: Iterable<string>,
  guest: GuestPermissionConfig,
  targets: readonly PostgresPermissionPolicyTarget[],
): Set<string> {
  const listed = new Set(guest.collections);
  const createListed = new Set(guest.createCollections ?? []);
  const byCollection = new Map<string, PostgresPermissionPolicyTarget>();
  for (const target of targets) {
    if (target.collection && !byCollection.has(target.collection)) {
      byCollection.set(target.collection, target);
    }
  }
  const out = new Set<string>();
  for (const slug of slugs) {
    const parsed = splitSlug(slug);
    if (!parsed) continue;
    if (!listed.has(parsed.collection)) continue;
    if (parsed.kind === 'create' && !createListed.has(parsed.collection)) {
      continue;
    }
    if (
      !collectionPassesGuestCeiling(
        byCollection.get(parsed.collection),
        parsed.kind,
      )
    ) {
      continue;
    }
    out.add(slug);
  }
  return out;
}

/**
 * Resolves the guest permission set of a tenant.
 *
 * @example
 * ```typescript
 * const resolver = await GuestPermissionResolver.create(options, {
 *   collections: ['products', 'contact_messages'],
 *   createCollections: ['contact_messages'],
 * });
 * const permissions = await resolver.resolveGuestPermissions(tenantId);
 * ```
 */
export class GuestPermissionResolver {
  private readonly options: SmrtClassOptions;
  private readonly guest: GuestPermissionConfig;
  private grants!: TenantGuestGrantCollection;
  private overrides!: TenantPermissionOverrideCollection;
  private permissions!: PermissionCollection;
  private tenantResolver!: PermissionResolver;
  private targetsCache?: {
    registrySize: number;
    targets: PostgresPermissionPolicyTarget[];
  };

  constructor(options: SmrtClassOptions, guest: GuestPermissionConfig) {
    this.options = options;
    this.guest = {
      collections: [...(guest?.collections ?? [])],
      createCollections: [...(guest?.createCollections ?? [])],
    };
  }

  /** Create and initialize a resolver. */
  static async create(
    options: SmrtClassOptions,
    guest: GuestPermissionConfig,
  ): Promise<GuestPermissionResolver> {
    const resolver = new GuestPermissionResolver(options, guest);
    await resolver.initialize();
    return resolver;
  }

  async initialize(): Promise<void> {
    // Authorization reads must be complete (see PermissionResolver).
    const options = withoutListBounds(this.options);
    this.permissions = await PermissionCollection.create(options);
    this.overrides = await TenantPermissionOverrideCollection.create(options);
    this.tenantResolver = new PermissionResolver(this.options);
    await this.tenantResolver.initialize();
    try {
      this.grants = await TenantGuestGrantCollection.create(options);
    } catch (error) {
      // A deployment that has not migrated the grants table has no guests.
      if (!isMissingTable(error)) throw error;
    }
  }

  /**
   * The guest permission set of `tenantId`. Empty when the grants table is
   * missing, or the tenant or any ancestor is missing or inactive.
   */
  async resolveGuestPermissions(tenantId: string): Promise<Set<string>> {
    if (!tenantId || !this.grants) return new Set();
    return await withSystemContext(() => this.resolveInternal(tenantId));
  }

  private async resolveInternal(tenantId: string): Promise<Set<string>> {
    const empty = new Set<string>();

    let granted: string[];
    try {
      granted = await this.grants.getGrantedSlugs(tenantId);
    } catch (error) {
      if (isMissingTable(error)) return empty;
      throw error;
    }
    if (granted.length === 0) return empty;

    const chainIds = await this.activeChainIds(tenantId);
    if (!chainIds) return empty;

    const denied = await this.deniedSlugs(chainIds);
    const afterDeny = granted.filter((slug) => !denied.has(slug));
    if (afterDeny.length === 0) return empty;

    return applyGuestCeiling(afterDeny, this.guest, this.policyTargets());
  }

  /**
   * The tenant chain's ids, root first, or `null` when the tenant or any
   * ancestor is missing, inactive, or the chain is not intact.
   */
  private async activeChainIds(tenantId: string): Promise<string[] | null> {
    let chain: Awaited<
      ReturnType<PermissionResolver['getTenantInheritanceChain']>
    >;
    try {
      chain = await this.tenantResolver.getTenantInheritanceChain(tenantId);
    } catch {
      // A broken hierarchy (cycle, over-depth, missing parent) fails closed.
      return null;
    }
    if (chain.length === 0) return null;
    const last = chain[chain.length - 1].tenant;
    if (last.id !== tenantId) return null;
    // The chain must reach a root: a truncated chain means an ancestor is
    // missing or unreadable.
    if (chain[0].tenant.parentTenantId) return null;
    for (let i = 0; i < chain.length; i++) {
      const { tenant } = chain[i];
      if (!tenant.id || !tenant.isActive()) return null;
      if (i > 0 && tenant.parentTenantId !== chain[i - 1].tenant.id) {
        return null;
      }
    }
    return chain.map((entry) => entry.tenant.id as string);
  }

  /** Slugs DENY'd by a tenant override anywhere in the chain. */
  private async deniedSlugs(chainIds: string[]): Promise<Set<string>> {
    const denied = new Set<string>();
    const byTenant = await this.overrides.getOverridesByEffectBatch(chainIds);
    const ids = new Set<string>();
    for (const result of byTenant.values()) {
      for (const id of result.deniedPermissionIds) ids.add(id);
    }
    if (ids.size === 0) return denied;
    const rows = await this.permissions.list({
      where: { 'id in': [...ids] },
      select: ['id', 'slug'],
      limit: ids.size,
    });
    for (const row of rows) {
      if (typeof row.slug === 'string' && row.slug) denied.add(row.slug);
    }
    return denied;
  }

  private policyTargets(): PostgresPermissionPolicyTarget[] {
    const registrySize = ObjectRegistry.getAllObjectMetadata().length;
    if (this.targetsCache?.registrySize !== registrySize) {
      this.targetsCache = {
        registrySize,
        targets: generatePostgresPermissionSql(this.options).targets,
      };
    }
    return this.targetsCache.targets;
  }
}

function isMissingTable(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === 'DB_SCHEMA_MISSING') {
    return true;
  }
  return classifyDatabaseError(error).kind === 'undefined_object';
}

// ---------------------------------------------------------------------------
// Fail-closed runtime gates
// ---------------------------------------------------------------------------

/** One ceiling table's row-level-security state, read from the catalog. */
export interface GuestRlsTablePosture {
  table: string;
  /** `relrowsecurity`: policies are enabled on the table. */
  rowSecurity: boolean;
  /** `relforcerowsecurity`: policies also apply to the table owner. */
  forceRowSecurity: boolean;
  /** Number of policies on the table. */
  policyCount: number;
}

export interface GuestRuntimeState {
  /** `runtimeContext.postgresRls`; must be exactly `true`. */
  postgresRls?: boolean;
  /** `isTenancyEnabled()`; defaults to reading it. Installed is not enough. */
  tenancyEnabled?: boolean;
  /**
   * `rolsuper` / `rolbypassrls` of the connection role (`pg_roles`, the same
   * attributes the PostgreSQL permission contract rejects). Unknown posture
   * is refused.
   */
  rolePosture?: { rolsuper?: boolean; rolbypassrls?: boolean } | null;
  /** FORCE ROW LEVEL SECURITY state of every ceiling table. */
  ceilingTables?: readonly GuestRlsTablePosture[];
}

export type GuestRuntimeDenyReason =
  | 'rls-not-active'
  | 'tenancy-not-enabled'
  | 'role-posture-unknown'
  | 'role-bypasses-rls'
  | 'ceiling-table-not-forced';

export type GuestRuntimeResult =
  | { active: true }
  | { active: false; reason: GuestRuntimeDenyReason; detail: string };

/**
 * The fail-closed gates guests need before any guest request is served.
 * Returns a reasoned result and never throws on denial: any failing gate
 * means guests are refused (an empty permission set for the caller).
 */
export function assertGuestRuntimeActive(
  state: GuestRuntimeState,
): GuestRuntimeResult {
  const deny = (
    reason: GuestRuntimeDenyReason,
    detail: string,
  ): GuestRuntimeResult => ({ active: false, reason, detail });

  if (state.postgresRls !== true) {
    return deny(
      'rls-not-active',
      'guests require PostgreSQL row-level security (postgresRls === true)',
    );
  }
  const tenancyEnabled = state.tenancyEnabled ?? isTenancyEnabled();
  if (tenancyEnabled !== true) {
    return deny(
      'tenancy-not-enabled',
      'guests require tenancy to be enabled, not merely installed',
    );
  }
  const role = state.rolePosture;
  if (!role) {
    return deny(
      'role-posture-unknown',
      'the connection role posture was not verified',
    );
  }
  if (isRlsBypassingRole(role)) {
    return deny(
      'role-bypasses-rls',
      'the connection role is SUPERUSER or BYPASSRLS',
    );
  }
  for (const table of state.ceilingTables ?? []) {
    if (
      !table.rowSecurity ||
      !table.forceRowSecurity ||
      !(table.policyCount > 0)
    ) {
      return deny(
        'ceiling-table-not-forced',
        `table ${table.table} lacks enabled and forced row-level-security policies`,
      );
    }
  }
  return { active: true };
}
