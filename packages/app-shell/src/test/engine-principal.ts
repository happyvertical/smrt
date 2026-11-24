// Test helpers for the engine's principal (#5188): the owner of a host holds
// every permission of its current definition. Computed per call, because a
// test's definition grows as it runs.
import {
  type AppDefinition,
  appPermissionSlugs,
  type EnginePrincipal,
  enginePrincipal,
  OWNER_SLUG,
} from '../engine/index.ts';

/** The owner of `host`: its tenant, the owner slug, every slug of its definition. */
export const hostOwner = (
  host: { def: AppDefinition; tenantId: string },
  userId = 'owner',
): EnginePrincipal =>
  enginePrincipal({
    kind: 'user',
    tenantId: host.tenantId,
    userId,
    permissions: [OWNER_SLUG, ...appPermissionSlugs(host.def)],
  });
