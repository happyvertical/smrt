import type { AsyncLocalStorage } from 'node:async_hooks';
import {
  GlobalInterceptors,
  type InterceptorContext,
  ObjectRegistry,
  resolveGetStringFilter,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import type { AssetCollection } from './assets';

/** Trusted server capability. Never construct this from an untrusted API payload. */
export interface PrivateAssetAccess {
  tenantId: string;
  actorUserId: string;
  ownerProfileId: string;
  assetIds: readonly string[];
}
interface Scope extends PrivateAssetAccess {
  active: boolean;
}
const KEY = Symbol.for('smrt:private-asset-access');
const root = globalThis as typeof globalThis & {
  [KEY]?: AsyncLocalStorage<Scope>;
};
function scopeStorage(): AsyncLocalStorage<Scope> | undefined {
  if (root[KEY]) return root[KEY];
  if (typeof process === 'undefined' || !process.getBuiltinModule)
    return undefined;
  const { AsyncLocalStorage } = process.getBuiltinModule('node:async_hooks');
  root[KEY] = new AsyncLocalStorage<Scope>();
  return root[KEY];
}

function currentScope(): Scope | undefined {
  const scope = scopeStorage()?.getStore();
  if (!scope) return undefined;
  const actor = getCurrentTenant();
  if (
    !scope.active ||
    actor?.tenantId !== scope.tenantId ||
    actor.userId !== scope.actorUserId
  )
    throw new Error(
      'Private asset capability is closed or actor identity changed',
    );
  return scope;
}

/**
 * Run an already-authorized operation on exact private asset IDs. The host must
 * authorize the relationship first; this capability does not grant permissions.
 * Nested capabilities may only narrow their parent's IDs and retain its owner.
 */
export async function withPrivateAssetAccess<T>(
  access: PrivateAssetAccess,
  callback: () => Promise<T>,
): Promise<T> {
  const storage = scopeStorage();
  if (!storage)
    throw new Error('Private asset capabilities require a Node server');
  const actor = getCurrentTenant();
  if (
    !access.tenantId ||
    !access.actorUserId ||
    !access.ownerProfileId ||
    !access.assetIds.length ||
    access.assetIds.some((id) => !id) ||
    actor?.tenantId !== access.tenantId ||
    actor.userId !== access.actorUserId
  )
    throw new Error(
      'Private asset capability requires an exact authenticated actor and asset IDs',
    );
  const parent = currentScope();
  if (
    parent &&
    (parent.ownerProfileId !== access.ownerProfileId ||
      access.assetIds.some((id) => !parent.assetIds.includes(id)))
  )
    throw new Error('Nested private asset capability cannot widen access');
  const scope: Scope = {
    ...access,
    assetIds: [...access.assetIds],
    active: true,
  };
  return storage.run(scope, async () => {
    try {
      return await callback();
    } finally {
      scope.active = false;
    }
  });
}

function applies(context: InterceptorContext): boolean {
  const identity = context.qualifiedClassName ?? context.className;
  return (
    ObjectRegistry.getSTIBase(identity) === '@happyvertical/smrt-assets:Asset'
  );
}
function predicate(): Record<string, unknown> {
  const scope = currentScope();
  return scope
    ? {
        accessMode: 'private',
        tenantId: scope.tenantId,
        ownerProfileId: scope.ownerProfileId,
        'id in': [...scope.assetIds],
      }
    : { accessMode: 'public' };
}
function assertOwner(
  record: Record<string, unknown>,
  scope: Scope | undefined,
): void {
  if (
    !scope ||
    record.tenantId !== scope.tenantId ||
    record.ownerProfileId !== scope.ownerProfileId ||
    !scope.assetIds.includes(String(record.id))
  )
    throw new Error('Private asset access denied');
}
async function guardMutation(
  instance: SmrtObject,
  context: InterceptorContext,
): Promise<void> {
  if (!applies(context)) return;
  const record = instance as unknown as Record<string, unknown>;
  // The instance executor is the transaction executor, including uncommitted
  // writes. Never consult a separate root connection here.
  const prior = instance.id
    ? await instance.db.get(instance.tableName, { id: instance.id })
    : null;
  const scope = currentScope();
  if (prior?.access_mode === 'private') {
    assertOwner(
      {
        id: prior.id,
        tenantId: prior.tenant_id,
        ownerProfileId: prior.owner_profile_id,
      },
      scope,
    );
    if (
      record.accessMode !== 'private' ||
      record.tenantId !== prior.tenant_id ||
      record.ownerProfileId !== prior.owner_profile_id
    )
      throw new Error(
        'Private asset classification and ownership are immutable',
      );
  }
  if (record.accessMode !== 'public' && record.accessMode !== 'private')
    throw new Error('Invalid asset access mode');
  if (record.accessMode === 'private') {
    assertOwner(record, scope);
    if (
      record.sourceUri &&
      /^https?:$/.test(new URL(String(record.sourceUri)).protocol)
    )
      throw new Error(
        'Private assets require non-public storage, not HTTP(S) source locators',
      );
  }
}

// Mandatory owning-package policy: importing Asset installs it, including when
// consumers load Asset through the generated parent model rather than education.
GlobalInterceptors.register({
  name: 'asset-private-records',
  priority: 90,
  bulkMutation: {
    compatible(className) {
      return (
        ObjectRegistry.getSTIBase(className) !==
        '@happyvertical/smrt-assets:Asset'
      );
    },
  },
  beforeList(_name, options, context) {
    if (!applies(context)) return;
    const condition = predicate();
    return {
      ...options,
      where: Array.isArray(options.where)
        ? options.where.map((group) => [condition, ...group])
        : { ...options.where, ...condition },
    };
  },
  beforeGet(_name, filter, context) {
    if (!applies(context)) return;
    return {
      ...(typeof filter === 'string' ? resolveGetStringFilter(filter) : filter),
      ...predicate(),
    };
  },
  beforeQuery(_name, _options, context) {
    if (applies(context))
      throw new Error(
        'Raw Asset collection queries cannot enforce private record access; use guarded list/get APIs',
      );
  },
  writeGuard(instance, context) {
    if (!applies(context)) return;
    const record = instance as unknown as Record<string, unknown>;
    const scope = currentScope();
    if (record.accessMode === 'private') {
      assertOwner(record, scope);
      return {
        access_mode: 'private',
        tenant_id: scope!.tenantId,
        owner_profile_id: scope!.ownerProfileId,
        'id in': [...scope!.assetIds],
      };
    }
    return { access_mode: 'public' };
  },
  beforeSave: guardMutation,
  beforeDelete: guardMutation,
});

/** Request for {@link readPrivateAssetMetadata}. Trusted server input only. */
export interface PrivateAssetMetadataRequest {
  tenantId: string;
  actorUserId: string;
  assetId: string;
}

/**
 * Display-safe projection of a private asset. This is an allowlist: it never
 * carries the owner, storage locators (`sourceUri`), the description sidecar,
 * processor metadata or any capability.
 */
export interface PrivateAssetMetadata {
  id: string;
  tenantId: string;
  name: string;
  mimeType: string;
  version: number;
  typeSlug: string;
  statusSlug: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/**
 * Read one private asset's display metadata. The host must authorize the
 * actor's relationship to the asset first. Requires the ambient tenant actor to
 * match the request exactly. Missing, public and other-tenant assets all
 * return `null`. Enforcement stays in the interceptor: the read is a guarded
 * `get` of exactly this id inside a one-id capability that closes on return.
 */
export async function readPrivateAssetMetadata(
  collection: AssetCollection,
  request: PrivateAssetMetadataRequest,
): Promise<PrivateAssetMetadata | null> {
  const { tenantId, actorUserId, assetId } = request;
  const actor = getCurrentTenant();
  if (
    !tenantId ||
    !actorUserId ||
    !assetId ||
    actor?.tenantId !== tenantId ||
    actor.userId !== actorUserId
  )
    throw new Error(
      'Private asset metadata requires an exact authenticated actor and asset ID',
    );
  // Owner resolution reads the tenant-scoped PRIVATE row directly because the
  // guarded collection hides it without an owner. The owner is used only to
  // open the one-id capability; the guarded read below is the enforcement.
  const row = await collection.db.get(collection.tableName, {
    id: assetId,
    tenant_id: tenantId,
    access_mode: 'private',
  });
  const ownerProfileId = row?.owner_profile_id;
  if (typeof ownerProfileId !== 'string' || !ownerProfileId) return null;
  return withPrivateAssetAccess(
    { tenantId, actorUserId, ownerProfileId, assetIds: [assetId] },
    async () => {
      const asset = await collection.get(assetId);
      if (
        !asset ||
        asset.accessMode !== 'private' ||
        asset.tenantId !== tenantId ||
        asset.id !== assetId
      )
        return null;
      return {
        id: asset.id as string,
        tenantId,
        name: asset.name,
        mimeType: asset.mimeType,
        version: asset.version,
        typeSlug: asset.typeSlug,
        statusSlug: asset.statusSlug,
        createdAt: asset.created_at ?? null,
        updatedAt: asset.updated_at ?? null,
      };
    },
  );
}
