/** Composition of tenant operation permissions with exact resource grants. @packageDocumentation */
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { ResourceGrantCollection } from '../collections/ResourceGrantCollection.js';
import type {
  ResourceGrant,
  ResourceGrantEffect,
} from '../models/ResourceGrant.js';
import {
  assertOperationPermission,
  type OperationPermissionOptions,
} from './OperationPermissionService.js';
import { getCurrentSessionPermissionContext } from './SessionPermissionContext.js';

export const MAX_RESOURCE_GRANT_DELEGATION_DEPTH = 8;
export interface ResourceIdentity {
  tenantId: string;
  resourceType: string;
  resourceId: string;
}
export type ResourceIdentityVerifier = (
  resource: ResourceIdentity,
) => Promise<boolean> | boolean;
export interface ResourceGrantDecision {
  allowed: boolean;
  reason:
    | 'tenant_permission_denied'
    | 'resource_not_verified'
    | 'resource_grant_denied'
    | 'resource_grant_missing'
    | 'resource_grant_allowed';
  grant?: ResourceGrant;
}
export interface ResourceOperationPermissionOptions
  extends OperationPermissionOptions {
  resource: ResourceIdentity;
  verifyResource: ResourceIdentityVerifier;
}
export interface CreateResourceGrantOptions extends SmrtClassOptions {
  actor: Omit<OperationPermissionOptions, 'collection' | 'action'> & {
    collection: OperationPermissionOptions['collection'];
    action: string;
  };
  authorization: ResourceOperationPermissionOptions;
  grant: ResourceIdentity & {
    userId: string;
    permission: string;
    effect?: ResourceGrantEffect;
    canDelegate?: boolean;
    parentGrantId?: string | null;
  };
}
export interface RevokeResourceGrantOptions {
  actor: OperationPermissionOptions;
  verifyResource: ResourceIdentityVerifier;
}

/**
 * Public resource gate. It always verifies application ownership first and
 * requires the existing tenant/catalog operation permission before an exact
 * resource decision can allow. Applications own resource lookup; SMRT never
 * guesses that a project id belongs to a tenant.
 */
export async function checkResourceOperationPermission(
  options: ResourceOperationPermissionOptions,
): Promise<ResourceGrantDecision> {
  if (!(await options.verifyResource(options.resource)))
    return { allowed: false, reason: 'resource_not_verified' };
  const tenant = await assertOperationPermission({
    ...options,
    tenantId: options.resource.tenantId,
    onDeny: 'return',
  });
  if (!tenant.allowed)
    return { allowed: false, reason: 'tenant_permission_denied' };
  if (!tenant.permission)
    return { allowed: false, reason: 'tenant_permission_denied' };
  const userId = options.userId ?? getCurrentSessionPermissionContext()?.userId;
  if (!userId) return { allowed: false, reason: 'resource_grant_missing' };
  const grants = await (
    await ResourceGrantCollection.create(options)
  ).findExact(
    options.resource.tenantId,
    userId,
    options.resource.resourceType,
    options.resource.resourceId,
    tenant.permission,
  );
  const collection = await ResourceGrantCollection.create(options);
  const active: ResourceGrant[] = [];
  for (const grant of grants)
    if (await hasActiveAncestors(collection, grant)) active.push(grant);
  const deny = active.find((grant) => grant.effect === 'deny');
  if (deny)
    return { allowed: false, reason: 'resource_grant_denied', grant: deny };
  const grant = active.find((candidate) => candidate.effect === 'grant');
  return grant
    ? { allowed: true, reason: 'resource_grant_allowed', grant }
    : { allowed: false, reason: 'resource_grant_missing' };
}

/** Administration surface; generated ResourceGrant writes remain unavailable. */
export class ResourceGrantService {
  constructor(private readonly options: SmrtClassOptions) {}
  async create(input: CreateResourceGrantOptions): Promise<ResourceGrant> {
    const { authorization, grant } = input;
    if (!(await authorization.verifyResource(authorization.resource)))
      throw new Error('Resource identity was not verified.');
    // The caller selects an already catalogued administrative operation (for
    // example projects.manage). This makes bootstrap explicit and avoids an
    // impossible first-grant cycle.
    await assertOperationPermission({
      ...input.actor,
      ...this.options,
      tenantId: grant.tenantId,
    });
    if (
      authorization.resource.tenantId !== grant.tenantId ||
      authorization.resource.resourceType !== grant.resourceType ||
      authorization.resource.resourceId !== grant.resourceId
    )
      throw new Error('Grant must be authorized for its exact resource.');
    const collection = await ResourceGrantCollection.create(this.options);
    if (grant.parentGrantId)
      await this.assertDelegationParent(
        collection,
        input.actor.userId ?? '',
        grant,
      );
    const record = await collection.create({
      ...grant,
      effect: grant.effect ?? 'grant',
      canDelegate: grant.canDelegate ?? false,
    });
    await record.save();
    return record;
  }
  async revoke(
    grantId: string,
    options: RevokeResourceGrantOptions,
  ): Promise<void> {
    const collection = await ResourceGrantCollection.create(this.options);
    const grant = await collection.get({ id: grantId });
    if (!grant) throw new Error('Resource grant not found.');
    const resource = {
      tenantId: grant.tenantId ?? '',
      resourceType: grant.resourceType,
      resourceId: grant.resourceId,
    };
    if (!resource.tenantId || !(await options.verifyResource(resource)))
      throw new Error('Resource identity was not verified.');
    await assertOperationPermission({
      ...options.actor,
      ...this.options,
      tenantId: resource.tenantId,
    });
    grant.revokedAt = new Date().toISOString();
    await grant.save();
  }
  private async assertDelegationParent(
    collection: ResourceGrantCollection,
    actorUserId: string,
    grant: CreateResourceGrantOptions['grant'],
  ): Promise<void> {
    const parentGrantId = grant.parentGrantId;
    if (!parentGrantId) throw new Error('Delegation parent is required.');
    const parent = await collection.get({ id: parentGrantId });
    if (
      !parent ||
      !parent.isActive() ||
      !parent.canDelegate ||
      parent.effect !== 'grant' ||
      parent.userId !== actorUserId ||
      parent.tenantId !== grant.tenantId ||
      parent.resourceType !== grant.resourceType ||
      parent.resourceId !== grant.resourceId ||
      parent.permission !== grant.permission
    )
      throw new Error('Delegation parent does not cover this grant.');
    let depth = 1;
    let cursor: ResourceGrant | null = parent;
    const visited = new Set<string>();
    while (cursor?.parentGrantId) {
      if (
        !cursor.id ||
        visited.has(cursor.id) ||
        ++depth > MAX_RESOURCE_GRANT_DELEGATION_DEPTH
      )
        throw new Error('Invalid resource grant delegation chain.');
      visited.add(cursor.id);
      cursor = await collection.get({ id: cursor.parentGrantId });
      if (!cursor?.isActive())
        throw new Error('Delegation ancestor is revoked or missing.');
    }
  }
}

/** A child is never usable after any ancestor is revoked or malformed. */
async function hasActiveAncestors(
  collection: ResourceGrantCollection,
  grant: ResourceGrant,
): Promise<boolean> {
  let cursor: ResourceGrant | null = grant;
  const visited = new Set<string>();
  let depth = 0;
  while (cursor) {
    if (
      !cursor.isActive() ||
      !cursor.id ||
      visited.has(cursor.id) ||
      depth++ > MAX_RESOURCE_GRANT_DELEGATION_DEPTH
    )
      return false;
    visited.add(cursor.id);
    cursor = cursor.parentGrantId
      ? await collection.get({ id: cursor.parentGrantId })
      : null;
  }
  return true;
}
