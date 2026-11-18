/**
 * SvelteKit generator for the sync-apply batch write route (#1759).
 *
 * Emits ONE route — `{routesDir}/sync/apply/+server.ts` — implementing the
 * shared web/mobile write contract for every syncable model in the manifest
 * (models whose API config exposes at least one of create/update/delete). The
 * generated file is deliberately thin: it maps `object` segments to
 * collections plus per-model policy data, and delegates all batch processing
 * to `processSyncApplyBatch` from `@happyvertical/smrt-core` — the same
 * engine the runtime REST generator uses, so the two transports cannot drift.
 *
 * This lives in its own module (rather than sveltekit-generator.ts) so the
 * shared generator file only needs a one-line registration hook; sibling
 * work (#1757, #1758) touches the same generator files in parallel.
 *
 * Contract documentation: docs/content/architecture/sync-apply-contract.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFrameworkBaseClass } from '../registry/framework-base-classes.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';
import {
  collectRouteReadonlyFields,
  generateTenantContextHelper,
  getApiPublicAccess,
  getApiWritableAllowlist,
  resolvePermissionCollection,
  usesPrincipalContext,
} from './route-policy.js';
import { generateCollectionAccessImports } from './sveltekit-config-import.js';
import type { SvelteKitOptions } from './sveltekit-generator.js';
import {
  compareText,
  findManifestObjectByName,
  isCollectionManifestClass,
  isStiChildModel,
  orderedManifestObjectEntries,
} from './web-collections.js';

const MUTATING_ACTIONS = ['create', 'update', 'delete'] as const;

type MutatingAction = (typeof MUTATING_ACTIONS)[number];

/** Per-model data embedded into the generated route. */
interface SyncTargetSpec {
  segment: string;
  /**
   * The manifest registry key, passed VERBATIM to `getCollection()` exactly
   * as the generated CRUD routes do. May be package-qualified
   * (`@happyvertical/smrt-ledgers:Account`) — collapsing it to a simple class
   * name would resolve ambiguously when two loaded packages declare the same
   * simple name.
   */
  registryKey: string;
  replacedQualifiedNames?: string[];
  /**
   * `<collection>` prefix of the `<collection>.<action>` operation permission
   * the mirrored generated write routes require (#2977) — the same
   * `decoratorConfig.collection ?? collection` resolution as
   * sveltekit-generator.ts `resolvePermissionCollection`.
   */
  permissionCollection: string;
  ops: MutatingAction[];
  readonlyFields: string[];
  writableAllowlist: string[] | null;
  publicAccess: boolean | 'read';
  tenantScoped: boolean;
  /** `api.principalContext`: writes need a complete principal. */
  principalContext: boolean;
}

/**
 * Mirror of web-collections.ts `resolveStandardCrudActions`, narrowed to
 * the mutating subset the sync contract can carry. Kept local so this module
 * needs no exports added to the (parallel-edited) shared generator file.
 */
function resolveMutatingActions(apiConfig: unknown): MutatingAction[] {
  if (apiConfig === false) return [];
  if (
    apiConfig === true ||
    apiConfig === undefined ||
    typeof apiConfig !== 'object'
  ) {
    return [...MUTATING_ACTIONS];
  }

  const config = apiConfig as { include?: string[]; exclude?: string[] };
  let actions: MutatingAction[] = Array.isArray(config.include)
    ? MUTATING_ACTIONS.filter((action) => config.include?.includes(action))
    : [...MUTATING_ACTIONS];
  if (Array.isArray(config.exclude)) {
    const excluded = config.exclude;
    actions = actions.filter((action) => !excluded.includes(action));
  }
  return actions;
}

/**
 * True when an ancestor sharing `objectDef`'s collection (its STI base) is in
 * the manifest with its API enabled. Such a base owns the segment.
 */
function hasApiEnabledStiBase(
  manifest: SmartObjectManifest,
  objectDef: SmartObjectDefinition,
): boolean {
  const seen = new Set<string>();
  let child = objectDef;
  let parentName = child.extendsQualified || child.extends;
  while (parentName && !seen.has(parentName)) {
    seen.add(parentName);
    const parent = findManifestObjectByName(manifest, parentName, child);
    if (!parent || parent.collection !== objectDef.collection) return false;
    if (
      parent.decoratorConfig?.api !== false &&
      !isFrameworkBaseClass(parent.className, parent.packageName)
    ) {
      return true;
    }
    child = parent;
    parentName = parent.extendsQualified || parent.extends;
  }
  return false;
}

/**
 * Collect the syncable targets from a manifest: non-collection objects whose
 * API config is enabled and exposes at least one mutating action.
 *
 * `SYNC_TARGETS` is keyed by segment, so exactly ONE model owns each segment
 * (#2807). Several models can share a `collection` (an STI family, or two
 * unrelated models); emitting one entry per model made the generated object
 * literal's last duplicate key win, i.e. manifest scan order. The owner uses
 * the tie rule of the web collection definitions (`selectWebCollectionEntries`)
 * over models that expose a mutating op: the STI base model beats its
 * children, and otherwise the first candidate in deterministic
 * qualified-identity order ({@link orderedManifestObjectEntries}) wins.
 *
 * An STI child never owns a segment whose API-enabled base shares it, even
 * when that base exposes no mutating op: the base's (narrower) policy decides,
 * so the segment then has no sync target (fail closed). Candidate sets differ
 * from the web selector's (`list`) and from CRUD route emission (last writer
 * per route file, #2754), so with unrelated models sharing a segment the sync
 * owner can differ from those owners; it is deterministic either way.
 */
export function collectSyncApplyTargets(
  manifest: SmartObjectManifest,
): SyncTargetSpec[] {
  const bySegment = new Map<
    string,
    { target: SyncTargetSpec; isStiChild: boolean }
  >();

  for (const [className, objectDef] of orderedManifestObjectEntries(manifest)) {
    if (isCollectionManifestClass(manifest, objectDef)) continue;
    // The framework's own abstract base classes are scaffolding, not
    // resources — never make them a sync-apply target, regardless of
    // config (#2642).
    if (isFrameworkBaseClass(objectDef.className, objectDef.packageName)) {
      continue;
    }

    const apiConfig = objectDef.decoratorConfig?.api;
    if (apiConfig === false) continue;

    if (!objectDef.collection) continue;
    if (hasApiEnabledStiBase(manifest, objectDef)) continue;

    const ops = resolveMutatingActions(apiConfig);
    if (ops.length === 0) continue;

    const isStiChild = isStiChildModel(manifest, objectDef);
    const existing = bySegment.get(objectDef.collection);
    if (existing && !(existing.isStiChild && !isStiChild)) continue;

    const target: SyncTargetSpec = {
      segment: objectDef.collection,
      registryKey: className,
      replacedQualifiedNames: Object.entries(manifest.objects)
        .filter(([, entry]) => entry.replacedBy === className)
        .map(([key]) => key),
      permissionCollection: resolvePermissionCollection(objectDef),
      ops,
      // The same policy functions the model's CRUD routes are generated
      // from (`route-policy.ts`), so the two routes cannot disagree.
      readonlyFields: collectRouteReadonlyFields(objectDef),
      writableAllowlist: getApiWritableAllowlist(apiConfig),
      publicAccess: getApiPublicAccess(apiConfig),
      tenantScoped: !!objectDef.decoratorConfig?.tenantScoped,
      principalContext: usesPrincipalContext(objectDef),
    };
    bySegment.set(objectDef.collection, { target, isStiChild });
  }

  return [...bySegment.values()]
    .map(({ target }) => target)
    .sort((a, b) => compareText(a.segment, b.segment));
}

function serializeTargets(targets: SyncTargetSpec[]): string {
  const entries = targets.map((target) => {
    const fields = [
      `registryKey: ${JSON.stringify(target.registryKey)}`,
      `replacedQualifiedNames: ${JSON.stringify(target.replacedQualifiedNames ?? [])}`,
      `permissionCollection: ${JSON.stringify(target.permissionCollection)}`,
      `ops: ${JSON.stringify(target.ops)}`,
      `readonlyFields: ${JSON.stringify(target.readonlyFields)}`,
      `writableAllowlist: ${JSON.stringify(target.writableAllowlist)}`,
      `publicAccess: ${JSON.stringify(target.publicAccess)}`,
      `tenantScoped: ${JSON.stringify(target.tenantScoped)}`,
      `principalContext: ${JSON.stringify(target.principalContext)}`,
    ];
    return `  ${JSON.stringify(target.segment)}: {\n    ${fields.join(',\n    ')},\n  },`;
  });
  return `{\n${entries.join('\n')}\n}`;
}

/**
 * Render the generated `+server.ts` content for the sync-apply route.
 * Exported for tests.
 */
export function generateSyncApplyRouteTemplate(
  targets: SyncTargetSpec[],
  collectionAccessImports: string,
): string {
  const anyTenantScoped = targets.some((target) => target.tenantScoped);
  const needsTenantContext = targets.some(
    (target) => target.tenantScoped || target.principalContext,
  );

  // The tenant and principal helper of the generated CRUD routes, emitted by
  // the same generator function. One route serves many models here, so the
  // principal requirement is passed per item instead of baked in.
  const tenantHelper = needsTenantContext
    ? generateTenantContextHelper('per-target', anyTenantScoped)
    : '';

  return `${AUTO_GENERATED_ROUTE_HEADER}
// DO NOT EDIT - changes will be overwritten
//
// Idempotent sync-apply batch write contract (#1759) — the shared write path
// for the web offline outbox (#1762) and the KMP mobile write queue (#1739).
// Contract: docs/content/architecture/sync-apply-contract.md

import {
  applySyncWritablePolicy,
  processSyncApplyBatch,
  type SyncApplyOp,
  type SyncApplyTarget,
} from '@happyvertical/smrt-core';
import { applyUpdateInput, isRuntimeModelEnabled, ObjectRegistry } from '@happyvertical/smrt-core';
import { ${needsTenantContext ? 'error, ' : ''}json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
${collectionAccessImports}

// Fail-closed authorization (#1540): sync mutations require an authenticated
// principal on \`locals\` unless the target model is \`api: { public: true }\`.
function hasAuthenticatedPrincipal(locals: unknown): boolean {
  if (!locals || typeof locals !== 'object') return false;
  const l = locals as Record<string, unknown>;
  const isResolvedPrincipal = (v: unknown) =>
    typeof v === 'object' && v !== null;
  return (
    isResolvedPrincipal(l.user) ||
    isResolvedPrincipal(l.session) ||
    l.smrtAuth === true
  );
}
${tenantHelper}
interface SyncTargetConfig {
  /** Manifest registry key (may be package-qualified), as CRUD routes use. */
  registryKey: string;
  replacedQualifiedNames?: string[];
  /** \`<collection>\` prefix of the required \`<collection>.<op>\` permission. */
  permissionCollection: string;
  ops: SyncApplyOp[];
  readonlyFields: string[];
  writableAllowlist: string[] | null;
  publicAccess: boolean | 'read';
  /** The model is tenant-scoped: a write needs a tenant. */
  tenantScoped: boolean;
  /** \`api.principalContext\`: a write needs a complete principal. */
  principalContext: boolean;
}

// One entry per syncable model, keyed by the collection route segment its
// generated CRUD routes use.
const SYNC_TARGETS: Record<string, SyncTargetConfig> = ${serializeTargets(targets)};

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function hasGrantedPermission(value: unknown, permission: string): boolean {
  if (Array.isArray(value)) return value.includes(permission);
  if (value instanceof Set) return value.has(permission);
  return false;
}

// Fail-closed operation permission (#2977, #3011): each applied op requires
// the same \`<collection>.<op>\` permission the mirrored generated write route
// enforces, read from the principal's session permission snapshot. A missing
// snapshot denies; only an explicit tenancy super-admin bypass skips it.
function hasOperationPermission(
  locals: unknown,
  permissionCollection: string,
  op: SyncApplyOp,
): boolean {
  const l = readRecord(locals);
  const tenantContext = readRecord(l.tenantContext);
  if (tenantContext.superAdminBypass === true) return true;
  const permission = \`\${permissionCollection}.\${op}\`;
  return (
    hasGrantedPermission(l.permissions, permission) ||
    hasGrantedPermission(l.permissionSet, permission) ||
    hasGrantedPermission(l.smrtPermissions, permission) ||
    hasGrantedPermission(tenantContext.permissions, permission)
  );
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const authenticated = hasAuthenticatedPrincipal(locals);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      { error: { code: 'invalid_batch', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  const outcome = await processSyncApplyBatch(body, {
    resolveTarget: async (segment: string): Promise<SyncApplyTarget | null> => {
      const target = SYNC_TARGETS[segment];
      if (!target) return null;
      const context = locals as { tenantId?: unknown; tenantContext?: unknown };
      const nested = context.tenantContext && typeof context.tenantContext === 'object' ? context.tenantContext as Record<string, unknown> : {};
      const tenant = context.tenantId ?? nested.tenantId;
      if (!isRuntimeModelEnabled({ qualifiedName: target.registryKey, replacedQualifiedNames: target.replacedQualifiedNames }, { surface: 'rest', locals, tenantId: typeof tenant === 'string' ? tenant : undefined })) return null;
      // The verbatim manifest key, exactly as the generated CRUD routes pass
      // it — package-qualified keys stay qualified so same-simple-name
      // classes across packages resolve unambiguously.
      const collection = await getCollection(target.registryKey);
      return {
        objectName: target.registryKey,
        collection,
        mutate: async (row, op, data) => {
          await collection.withAuditMutation(row as import('@happyvertical/smrt-core').SmrtObject, op === 'update' ? 'updated' : 'deleted', async (bound) => {
            if (op === 'update') {
              // A payload sets declared fields and settable accessors only.
              applyUpdateInput(bound, data, target.registryKey);
              await bound.save();
            } else {
              await bound.delete({ expectedUpdatedAt: bound.updated_at ?? undefined });
            }
          });
        },
        isOpAllowed: (op: SyncApplyOp) => target.ops.includes(op),
        authorize: (op: SyncApplyOp) => {
          // \`public: true\` keeps its unauthenticated write semantics, as on
          // the generated CRUD routes.
          if (target.publicAccess !== true) {
            if (!authenticated) return 'auth_required' as const;
            if (!hasOperationPermission(locals, target.permissionCollection, op)) {
              return 'forbidden' as const;
            }
          }
${
  needsTenantContext
    ? `          // The same order as the generated CRUD route: after auth and the
          // operation permission, enter the principal's tenant, then require
          // one for a tenant-scoped model.
          if (target.tenantScoped || target.principalContext) {
            try {
              establishTenantContext(locals, target.principalContext);
            } catch {
              return 'forbidden' as const;
            }
${
  anyTenantScoped
    ? `            if (target.tenantScoped && !hasTenantWriteContext(locals)) {
              return authenticated ? ('forbidden' as const) : ('auth_required' as const);
            }
`
    : ''
}          }
`
    : ''
}          return 'ok' as const;
        },
        prepare: (payload: Record<string, unknown>) =>
          applySyncWritablePolicy(payload, {
            readonlyFields: target.readonlyFields,
            writableAllowlist: target.writableAllowlist,
            // A payload sets fields only, never a service of the object.
            isServiceOptionInput: (key: string) =>
              ObjectRegistry.isServiceOptionInput(target.registryKey, key),
          }),
      };
    },
  });

  return json(outcome.body, { status: outcome.status });
};
`;
}

/**
 * Generate `{routesDir}/sync/apply/+server.ts` for the manifest's syncable
 * models. Returns true when a route was written. Skips generation (with a
 * warning) if a non-generated file already occupies the path, and writes
 * nothing when the manifest has no syncable models.
 */
export function generateSyncApplyRoute(
  projectRoot: string,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
): boolean {
  const targets = collectSyncApplyTargets(manifest);
  if (targets.length === 0) {
    return false;
  }

  const routeDir = join(projectRoot, options.routesDir, 'sync', 'apply');
  const routePath = join(routeDir, '+server.ts');

  if (existsSync(routePath)) {
    const existing = readFileSync(routePath, 'utf-8');
    if (!existing.startsWith(AUTO_GENERATED_ROUTE_HEADER)) {
      console.warn(
        `[smrt] Skipping sync-apply route - ${routePath} exists and is not generated`,
      );
      return false;
    }
  }

  if (!existsSync(routeDir)) {
    mkdirSync(routeDir, { recursive: true });
  }

  writeFileSync(
    routePath,
    generateSyncApplyRouteTemplate(
      targets,
      generateCollectionAccessImports(projectRoot, routeDir, options, [
        'getCollection',
      ]),
    ),
    'utf-8',
  );
  console.log(`[smrt] Generated: ${routePath}`);
  return true;
}
