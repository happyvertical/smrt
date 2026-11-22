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

import { join } from 'node:path';
import { resolvePermissionCollection } from '../permission-collection.js';
import { isFrameworkBaseClass } from '../registry/framework-base-classes.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types';
import type { RouteFilePlan } from './generated-route-files.js';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';
import { getApiPublicAccess, usesPrincipalContext } from './route-policy.js';
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
  publicAccess: boolean | 'read';
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
      // from (`route-policy.ts`), so the two routes cannot disagree. The
      // write policy (read-only fields, `api.writable`) is read at run time
      // by `prepareWriteInput`, as the CRUD routes read it.
      publicAccess: getApiPublicAccess(apiConfig),
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
      `publicAccess: ${JSON.stringify(target.publicAccess)}`,
      `principalContext: ${JSON.stringify(target.principalContext)}`,
    ];
    return `  ${JSON.stringify(target.segment)}: {\n    ${fields.join(',\n    ')},\n  },`;
  });
  return `{\n${entries.join('\n')}\n}`;
}

/**
 * The registry keys of the models a manifest generates, when it declares an
 * STI family with members: a sync item through a family base serves only
 * those members (#5375), never one registered elsewhere. `undefined` when no
 * family has members, so the route then carries no model list.
 */
export function syncModelScope(
  manifest: SmartObjectManifest,
): string[] | undefined {
  const models = orderedManifestObjectEntries(manifest).filter(
    ([, objectDef]) => !isCollectionManifestClass(manifest, objectDef),
  );
  const hasStiAncestor = (objectDef: SmartObjectDefinition): boolean => {
    // A singleton STI base is a family too: it must exclude later subtypes.
    if (objectDef.decoratorConfig?.tableStrategy === 'sti') return true;
    const seen = new Set<string>();
    let child = objectDef;
    let parentName = child.extendsQualified || child.extends;
    while (parentName && !seen.has(parentName)) {
      seen.add(parentName);
      const parent = findManifestObjectByName(manifest, parentName, child);
      if (!parent) return false;
      if (parent.decoratorConfig?.tableStrategy === 'sti') return true;
      child = parent;
      parentName = parent.extendsQualified || parent.extends;
    }
    return false;
  };
  if (!models.some(([, objectDef]) => hasStiAncestor(objectDef))) {
    return undefined;
  }
  return models
    .map(
      ([key, objectDef]) =>
        objectDef.qualifiedName ??
        (objectDef.packageName
          ? `${objectDef.packageName}:${objectDef.className}`
          : objectDef.className || key),
    )
    .sort(compareText);
}

/**
 * Render the generated `+server.ts` content for the sync-apply route.
 * Exported for tests.
 *
 * @param modelScope - Registry keys of the models the manifest generates
 *   ({@link syncModelScope}), when it declares an STI family with members
 */
export function generateSyncApplyRouteTemplate(
  targets: SyncTargetSpec[],
  collectionAccessImports: string,
  modelScope?: readonly string[],
): string {
  const scopeConstant = modelScope
    ? `\n// The models this manifest generates: a sync item through an STI base\n// serves only these members of its family.\nconst SYNC_MODEL_SCOPE: ReadonlySet<string> = new Set(${JSON.stringify(modelScope)});\n`
    : '';
  return `${AUTO_GENERATED_ROUTE_HEADER}
// DO NOT EDIT - changes will be overwritten
//
// Idempotent sync-apply batch write contract (#1759) — the shared write path
// for the web offline outbox (#1762) and the KMP mobile write queue (#1739).
// Contract: docs/content/architecture/sync-apply-contract.md

import {
  prepareWriteInput,
  processSyncApplyBatch,
  type SyncApplyOp,
  SyncApplyRejection,
  type SyncApplyTarget,
} from '@happyvertical/smrt-core';
import { applyUpdateInput, assertCreateInput, assertUpdateInput, getRequestTenantContext as getCurrentTenant, isRuntimeModelEnabled, ObjectRegistry, runInRequestTenancy } from '@happyvertical/smrt-core';
import { error, json } from '@sveltejs/kit';
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

interface SyncTargetConfig {
  /** Manifest registry key (may be package-qualified), as CRUD routes use. */
  registryKey: string;
  replacedQualifiedNames?: string[];
  /** \`<collection>\` prefix of the required \`<collection>.<op>\` permission. */
  permissionCollection: string;
  ops: SyncApplyOp[];
  publicAccess: boolean | 'read';
  /** \`api.principalContext\`: a write needs a complete principal. */
  principalContext: boolean;
}

// One entry per syncable model, keyed by the collection route segment its
// generated CRUD routes use.
const SYNC_TARGETS: Record<string, SyncTargetConfig> = ${serializeTargets(targets)};
${scopeConstant}
function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

// The tenant the request acts for, from the same \`locals\` sources the
// tenant helper enters (\`tenantId\`, \`user\`, \`session\`, \`tenantContext\`),
// else the tenant context active for the request (entered by the host, or by
// the tenant helper for this item).
function requestTenantOf(locals: unknown): string | undefined {
  const l = readRecord(locals);
  const tenant =
    l.tenantId ??
    readRecord(l.user).tenantId ??
    readRecord(l.session).tenantId ??
    readRecord(l.tenantContext).tenantId;
  if (typeof tenant === 'string' && tenant) return tenant;
  const active = readRecord(getCurrentTenant()).tenantId;
  return typeof active === 'string' && active ? active : undefined;
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
      // The verbatim manifest key, exactly as the generated CRUD routes pass
      // it — package-qualified keys stay qualified so same-simple-name
      // classes across packages resolve unambiguously.
      const collection = await getCollection(target.registryKey);
      return {
        objectName: target.registryKey,
        collection,
        // After the item was authorized, as on the CRUD routes: a model the
        // runtime exposure gate closes for the request's tenant is unknown.
        // Each item then runs inside the tenancy its model has now (#5375),
        // whatever the manifest declared: the actor from \`locals\` (or the
        // tenant the host entered), a write gate, and the decision bound for
        // the item's lookup and write. A refusal rejects the item.
        run: async (op, apply) => {
          if (!isRuntimeModelEnabled({ qualifiedName: target.registryKey, replacedQualifiedNames: target.replacedQualifiedNames }, { surface: 'rest', locals, tenantId: requestTenantOf(locals) })) {
            throw new SyncApplyRejection('unknown_object');
          }
          return runInRequestTenancy(
            { model: target.registryKey, operation: op, locals, requirePrincipal: target.principalContext${modelScope ? ', modelScope: SYNC_MODEL_SCOPE' : ''} },
            () => apply(),
          );
        },
        // A payload is checked against the row before replay or staleness.
        assertUpdate: (row, data) => assertUpdateInput(row, data, target.registryKey),
        assertCreate: (data) => assertCreateInput(target.registryKey, data, collection),
        // A sync create writes the target's own type: on an STI target a
        // payload selecting another type is rejected, never written as this one.
        acceptsCreateType: (payload: Record<string, unknown>) =>
          ObjectRegistry.getTableStrategy(target.registryKey) !== 'sti' ||
          ['createType', '_meta_type'].every((selector) => payload[selector] === undefined || payload[selector] === target.registryKey),
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
          return 'ok' as const;
        },
        // The write-input rule of the CRUD routes: server-managed keys and
        // service options are skipped, and a field the caller may not write
        // is refused when the payload would change the stored value.
        prepare: (payload: Record<string, unknown>, stored) =>
          prepareWriteInput(target.registryKey, payload, stored),
      };
    },
  });

  return json(outcome.body, { status: outcome.status });
};
`;
}

/**
 * Plan `{routesDir}/sync/apply/+server.ts` for the manifest's syncable
 * models. Returns true when a route was emitted into `plan`, and emits
 * nothing when the manifest has no syncable models. The route yields: when it
 * is the only claimant of its path and an application `+server.ts` or
 * `+server.js` occupies it, the preflight leaves that handler in place (with
 * a warning) and nothing is written.
 */
export function generateSyncApplyRoute(
  projectRoot: string,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
  plan: RouteFilePlan,
): boolean {
  const targets = collectSyncApplyTargets(manifest);
  if (targets.length === 0) {
    return false;
  }

  const routeDir = join(projectRoot, options.routesDir, 'sync', 'apply');
  plan.emit({
    root: join(projectRoot, options.routesDir),
    routeDir,
    content: generateSyncApplyRouteTemplate(
      targets,
      generateCollectionAccessImports(projectRoot, routeDir, options, [
        'getCollection',
      ]),
      syncModelScope(manifest),
    ),
    label: 'sync/apply',
    policy: 'yield',
    onYield: (routePath) =>
      console.warn(
        `[smrt] Skipping sync-apply route - ${routePath} exists and is not generated`,
      ),
  });
  return true;
}
