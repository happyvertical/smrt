# Permissions and tenant inheritance

Read for `src/services/PermissionResolver.ts`, operation guards, role seeding,
RLS, and tenant-hierarchy changes. Integration examples live in README's
manifest-derived permission catalog and PostgreSQL RLS sections.

## Membership selection

1. A direct target-tenant membership pins resolution: active resolves normally;
   pending/suspended returns empty. Never union direct and ancestor roles.
2. Otherwise walk hierarchyPath nearest-first for the nearest active ancestor
   membership whose role has inheritsToDescendants. Skip inactive/unflagged
   ancestors; they neither grant nor block. No qualifying ancestor means empty.
3. Run later layers against the target tenant. Only target-tenant groups apply;
   membership overrides travel with the chosen ancestor membership.
   inheritedFromTenantId reports that ancestor, null for direct resolution.

Verify hierarchyPath link-by-link against loaded parentTenantId rows before
trusting it: excess depth, self-reference, duplicates or inconsistent paths
fail closed. Bound traversal by MAX_TENANT_HIERARCHY_DEPTH. Tenant status is not
consulted, matching direct resolution. Long-lived user/tenant caches must
invalidate ancestor membership changes and inheritsToDescendants flips;
request-scoped caches do not survive those requests.

`loadSessionContext().tenantAuthorization` is authoritative for required-tenant
consumers; membership null can mean inherited authority.

4. If no membership resolved at all, apply the opt-in ancestor-read policy
   (smrt#2939): the user's ACTIVE memberships on VERIFIED DESCENDANTS of the
   target, whose role slug is declared in `permissions.ancestorRead.roles` and
   within `maxDepth` hops, contribute `<collection>.read` for declared
   collections, intersected with BOTH that role's own catalog grants (so a
   descendant-side tenant GRANT, group role, or membership GRANT cannot widen
   it) AND the principal's effective permissions in that descendant (so its
   DENY cascade and membership DENY apply). Only a SYSTEM
   role (`tenantId` null, `isSystem: true`) matches a declared slug: slugs are
   not unique across a hierarchy, so a tenant-scoped custom role of the same
   name must not opt its tenant in. Off by default;
   read-only; never lateral; never reached when a direct or inherited
   membership already decided. The target tenant's DENY still subtracts.
   `ancestorReadFromTenantIds` reports the contributing descendants. The grant
   carries no membership, so `membershipId`/`tenantAuthorization.membershipId`
   stay null and a consumer requiring a non-empty membership still refuses.

## Permission precedence

Apply these layers in order, later layers overriding earlier ones:

1. Ancestor TenantPermissionOverride cascade (GRANT adds, DENY removes).
2. Selected membership role permissions.
3. Target-tenant group-role permissions.
4. Tenant cascade's net DENY removes role/group grants.
5. Membership GRANT may re-add a tenant-denied slug.
6. Membership DENY removes last and always wins.

The tenant block is the cascade's net result, not the union of historical DENYs:
a child's more-specific GRANT can override a parent DENY. Use a direct child
membership or tenant DENY to attenuate inherited role authority.
`getGroupIdsForTenant(userId, tenantId)` is required; getGroupIds is cross-tenant.

## Hierarchies and seeding

- createChild calculates paths/depth; moveToParent updates all descendants;
  getTree(rootId?) returns UI structure. Maximum depth is 10.
- Tenant override cascade requires parent cascadePermissions and child
  inheritPermissions. These flags do not gate the independent, per-role
  inheritsToDescendants membership flow.
- `permissions.ancestorRead` in the `users` package config declares upward,
  read-only visibility: `{ roles, collections, maxDepth? }`. Both lists are
  required and non-empty and `maxDepth >= 1`, else the policy is OFF — there is
  no partially valid declaration. `isAncestorReadableSlug()` is the single place
  the read-only bound is enforced; only a two-segment `<collection>.<action>`
  slug whose action normalizes to `read` on a declared collection passes.
  `PermissionResolver.create(options, { ancestorReadPolicy })` binds one
  resolver; `null` forces it off. It grants the OPERATION at the ancestor, never
  row visibility — sibling rows stay scoped by the tenancy interceptor and RLS.
- seedSystemRoles({ inheritsToDescendants: ['owner', 'admin'] }) flags listed
  slugs additively, never unflags omitted ones, and rejects unknown slugs.
  Default seeds are exact-tenant.
- RolePermissionCollection.seedRolePermissions() or
  seedSystemRoles({ seedPermissions: true }) maps owner/admin to all catalog
  permissions, member to ordinary-resource read/create, viewer to read. Member
  create excludes identity/RBAC/security resources and their joins/overrides.
  Seeding is additive/idempotent; removal requires prune: true.
- When a package adds built-in self-personalization permissions after role
  creation, explicitly call seedDefaultRolePersonalizationPermissions(). It
  upgrades owner/admin/member/viewer idempotently and never grants custom roles.

## Guards and RLS

PermissionCatalogService derives collection.action slugs from manifests,
including custom actions; list/get map to read. Hand-written mutations in form
handlers, endpoints, CLI and jobs use assertOperationPermission(). It requires
catalog presence then resolves permissions, throwing fail-closed by default.
Use onDeny: 'return', checkOperationPermission or hasOperationPermission only
when the caller handles a structured/boolean denial.

Resource-anchored guards receive the resource tenant ID. When it differs from
the session tenant, omit the session membership so the resolver selects the
appropriate authority; mismatched supplied membership/tenant fails closed.
Inherited root-admin authority can then authorize descendant resources without
application-side membership fan-out.

System context and super-admin bypass are honored. Pass
allowSuperAdminBypass: false for money or separation-of-duties operations that
require an explicit grant.

generatePostgresPermissionSql/applyPostgresPermissionPolicies enforce generated
RLS using smrt.permissions and smrt.tenant_id, installed with set_config by
withSessionPermissionContext. This bounds REST, MCP and in-process database
access once principal context is set. Child-tenant sessions receive resolved
inherited permissions automatically, but RLS row filtering remains bound to the
session tenant: a root session's app-level guard authorization does not itself
permit child rows through RLS. Preserve this distinction.
