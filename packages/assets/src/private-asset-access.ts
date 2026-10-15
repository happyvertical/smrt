import type { AsyncLocalStorage } from 'node:async_hooks';
import {
  GlobalInterceptors,
  type InterceptorContext,
  ObjectRegistry,
  resolveGetStringFilter,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';

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
