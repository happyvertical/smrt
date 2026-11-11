import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  assertTenantReadAllowed,
  getCurrentTenant,
  isSuperAdminBypass,
  TenantIsolationError,
} from '@happyvertical/smrt-tenancy';
import { getCachedFieldPolicy, setCachedFieldPolicy } from './cache.js';
import { FieldPolicyCollection } from './collections/FieldPolicyCollection.js';
import { getObjectFieldMap } from './field-definitions.js';
import type { FieldPolicy } from './models/FieldPolicy.js';
import { cookbookPolicyLayers, resolveFieldPolicyLayers } from './policy.js';
import type {
  ExplainedObjectFieldPolicy,
  FieldPolicyTenantHierarchyProvider,
  FieldPolicyTenantNode,
  FieldPolicyUsersModule,
  ResolvedObjectFieldPolicy,
  ResolveFieldPolicyOptions,
  SmrtClassOptions,
} from './types.js';

/**
 * Resolve the merged field policy for `objectRef` in the given
 * `(tenantId, userId)` context: code seed → app rows → tenant rows (hierarchy
 * walk root → leaf) → user rows. Defaults AND visibility both resolve through
 * the user tier.
 *
 * Results are cached per `(database, objectRef, tenantId, userId)` with a
 * short TTL; `FieldPolicy.save()`/`.delete()` invalidate the object's entries.
 */
export async function resolveFieldPolicy(
  objectRef: string,
  options: ResolveFieldPolicyOptions = {},
): Promise<ResolvedObjectFieldPolicy> {
  const explained = await resolveFieldPolicyExplained(objectRef, options);
  return { objectRef: explained.objectRef, fields: explained.fields };
}

/**
 * The tenant ids whose rows participate in precedence for a tenant, root to
 * leaf. Catalog code uses this instead of reimplementing inheritance-break
 * handling when it decides whether an inherited override is customized.
 */
export async function resolveSurvivingTenantChainIds(
  tenantId: string,
  options: ResolveFieldPolicyOptions = {},
): Promise<string[]> {
  assertResolutionAllowedInContext(tenantId, null);
  const chain = await resolveTenantChain(tenantId, options);
  return selectSurvivingChainSuffix(chain).map((node) => node.id);
}

/**
 * Explain variant: the merged result plus ordered per-layer contributions for
 * each field, so the gear UI (#2049, "shows inherited base") and the control
 * panel (#2050, effective-value-per-layer) never re-derive precedence.
 *
 * A user-layer row suppressed by an effective org lock is omitted from the
 * layer list too — the listed layers always reproduce the merged result.
 */
export async function resolveFieldPolicyExplained(
  objectRef: string,
  options: ResolveFieldPolicyOptions = {},
): Promise<ExplainedObjectFieldPolicy> {
  const tenantId = options.tenantId ?? null;
  const userId = options.userId ?? null;

  assertResolutionAllowedInContext(tenantId, userId);

  let collection: FieldPolicyCollection | null = null;
  let cacheDb: unknown = options.db;
  if (options.db) {
    collection = await FieldPolicyCollection.create({ db: options.db });
    cacheDb = collection.db;
  }

  // The field map load also validates objectRef against the live registry, so
  // unknown refs throw before the cache is consulted.
  const fieldMap = await getObjectFieldMap(objectRef);

  const hasExcludedRows =
    (options.excludePolicyIds?.size ?? 0) > 0 || options.cookbook !== undefined;
  if (!hasExcludedRows) {
    const cached = getCachedFieldPolicy(
      objectRef,
      tenantId,
      userId,
      cacheDb,
      options.tenantHierarchyLoader,
    );
    if (cached) {
      return cached;
    }
  }

  const appRows = collection
    ? await collection.getAppRows(objectRef)
    : new Map<string, FieldPolicy>();

  let survivingChain: FieldPolicyTenantNode[] = [];
  let tenantRows = new Map<string, Map<string, FieldPolicy>>();
  if (collection && tenantId) {
    const chain = await resolveTenantChain(tenantId, options);
    // Permission-inheritance breaks are chain-STRUCTURAL (node flags, not
    // rows), so a break at node i discards every earlier tenant contribution
    // for ALL fields — the merge baseline resets to the app-layer state
    // there. Only the suffix from the LAST break participates in merging and
    // in the explained layers, so sequentially replaying the listed deltas
    // always reproduces the merged result.
    survivingChain = selectSurvivingChainSuffix(chain);
    tenantRows = await collection.getTenantRows(
      objectRef,
      survivingChain.map((node) => node.id),
    );
  }

  const userRows =
    collection && userId
      ? await collection.getUserRows(objectRef, userId)
      : new Map<string, FieldPolicy>();

  const included = (rows: ReadonlyMap<string, FieldPolicy>) =>
    new Map(
      [...rows].filter(
        ([, row]) => !options.excludePolicyIds?.has(String(row.id)),
      ),
    );
  const effectiveModel = ObjectRegistry.getExposureModel(objectRef);
  const explained = resolveFieldPolicyLayers(objectRef, fieldMap, [
    { layer: 'app', rows: included(appRows) },
    ...(options.cookbook
      ? cookbookPolicyLayers(
          {
            objectRef: effectiveModel?.qualifiedName ?? objectRef,
            replacedQualifiedNames: effectiveModel?.replacedQualifiedNames,
          },
          options.cookbook,
        )
      : []),
    ...survivingChain.map((node) => ({
      layer: 'tenant' as const,
      tenantId: node.id,
      rows: included(tenantRows.get(node.id) ?? new Map()),
    })),
    ...(userId
      ? [{ layer: 'user' as const, userId, rows: included(userRows) }]
      : []),
  ]);
  if (!hasExcludedRows) {
    setCachedFieldPolicy(
      objectRef,
      tenantId,
      userId,
      cacheDb,
      explained,
      options.tenantHierarchyLoader,
    );
  }
  return explained;
}

/**
 * Fail-closed isolation guard: an active non-bypass tenant context may only
 * resolve its own tenant and its own user. App-only resolution (`tenantId`
 * null) is always allowed — app rows are global data.
 *
 * Mirrors the write-side rule in `FieldPolicy`: a MISSING identity component
 * denies, it never skips. A context that carries permissions but no user id
 * (no `resolveUserId` hook configured — API-key auth, service principals,
 * background jobs) must not be able to read any user's resolved policy.
 * Context-LESS callers stay allowed: `resolveFieldPolicy` is a trusted
 * server-side API, and the public `resolveBatch` route never lets a request
 * body select a user — it takes identity from the ambient context alone.
 */
function assertResolutionAllowedInContext(
  tenantId: string | null,
  userId: string | null,
): void {
  if (tenantId) {
    assertTenantReadAllowed(tenantId, 'resolveFieldPolicy');
  }

  if (!userId) {
    return;
  }
  const context = getCurrentTenant();
  if (!context || isSuperAdminBypass()) {
    return;
  }
  if (context.userId === undefined) {
    throw new TenantIsolationError(
      `Tenant isolation violation in resolveFieldPolicy: the ambient ` +
        `context carries no user id, so user-scope resolution for ` +
        `'${userId}' is not attributable`,
      { tenantId: context.tenantId },
    );
  }
  if (context.userId !== userId) {
    throw new TenantIsolationError(
      `Tenant isolation violation in resolveFieldPolicy: context user is ` +
        `'${context.userId}' but resolution requested '${userId}'`,
      { tenantId: context.tenantId },
    );
  }
}

/**
 * The chain suffix that actually participates in merging: nodes from the
 * LAST permission-inheritance break onward (a node breaks inheritance when
 * its parent does not cascade permissions or it does not accept them —
 * smrt-features semantics). Everything before the last break is discarded
 * for every field, so it is excluded from both merging and the explained
 * layer contributions.
 */
function selectSurvivingChainSuffix(
  chain: FieldPolicyTenantNode[],
): FieldPolicyTenantNode[] {
  let survivingStart = 0;
  for (let index = 1; index < chain.length; index++) {
    const inherits =
      chain[index - 1].cascadePermissions && chain[index].inheritPermissions;
    if (!inherits) {
      survivingStart = index;
    }
  }
  return chain.slice(survivingStart);
}

async function resolveTenantChain(
  tenantId: string,
  options: ResolveFieldPolicyOptions,
): Promise<FieldPolicyTenantNode[]> {
  const loader = options.tenantHierarchyLoader || defaultTenantHierarchyLoader;
  const provider = await loader({ db: options.db } as SmrtClassOptions);

  if (provider) {
    const chain = await provider.getChain(tenantId);
    if (chain.length > 0) {
      return chain;
    }
  }

  // Flat-tenant fallback (no hierarchy provider, or the provider does not
  // know the tenant): treat the tenant as a single-node chain.
  return [{ id: tenantId, inheritPermissions: true, cascadePermissions: true }];
}

/**
 * Default hierarchy loader: dynamic-imports `@happyvertical/smrt-users` (the
 * smrt-features precedent — a loader function, not a container registration)
 * and returns `null` when it is not installed so resolution degrades to the
 * flat-tenant fallback.
 */
async function defaultTenantHierarchyLoader(
  options: SmrtClassOptions,
): Promise<FieldPolicyTenantHierarchyProvider | null> {
  try {
    const usersModule = await (
      await import('@happyvertical/smrt-core/utils/import-workspace-module')
    ).importWorkspaceModule<FieldPolicyUsersModule>({
      packageName: '@happyvertical/smrt-users',
      sourceEntry: 'packages/users/src/collections/index.ts',
      purpose: 'tenant-aware field policy resolution',
    });

    const tenantCollection = await usersModule.TenantCollection.create(options);
    return {
      async getChain(tenantId: string): Promise<FieldPolicyTenantNode[]> {
        const tenant = await tenantCollection.get({ id: tenantId });
        if (!tenant) {
          return [];
        }

        const ancestors = await tenantCollection.getAncestorsFromRoot(tenantId);
        return [...ancestors, tenant].map((node) => ({
          id: String(node.id),
          inheritPermissions: Boolean(node.inheritPermissions),
          cascadePermissions: Boolean(node.cascadePermissions),
        }));
      },
    };
  } catch (error) {
    if (isMissingUsersDependency(error)) {
      return null;
    }
    throw error;
  }
}

/** Node's missing-module message shapes, capturing the quoted specifier. */
const MISSING_MODULE_TARGET_PATTERN =
  /Cannot find (?:package|module) '([^']+)'/;

/** Whether a missing-module TARGET specifier is smrt-users (or a subpath). */
function isUsersSpecifier(target: string): boolean {
  return (
    target === '@happyvertical/smrt-users' ||
    target.startsWith('@happyvertical/smrt-users/')
  );
}

/**
 * Whether an import failure means `@happyvertical/smrt-users` is simply not
 * installed (→ flat-tenant fallback) rather than installed-but-broken
 * (→ rethrow, surfacing the problem instead of silently losing ancestor
 * locks/defaults).
 *
 * The decision is made on the missing-module TARGET parsed from Node's
 * `Cannot find package/module '<specifier>'` message (walking the full
 * `cause` chain): only a target that IS smrt-users (or one of its subpaths)
 * counts. A transitive failure INSIDE an installed smrt-users names the
 * other package as the target — with the users path merely appearing as the
 * importer — and therefore rethrows. `importWorkspaceModule`'s own
 * source-fallback wrapper ("Failed to load @happyvertical/smrt-users for
 * ...") is also accepted: it is thrown only when the users package itself
 * cannot be located.
 *
 * Exported for direct testing; not re-exported from the package index.
 */
export function isMissingUsersDependency(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);

    const match = current.message.match(MISSING_MODULE_TARGET_PATTERN);
    if (match && isUsersSpecifier(match[1])) {
      return true;
    }

    if (
      current.message.includes('Failed to load @happyvertical/smrt-users for')
    ) {
      return true;
    }

    current = current.cause;
  }

  return false;
}
