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

  const cached = getCachedFieldPolicy(objectRef, tenantId, userId, cacheDb);
  if (cached) {
    return cached;
  }

  const policyFields = selectPolicyAddressableFields(fieldMap);
  const codeVisibility = buildCodeSeedVisibility(fieldMap);

  const appRows = collection
    ? await collection.getAppRows(objectRef)
    : new Map<string, FieldPolicy>();

  let chain: FieldPolicyTenantNode[] = [];
  let tenantRows = new Map<string, Map<string, FieldPolicy>>();
  if (collection && tenantId) {
    chain = await resolveTenantChain(tenantId, options);
    tenantRows = await collection.getTenantRows(
      objectRef,
      chain.map((node) => node.id),
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
    if (appRow) {
      const delta = rowToDelta(appRow);
      contributions.push({ layer: 'app', delta });
      state = applyDelta(state, delta);
    }

    // Tenant chain walk, root → leaf, mirroring smrt-features: a node only
    // inherits the accumulated tenant-layer state when its parent cascades
    // permissions and it accepts them; otherwise its baseline resets to the
    // app-layer state.
    const appLayerState = state;
    let accumulated = appLayerState;
    for (let index = 0; index < chain.length; index++) {
      const current = chain[index];
      const previous = index > 0 ? chain[index - 1] : null;
      const shouldInherit =
        index === 0 ||
        (!!previous?.cascadePermissions && current.inheritPermissions);
      const baseline = shouldInherit ? accumulated : appLayerState;

      const row = tenantRows.get(current.id)?.get(fieldName);
      if (row) {
        const delta = rowToDelta(row);
        contributions.push({ layer: 'tenant', tenantId: current.id, delta });
        accumulated = applyDelta(baseline, delta);
      } else {
        accumulated = baseline;
      }
    }
    state = accumulated;

    // Org lock: when the code/app/tenant tiers resolve locked, the user tier
    // is skipped entirely — a stale user row cannot bypass a later lock.
    const orgLocked = state.locked === true;
    const userRow = userId ? userRows.get(fieldName) : undefined;
    if (userRow && !orgLocked) {
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
  setCachedFieldPolicy(objectRef, tenantId, userId, cacheDb, explained);
  return explained;
}

/**
 * Fail-closed isolation guard: an active non-bypass tenant context may only
 * resolve its own tenant (and, when the context carries a user id, its own
 * user). App-only resolution (`tenantId` null) is always allowed — app rows
 * are global data.
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
  if (
    context &&
    !isSuperAdminBypass() &&
    context.userId !== undefined &&
    context.userId !== userId
  ) {
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

function isMissingUsersDependency(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const causeMessage =
    error.cause instanceof Error ? ` ${error.cause.message}` : '';
  const text = `${error.message}${causeMessage}`;

  return (
    text.includes('@happyvertical/smrt-users') &&
    (text.includes('Cannot find module') ||
      text.includes('Failed to load') ||
      text.includes('could not find'))
  );
}
