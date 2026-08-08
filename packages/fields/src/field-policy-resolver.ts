import { importWorkspaceModule } from '@happyvertical/smrt-core/utils/import-workspace-module';
import {
  assertTenantReadAllowed,
  getCurrentTenant,
  isSuperAdminBypass,
  TenantIsolationError,
} from '@happyvertical/smrt-tenancy';
import { getCachedFieldPolicy, setCachedFieldPolicy } from './cache.js';
import { FieldPolicyCollection } from './collections/FieldPolicyCollection.js';
import {
  buildCodeSeedDelta,
  buildCodeSeedVisibility,
  type FieldDefinitionMap,
  getCodeSeedGroup,
  getObjectFieldMap,
  isRequiredField,
  isUsableRequiredDefault,
} from './field-definitions.js';
import type { FieldPolicy } from './models/FieldPolicy.js';
import type {
  ExplainedObjectFieldPolicy,
  FieldPolicyDelta,
  FieldPolicyLayerContribution,
  FieldPolicyTenantHierarchyProvider,
  FieldPolicyTenantNode,
  FieldPolicyUsersModule,
  FieldPolicyVisibility,
  ResolvedFieldPolicy,
  ResolvedObjectFieldPolicy,
  ResolveFieldPolicyOptions,
  SmrtClassOptions,
} from './types.js';

/** Accumulated merge state for one field while layers apply. */
interface MergedPolicyState {
  default?: { value: unknown };
  visibility: FieldPolicyVisibility;
  help?: string;
  label?: string;
  order?: number;
  locked?: boolean;
}

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

  const hasExcludedRows = (options.excludePolicyIds?.size ?? 0) > 0;
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

  const policyFields = selectPolicyAddressableFields(fieldMap);
  const codeVisibility = buildCodeSeedVisibility(fieldMap);

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

  const fields: Record<string, ResolvedFieldPolicy> = {};
  const layers: Record<string, FieldPolicyLayerContribution[]> = {};

  for (const [fieldName, fieldDef] of policyFields) {
    const contributions: FieldPolicyLayerContribution[] = [];

    const codeDelta = buildCodeSeedDelta(
      fieldDef,
      codeVisibility.get(fieldName) ?? 'basic',
    );
    contributions.push({ layer: 'code', delta: codeDelta });

    let state: MergedPolicyState = applyDelta(
      { visibility: 'basic' },
      codeDelta,
    );

    const appRow = appRows.get(fieldName);
    if (appRow && !options.excludePolicyIds?.has(String(appRow.id))) {
      const delta = rowToDelta(appRow);
      contributions.push({ layer: 'app', delta });
      state = applyDelta(state, delta);
    }

    // Tenant chain walk, root → leaf, over the surviving suffix only (nodes
    // before the last permission-inheritance break contribute nothing — see
    // selectSurvivingChainSuffix). Equivalent to smrt-features' baseline
    // walk, but the explained contributions never list discarded ancestors.
    for (const node of survivingChain) {
      const row = tenantRows.get(node.id)?.get(fieldName);
      if (row && !options.excludePolicyIds?.has(String(row.id))) {
        const delta = rowToDelta(row);
        contributions.push({ layer: 'tenant', tenantId: node.id, delta });
        state = applyDelta(state, delta);
      }
    }

    // Org lock: when the code/app/tenant tiers resolve locked, the user tier
    // is skipped entirely — a stale user row cannot bypass a later lock.
    const orgLocked = state.locked === true;
    const userRow = userId ? userRows.get(fieldName) : undefined;
    if (
      userRow &&
      !options.excludePolicyIds?.has(String(userRow.id)) &&
      !orgLocked
    ) {
      const delta = rowToDelta(userRow);
      contributions.push({ layer: 'user', userId: userId as string, delta });
      state = applyDelta(state, delta);
    }

    // Resolver-side required-field safety net: a required field with no
    // usable resolved default is ALWAYS visible, regardless of stored
    // visibility — write-time enforcement alone breaks when a DIFFERENT row's
    // deletion removes the default a demotion relied on.
    const required = isRequiredField(fieldDef);
    let visibilityForced = false;
    if (
      required &&
      !isUsableRequiredDefault(state.default) &&
      state.visibility !== 'basic'
    ) {
      state = { ...state, visibility: 'basic' };
      visibilityForced = true;
    }

    fields[fieldName] = {
      fieldName,
      hasDefault: state.default !== undefined,
      defaultValue: state.default?.value,
      visibility: state.visibility,
      help: state.help ?? null,
      label: state.label ?? null,
      order: state.order ?? null,
      group: getCodeSeedGroup(fieldDef),
      locked: state.locked === true,
      required,
      ...(visibilityForced ? { visibilityForced: true } : {}),
    };
    layers[fieldName] = contributions;
  }

  const explained: ExplainedObjectFieldPolicy = { objectRef, fields, layers };
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
 * Fields that participate in policy resolution: everything except injected
 * framework system fields, relationship pseudo-fields, and STI meta
 * internals (matching the exclusions of the generated web field definitions).
 */
function selectPolicyAddressableFields(
  fieldMap: FieldDefinitionMap,
): FieldDefinitionMap {
  const selected: FieldDefinitionMap = new Map();
  for (const [name, field] of fieldMap) {
    if (field._meta?.__smrtSystemField === true) {
      continue;
    }
    if (
      field.type === 'oneToMany' ||
      field.type === 'manyToMany' ||
      field.type === 'meta'
    ) {
      continue;
    }
    selected.set(name, field);
  }
  return selected;
}

/** A stored row's sparse contribution (NULL columns contribute nothing). */
function rowToDelta(row: FieldPolicy): FieldPolicyDelta {
  const delta: FieldPolicyDelta = {};

  if (row.defaultValue !== null && row.defaultValue !== undefined) {
    try {
      delta.default = { value: JSON.parse(row.defaultValue) };
    } catch {
      // Unparseable stored JSON (should be prevented by save-time validation)
      // contributes nothing rather than poisoning resolution.
    }
  }
  if (row.visibility !== null && row.visibility !== undefined) {
    delta.visibility = row.visibility;
  }
  if (row.help !== null && row.help !== undefined) {
    delta.help = row.help;
  }
  if (row.label !== null && row.label !== undefined) {
    delta.label = row.label;
  }
  if (row.displayOrder !== null && row.displayOrder !== undefined) {
    delta.order = row.displayOrder;
  }
  if (row.locked !== null && row.locked !== undefined) {
    delta.locked = row.locked;
  }

  return delta;
}

function applyDelta(
  state: MergedPolicyState,
  delta: FieldPolicyDelta,
): MergedPolicyState {
  return {
    default: delta.default ?? state.default,
    visibility: delta.visibility ?? state.visibility,
    help: delta.help ?? state.help,
    label: delta.label ?? state.label,
    order: delta.order ?? state.order,
    locked: delta.locked ?? state.locked,
  };
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
    const usersModule = await importWorkspaceModule<FieldPolicyUsersModule>({
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
