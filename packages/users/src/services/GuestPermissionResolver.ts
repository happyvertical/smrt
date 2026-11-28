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
  chunkArray,
  classifyDatabaseError,
  GUEST_KIND_OPERATIONS,
  type GuestPermissionKind,
  guestOperationKind,
  IN_LIST_CHUNK_SIZE,
  isEffectivelySensitiveClass,
  isGuestOperationAllowed,
  isRlsBypassingRole,
  isRuntimeModelClass,
  ObjectRegistry,
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
  /**
   * The body fields a guest may set, per create collection. A create
   * collection without an entry accepts no guest create. Validated against the
   * registered model when the route first serves a guest.
   */
  /**
   * Qualified names (`package:Class`) of run-time models (`registerRuntimeModel`)
   * the app opts in for guests. A run-time model is excluded from the ceiling
   * unless named here; being exposed or listed in `collections` is not an
   * opt-in. Everything else of the ceiling still applies to it.
   */
  runtimeModels?: string[];
  createFields?: Record<
    string,
    { allowedFields: string[]; maxBodyBytes?: number; maxStringLength?: number }
  >;
  /**
   * Trusted reverse-proxy hops for the guest client identity (an integer, or
   * `true` for one hop). Default 0: only the socket address counts.
   */
  trustedProxyHops?: number | boolean;
  /** Guest rate limits (per window; defaults documented in the users guide). */
  rateLimits?: {
    windowMs?: number;
    createPerClient?: number;
    createPerTenant?: number;
    readPerClient?: number;
    readPerTenant?: number;
  };
}

export type { GuestPermissionKind } from '@happyvertical/smrt-core';
export { guestOperationKind, isGuestOperationAllowed };

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

const NO_RUNTIME_OPT_IN: ReadonlySet<string> = new Set();

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
  runtimeOptIn: ReadonlySet<string> = NO_RUNTIME_OPT_IN,
): boolean {
  if (!target?.collection) return false;
  const qualifiedName = target.qualifiedName;
  if (!qualifiedName) return false;
  // Never the identity/RBAC package's own tables.
  if (qualifiedName.startsWith(USERS_PACKAGE_PREFIX)) return false;

  const registered = ObjectRegistry.getClass(qualifiedName);
  if (!registered) return false;
  // A run-time model passes only when the app named it (fail closed).
  if (isRuntimeModelClass(qualifiedName) && !runtimeOptIn.has(qualifiedName)) {
    return false;
  }
  if (isEffectivelySensitiveClass(qualifiedName)) return false;

  // Required-mode tenant table (the generator only targets those, and skips
  // shared tables) with the generated tenant-match policy.
  if (registered.tenantScopedConfig?.mode !== 'required') return false;
  if (registered.tenantScopedConfig.autoFilter === false) return false;
  const config = ObjectRegistry.getConfig(qualifiedName);
  // An owner-scoped model derives access from the principal; a guest has no
  // user id, so it is never a guest collection. The generated policies are
  // tenant-match only (nothing generated reads `smrt.user_id`), so ownership
  // is detectable only through the principal-context opt-in and through
  // explicit extra policy bindings (checked below).
  // `principalContext` is an `api` option (`@smrt({ api: { principalContext } })`),
  // not a top-level one.
  const api = (config as { api?: { principalContext?: unknown } | boolean })
    .api;
  if (
    api &&
    typeof api === 'object' &&
    (api as { principalContext?: unknown }).principalContext === true
  ) {
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
 * Apply the code ceiling to granted slugs and say, for each survivor, which
 * single policy target (table and model) it was admitted for.
 *
 * A slug survives only when EXACTLY ONE target is reachable by it, and that
 * target passes {@link collectionPassesGuestCeiling}. Reachable means the
 * target's own collection name is the slug's collection, OR the target lists
 * the slug under the matching action (an explicit `permissions.postgres`
 * binding can aim `items.read` at another table). Two models sharing a
 * collection name, or a binding that reaches a second table, therefore drop
 * the slug entirely instead of letting the first model's check speak for
 * the second. Only exact `<collection>.read` / `<collection>.create` can
 * survive, `create` only for a collection in `createCollections`, and only
 * for collections listed in `collections`.
 */
export function guestSlugTargets(
  slugs: Iterable<string>,
  guest: GuestPermissionConfig,
  targets: readonly PostgresPermissionPolicyTarget[],
): Map<string, PostgresPermissionPolicyTarget> {
  const listed = new Set(guest.collections);
  const createListed = new Set(guest.createCollections ?? []);
  const runtimeOptIn = new Set(guest.runtimeModels ?? []);
  const out = new Map<string, PostgresPermissionPolicyTarget>();
  for (const slug of slugs) {
    const parsed = splitSlug(slug);
    if (!parsed) continue;
    if (!listed.has(parsed.collection)) continue;
    if (parsed.kind === 'create' && !createListed.has(parsed.collection)) {
      continue;
    }
    const action = parsed.kind === 'read' ? 'SELECT' : 'INSERT';
    const reachable = targets.filter(
      (target) =>
        target.collection === parsed.collection ||
        (target.actions[action] ?? []).includes(slug),
    );
    if (reachable.length !== 1) continue;
    if (
      !collectionPassesGuestCeiling(reachable[0], parsed.kind, runtimeOptIn)
    ) {
      continue;
    }
    out.set(slug, reachable[0]);
  }
  return out;
}

/** The slugs of {@link guestSlugTargets}. */
export function applyGuestCeiling(
  slugs: Iterable<string>,
  guest: GuestPermissionConfig,
  targets: readonly PostgresPermissionPolicyTarget[],
): Set<string> {
  return new Set(guestSlugTargets(slugs, guest, targets).keys());
}

/** A table whose row-level security a guest request depends on. */
export interface GuestCeilingTable {
  schemaName: string;
  tableName: string;
}

/**
 * The tables behind every listed collection that passes the code ceiling
 * (read or create): the exact set whose catalog posture the runtime gate
 * must verify before a guest request is served. Pure.
 */
export function guestCeilingTables(
  guest: GuestPermissionConfig,
  targets: readonly PostgresPermissionPolicyTarget[],
): GuestCeilingTable[] {
  const listed = new Set(guest.collections);
  const createListed = new Set(guest.createCollections ?? []);
  const runtimeOptIn = new Set(guest.runtimeModels ?? []);
  const seen = new Set<string>();
  const tables: GuestCeilingTable[] = [];
  for (const target of targets) {
    const collection = target.collection;
    if (!collection || !listed.has(collection)) continue;
    const passes =
      collectionPassesGuestCeiling(target, 'read', runtimeOptIn) ||
      (createListed.has(collection) &&
        collectionPassesGuestCeiling(target, 'create', runtimeOptIn));
    if (!passes) continue;
    const key = `${target.schemaName}.${target.tableName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tables.push({ schemaName: target.schemaName, tableName: target.tableName });
  }
  return tables;
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

  constructor(options: SmrtClassOptions, guest: GuestPermissionConfig) {
    this.options = options;
    // A malformed list is an empty list (no guest collections), never a
    // spread of its characters or entries of the wrong type.
    const list = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
    this.guest = {
      collections: list(guest?.collections),
      createCollections: list(guest?.createCollections),
      runtimeModels: list(guest?.runtimeModels),
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
   * The guest permission set of `tenantId` AND the model each slug was
   * admitted for (`slugModels`: slug to the qualified name of the one target
   * the ceiling admitted it on). Routes admit a guest only for that model.
   */
  async resolveGuestAdmission(
    tenantId: string,
  ): Promise<{ permissions: Set<string>; slugModels: Map<string, string> }> {
    const permissions = await this.resolveGuestPermissions(tenantId);
    const admitted = guestSlugTargets(
      permissions,
      this.guest,
      this.policyTargets(),
    );
    const slugModels = new Map<string, string>();
    for (const [slug, target] of admitted) {
      if (target.qualifiedName) slugModels.set(slug, target.qualifiedName);
    }
    return { permissions, slugModels };
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
      // A tenant id that is not a valid uuid (PostgreSQL 22P02) names no
      // tenant: no guests, not an error.
      if (classifyDatabaseError(error).kind === 'invalid_input') return empty;
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
    // Chunked with an explicit limit like PermissionResolver: a truncated
    // lookup would drop a DENY, which fails open.
    for (const chunk of chunkArray([...ids], IN_LIST_CHUNK_SIZE)) {
      const rows = await this.permissions.list({
        where: { 'id in': chunk },
        select: ['id', 'slug'],
        limit: chunk.length,
      });
      for (const row of rows) {
        if (typeof row.slug === 'string' && row.slug) denied.add(row.slug);
      }
    }
    return denied;
  }

  /** Generated policy targets, recomputed so refreshes and new bindings count. */
  private policyTargets(): PostgresPermissionPolicyTarget[] {
    return generatePostgresPermissionSql(this.options).targets;
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

/**
 * The audit table's row-level-security state, read from the catalog: guest
 * creates write their audit row under the guest's own database context, which
 * is only safe when RLS is enabled AND forced on the table and the guest
 * INSERT policy (and nothing a guest could read or update with) is present.
 */
export interface GuestAuditTablePosture {
  table: string;
  /** `relrowsecurity`. */
  rowSecurity: boolean;
  /** `relforcerowsecurity`. */
  forceRowSecurity: boolean;
  /** The named guest INSERT policy exists with `polcmd = 'a'` (INSERT). */
  guestInsertPolicy: boolean;
}

export interface GuestRuntimeState {
  /**
   * The app configures guest creates, so the audit table must be protected.
   * Defaults to TRUE: a caller that forgets to say is checked, not skipped.
   */
  auditRequired?: boolean;
  /** Catalog posture of the audit table (see {@link GuestAuditTablePosture}). */
  auditTable?: GuestAuditTablePosture | null;
  /** `runtimeContext.postgresRls`; must be exactly `true`. */
  postgresRls?: boolean;
  /** `isTenancyEnabled()`; defaults to reading it. Installed is not enough. */
  tenancyEnabled?: boolean;
  /**
   * `rolsuper` / `rolbypassrls` of the connection role (`pg_roles`, the same
   * attributes the PostgreSQL permission contract rejects). Unknown posture
   * is refused.
   */
  rolePosture?: { rolsuper: boolean; rolbypassrls: boolean } | null;
  /**
   * FORCE ROW LEVEL SECURITY state of every ceiling table, from the catalog.
   * Omitting it refuses guests: an unchecked catalog is not a passed check.
   */
  ceilingTables?: readonly GuestRlsTablePosture[];
  /**
   * The ceiling tables the posture must cover. When given, a table with no
   * posture row is refused.
   */
  expectedCeilingTables?: readonly string[];
}

export type GuestRuntimeDenyReason =
  | 'rls-not-active'
  | 'tenancy-not-enabled'
  | 'role-posture-unknown'
  | 'role-bypasses-rls'
  | 'ceiling-posture-unknown'
  | 'ceiling-table-not-forced'
  | 'audit-posture-unknown'
  | 'audit-table-not-protected';

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
  // Both attributes must be explicit booleans: a missing one is unverified,
  // not false.
  if (
    !role ||
    typeof role.rolsuper !== 'boolean' ||
    typeof role.rolbypassrls !== 'boolean'
  ) {
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
  if (!state.ceilingTables) {
    return deny(
      'ceiling-posture-unknown',
      'row-level-security posture of the ceiling tables was not verified',
    );
  }
  const seen = new Set(state.ceilingTables.map((table) => table.table));
  for (const expected of state.expectedCeilingTables ?? []) {
    if (!seen.has(expected)) {
      return deny(
        'ceiling-posture-unknown',
        `no row-level-security posture for ceiling table ${expected}`,
      );
    }
  }
  for (const table of state.ceilingTables) {
    if (
      table.rowSecurity !== true ||
      table.forceRowSecurity !== true ||
      typeof table.policyCount !== 'number' ||
      !(table.policyCount > 0)
    ) {
      return deny(
        'ceiling-table-not-forced',
        `table ${table.table} lacks enabled and forced row-level-security policies`,
      );
    }
  }
  if (state.auditRequired !== false) {
    const audit = state.auditTable;
    if (
      !audit ||
      typeof audit.rowSecurity !== 'boolean' ||
      typeof audit.forceRowSecurity !== 'boolean' ||
      typeof audit.guestInsertPolicy !== 'boolean'
    ) {
      return deny(
        'audit-posture-unknown',
        'row-level-security posture of the audit table was not verified',
      );
    }
    if (
      audit.rowSecurity !== true ||
      audit.forceRowSecurity !== true ||
      audit.guestInsertPolicy !== true
    ) {
      return deny(
        'audit-table-not-protected',
        `audit table ${audit.table} lacks enabled and forced row-level security or the guest audit insert policy`,
      );
    }
  }
  return { active: true };
}
