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

- `Tenant.save()` derives hierarchyPath/hierarchyLevel from the REAL
  parentTenantId chain on every save (never from an ancestor's stored path),
  refuses missing parents, cycles and over-depth before writing, and
  re-materializes descendants by raw column update (so STI subclass columns
  are never clobbered). createChild/moveToParent/makeRoot are thin wrappers.
  `materializeTenantHierarchy(db, { dryRun })` / `smrt
  db:materialize-tenant-hierarchy` backfills legacy rows: idempotent, one
  transaction, refuses a broken chain without writing (#3036). A NEW or
  CHANGED parent link is authority-bearing, so `Tenant.save()` first loads the
  parent through TenantCollection (the caller's tenancy scope) and refuses an
  invisible one on every path — helpers, `create({ parentTenantId })`, or a
  plain assignment + save; system context bypasses as usual, and an unchanged
  link is never re-checked. getTree(rootId?)
  returns UI structure. Maximum depth is 10.
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
  Seeding is additive/idempotent; removal requires prune: true. Catalog sync
  and grants plan from one read, then commit in `SEEDING_BATCH_SIZE` batches
  (#3323): never one durable commit per row (an fsync each on local SQLite),
  and never one catalog-wide transaction (`@happyvertical/sql` transaction
  scopes cost superlinearly per statement). Pass a caller transaction's handle.
- When a package adds built-in self-personalization permissions after role
  creation, explicitly call seedDefaultRolePersonalizationPermissions(). It
  upgrades owner/admin/member/viewer idempotently and never grants custom roles.
  The built-in self-personalization slugs are `fields.policy.personalize`,
  `overviews.personalize` and `shell.personalize`, each seeded only once its
  package registered it.

## Guards and RLS

PermissionCatalogService derives collection.action slugs from manifests,
including custom actions; list/get map to read. Guards derive a class's slug
through the same resolution (explicit `collection`, manifest entry, then its
STI base's), so an STI subtype resolves its STI base's collection
(`Network extends Tenant` -> `tenants.update`) in every build, including a
bundle decorated before its manifest loads (#3125). Hand-written mutations in form
handlers, endpoints, CLI and jobs use assertOperationPermission(). It requires
catalog presence then resolves permissions, throwing fail-closed by default.
Shared STI CRUD catalog entries name the effective base model, independent of
registration order. Subtypes cannot overwrite `profiles.create` (formerly Bot
when Bot registered last). An explicit child collection keeps its own CRUD,
and deeper descendants sharing that namespace cannot replace its owner;
child custom actions and field permissions are still catalogued. Same-name app
replacements supply the effective base identity through the public registry.
`sti-create-dispatch.test.ts` exercises real Profile/Bot and a generic family
through REST, MCP, CLI's create handler and assistant manifest dispatch on SQLite;
`permission-catalog.test.ts` checks reversed order and app replacement metadata.
Use onDeny: 'return', checkOperationPermission or hasOperationPermission only
when the caller handles a structured/boolean denial.

Inside a runtime REST request acting for a host-resolved principal
(`getRequestPrincipal()` from core, #5195), `checkOperationPermission` and
its siblings are capped by that principal: a slug it lacks is denied
whichever branch would grant it (system context, super-admin bypass, live
role, explicit `permissionSet`). For the principal's own user and tenant its
permissions stand in for resolution (an explicit set is intersected); for
another subject a transaction-scoped request denies with `subject_mismatch`
and any other request resolves that subject live, still capped. Outside such
a request the gate is unchanged. Test: `src/__tests__/rest-request-scope.test.ts`.

Generated SvelteKit write routes (POST/PUT/PATCH/DELETE CRUD and mutating
custom actions) enforce the same `collection.action` slug (custom actions use
`collection.<method>`; actions hosted on a collection class use the item collection, which the catalog now emits) after authentication: the slug must be in the request's
session permission snapshot, otherwise 403 (`PERMISSION_DENIED`). The snapshot
is one source, the first defined of `locals.permissions`/`permissionSet`/
`smrtPermissions`/`locals.tenantContext.permissions` (`apiPrincipalFromLocals`;
an empty list is defined and grants nothing; sources are never combined), the
principal REST uses. `locals.tenantContext.superAdminBypass` skips it only on a
model with `tenantScoped: { allowSuperAdminBypass: true }`; `api.public: true`
stays open. A write body naming another tenant is 403 `TENANT_MISMATCH`. The
decision is the shared `authorize` (`packages/core/src/generators/route-authz.ts`).

Resource-anchored guards receive the resource tenant ID. When it differs from
the session tenant, omit the session membership so the resolver selects the
appropriate authority; mismatched supplied membership/tenant fails closed.
Inherited root-admin authority can then authorize descendant resources without
application-side membership fan-out.

Resolution cost must not scale with catalog size in objects (#3047): role →
permission ids and ids → slugs are `list({ select })` projection reads (the
collections' beforeList interceptors still run; no RolePermission/Permission
is hydrated), so an owner mapped to the whole catalog costs two queries and
no per-permission objects. Keep new resolver reads projections when only ids
or slugs are needed, and do not add public collection methods for them — each
becomes a custom-action slug in the manifest-derived catalog. The resolver's
collections never inherit `defaultListLimit`/`maxListLimit` from the caller's
options, and id-list reads chunk at `IN_LIST_CHUNK_SIZE` with an explicit
limit: a truncated authorization read would narrow the result silently.
`issue-3047-permission-resolution-cost-postgres.test.ts` pins the hydration
budget and a golden equivalence matrix recorded on the hydrating resolver.

The same rule holds for every framework-internal authorization read (#3048):
collections that back a decision — the resolver's, the ResourceGrant exact-tuple
read in `checkResourceOperationPermission()` (DENY wins only if every row is
read), and TenantService's owned-tenant quota count — are created through
`withoutListBounds()` (`src/services/authorization-read-options.ts`), which
strips only the caller's list bounds. Use it for any new decision read;
`issue-3048-authorization-list-bounds-postgres.test.ts` pins it.

PermissionResolver runs every resolution inside smrt-tenancy's system context
(#3036). Its reads are deliberately cross-tenant and framework-owned — the
ancestor TenantPermissionOverride batch, ancestor memberships for
inheritsToDescendants, descendant memberships for ancestor-read — and are keyed
by the explicit (userId, tenantId); with those classes registered tenant-scoped
(`autoFilter`) the consumer's filter otherwise threw TenantIsolationError or
silently narrowed them. It returns slugs and ids only, never rows, and the
caller's own reads stay filtered. Do not move a resolver read back under the
ambient tenant; the Postgres regression suite
`issue-3036-hierarchy-resolution-postgres.test.ts` pins this. Because nothing
backstops those reads any more, the tenant-override cascade verifies its chain
too: it uses hierarchyPath only when it agrees link-by-link with
parentTenantId, otherwise walks the real parent links (so a forged path cannot
cascade an unrelated tenant in, and a never-materialized row still gets its real
ancestors' DENYs — and GRANTs), and throws TenantHierarchyError on a broken
real chain: a per-request failure for that tenant's whole subtree, which
`smrt db:materialize-tenant-hierarchy --dry-run` reports ahead of time (see
README "Upgrading an existing fleet").
`getTenantInheritanceChain()` returns Tenant rows, so it is NOT run in system
context; it reports the same verified chain the cascade applies when the
caller can read every ancestor. Otherwise it never reports PARENT_NOT_FOUND
for a row the caller simply cannot see: an interceptor refusal surfaces as
TenantIsolationError, and a silently filtered row (e.g. RLS) ends the chain at
the nearest readable ancestor. Descendant path rewrites are raw column updates recorded through
`bumpChangeFeed`; `updated_at` is intentionally not bumped (derived columns;
every save recomputes them). They are not atomic with the moving row's save —
an interrupted subtree fails closed until re-saved or backfilled.

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

A host with run-time models in an app schema passes a `PostgresPolicyScope` (second
argument; `@happyvertical/smrt-users/postgres-policies`, `applyScopedPostgresPermissionPolicies`
on a handle it already holds): tables and the `smrt_*` helpers live in
`schemaName`, never `public`; only `includeClass` classes get policies;
`permissionsFor` names the slugs; explicit bindings are not applied. Helper bodies
never call each other (a schema copied whole creates functions in name order).

RolePermission's natural key is `(role_id, permission_id)` (#3329); repeated or
concurrent inserts converge without changing the grant ID. Existing deployments
must run `deduplicateRolePermissions()` with stopped writers before ordinary
schema migration; see README's "Upgrade duplicate role grants". It keeps the
oldest row and installs uniqueness atomically. Runtime seeding never performs
this schema repair.

MembershipOverride `(membership_id, permission_id)`, TenantPermissionOverride
`(tenant_id, permission_id)` and GroupMember `(group_id, user_id)` are natural
keys too (#3375): `setOverride()` upserts (last effect wins), removal deletes by
the pair, and their FKs declare `onDelete: 'NO ACTION'` so the natural key does
not turn them into CASCADE. Existing deployments run
`deduplicateAuthorityPairs()` in the same stopped-writer window; it keeps the
effective override (DENY > GRANT > INHERIT) so authority never widens.

Custom methods can declare `operationPermissions` aliases to the same
collection's CRUD grants (#3878); `deriveOperationPermissionSlug()` resolves
them for class and catalog-slug callers. Catalog generation merges optional
`databaseActions` into the target grant's PostgreSQL bindings. CRUD grants
cannot themselves be aliased. See core's [generator contract](../../core/agents/generators.md#custom-action-permission-aliases-3878).

## Portable metadata registry (#4765)

Browser-safe packages import `registerPermissionDefinitions` and its existing
`PermissionDefinition` / PostgreSQL binding types from
`@happyvertical/smrt-users/permission-registry`. This entry imports only shared
metadata storage. It does not load Users models, catalog database sync, operator
services, PostgreSQL policy generation or Core filesystem discovery.

The old package-root and PermissionCatalogService exports re-export the exact
same function. Both paths share the existing process-global Map/counter; each
returned disposer removes only its own registration and may be called repeatedly.
Definitions retain their original references and normalization/conflict rules
remain in the server catalog. No second catalog or no-op browser registration is
introduced. Metadata registration and catalog sync do not grant a user, role,
tenant or resource permission. Existing persisted grants/current authority checks
remain required. Use the public portable entry rather than private service paths
when a model package needs declarations without the server runtime.

### Runtime resource discovery imports

`src/sveltekit/resource-list-handler.ts` imports shared action/name policy from
`@happyvertical/smrt-core/api-actions`, not the Vite-plugin barrel. This is the
same implementation re-exported by the route generator; permissions, wireability,
custom-action receiver resolution and paths are unchanged. The existing resource
handler suite retains positive and refusal coverage, and its fresh-Node published
entry guard rejects Vite route-emitter/activation-generator loads. No SQL executor,
transaction, authentication or tenant-boundary behavior changes in this import fix.

## Agent users (#5086)

There is no agent column on `User`. A user is an agent when its linked
`Profile` has the `bot` profile type (`resolveAgentProfile` /
`AGENT_PROFILE_TYPE_SLUG` in `@happyvertical/smrt-profiles`); give it a
membership with a limited custom role like any member. MCP classifies the
principal from that live profile (`kind: 'agent'`), the default MCP policy
accepts the kind only when `principalKinds` lists it, and the role's
permissions cap what its tokens can do on every request. The profile models
refuse an unprivileged principal changing whether a profile is `bot` typed
(including by create or natural-key upsert) or creating/renaming the type, so an agent cannot relabel itself. See
`packages/app-runtime/agents/self-issuer-mcp.md`.

## Guest callers (#5196)

An UNAUTHENTICATED request may act as a guest of the tenant its address names,
with the tenant's `TenantGuestGrant` slugs (`GuestPermissionResolver`: minus
every chain DENY, then the code ceiling). Request wiring lives in
`packages/app-runtime/src/sveltekit/guest.ts` and the runtime session step; the
principal is `callerKind: 'guest'`, `userId: null`
(`withPrincipalPermissionContext({ callerKind: 'guest', ... })` and
`createGuestRequestPrincipal` in core; `locals.guestPrincipal`).

App config (`smrt.config.ts`, strict: any malformed value means NO guests; the
whole block is refused, never filtered):

```ts
packages: { users: { permissions: { guest: {
  collections: ['products', 'contact_messages'], // guests may be granted .read
  createCollections: ['contact_messages'],       // subset that accepts creates
  createFields: {                                // REQUIRED per create collection
    contact_messages: { allowedFields: ['name', 'email', 'message'] },
  },
  trustedProxyHops: 1,                           // default 0: socket address only
  rateLimits: { createPerClient: 5, createPerTenant: 60, readPerClient: 120, readPerTenant: 1200 },
} } } }
```

Guests need ALL of: `permissions.guest`, the default subdomain tenant selector,
`TENANT_BASE_DOMAIN`, an ACTIVE addressed tenant, deployed PostgreSQL with the
request RLS transaction, enabled tenancy, a non-SUPERUSER/BYPASSRLS role and
ENABLED+FORCED policies on every ceiling table (catalog check, cached per
process on success, fail closed). Any failing gate, resolver error or an empty
set is the ordinary anonymous path, so a response never reveals whether a
tenant exists or has grants. A valid session, and a session the tenant check
rejected (a signed-in non-member), never become guests; skipped paths never do.

Generated routes admit a guest only for `list`/`get` when it holds
`<collection>.read` (`isGuestOperationAllowed`; a custom method aliased onto
read never passes), cap guest pages at 100 (`GUEST_MAX_LIST_LIMIT`), and answer
401 to everything else (writes, custom actions, `public` routes of ungranted
collections). The door
refuses to carry a tenant or permissions without active RLS, and publishes the
six `smrt.*` settings with `set_config(..., true)` only.

### Guest creates (a contact form)

A collection accepts guest creates only when the app lists it in
`createCollections` WITH a `createFields` entry (a create collection without
one refuses the whole block), the tenant grants `<collection>.create`, and the
request is the generated `POST` (`guestCreateAdmission`; a custom method
aliased onto create never passes). The pipeline (`handleGuestCreate`,
`packages/core/src/guest-runtime.ts`) is: body cap (read before parsing; 413) ->
`projectGuestBody` (only listed primitive fields; `id`, tenant, owner and
timestamp columns can never be listed, nor sensitive/system/read-only fields;
the list is validated against the registered model on first use and a bad list
means no guest create, not a partial one; STI and write-through models are
refused) -> rate limit (per tenant AND per client `tenantId:ip`, IPv6 by /64,
recorded before the write, 429 + `Retry-After`, an unknown key is denied when
the table is full; defaults 5/min per client, 60/min per tenant) -> one
savepoint holding `INSERT ... ON CONFLICT DO NOTHING` (no `RETURNING`, server
id and tenant) and its audit row -> `201`, empty body, no id, no `Location`,
identical for a unique conflict (which writes no audit row and does not move
the table version). The insert is raw SQL, so it bumps the change feed
(`bumpChangeFeed`) in the same savepoint: a staff list answered from the
table-version ETag sees the new row instead of a stale 304. A request rejected
for its body (400/413) is not charged to the rate limits.

The client address is the socket address; `X-Forwarded-For` counts only with
`trustedProxyHops` set to the number of proxies you run. One process-wide
limiter set lives on the guest runtime (`createGuestRuntime`, built once by
the admission and shared by every route); it is per replica. #5198's shared
route limiter does not exist yet, so this is the only floor. Guest reads share
that runtime with a looser limit (120/min per client, 1200/min per tenant, same
limiter class, fail closed when full) and pages stay capped at 100.

Update, delete, sync and custom actions stay refused for guests. The runtime
REST handler (`rest.ts`) has no guest create: a guest principal handed to it is
unauthenticated and refused as before; guests enter through the generated
SvelteKit routes only.

#### Audit and the audit-table gate

The create's audit entry is written through the app's audit writer (profiles
`createAuditWriter()`; a typed `callerKind: 'guest'` entry, the reserved
`GUEST_AUDIT_ACTOR`, null profile, `actor_kind = 'guest'`) inside the SAME
savepoint as the insert, so a failed audit write fails and rolls back the
create (the request transaction alone cannot: a handler that turns the failure
into a 500 still lets it commit). The guest branch of that writer is a plain
`INSERT` with no upsert and no `RETURNING` and never raises
`smrt.system_context`: the guest's database context holds only an INSERT
policy on the audit table.

Because of that, guests are REFUSED at admission (any guest config, read-only
ones included) unless the audit table has row-level security enabled AND forced and the named
guest INSERT policy (`guestAuditPolicyName()`, `polcmd = 'a'`) installed. The
catalog check (`probeGuestCatalog` -> `assertGuestRuntimeActive`, which fails
closed on a missing table, a missing or non-boolean value and a failed query)
is read from `pg_class`/`pg_policy` and re-asserted on every request, so an
app with guests needs the profiles tables (and the apply command below) even
before it opts a collection in to creates.

Setup is the DEFAULT of the documented policy-apply path: when the app config
has `permissions.guest`, `generatePostgresPermissionSql` /
`applyPostgresPermissionPolicies` append, with no caller opt-in, `ENABLE` +
`FORCE ROW LEVEL SECURITY` on `public.audit_logs` (profiles `AuditLog`), the
INSERT-only guest policy, and a companion arm
(`generateAuditNonGuestPolicySql`) that keeps system, super-admin, signed-in
(a user id is published) and no-tenant background writers working exactly as
without RLS; a guest context (a tenant, no user, no bypass) satisfies none of
it. `extras.guestAudit = false` opts out (guests are then refused); a policy
scope (run-time models in an app schema) never gets the default. Run the apply
command after the profiles tables exist; the audit table must be in `public`.
Proven in `guest-create-postgres.test.ts` (PGlite via `test:pglite`, real
PostgreSQL via `test:postgres`) and `sveltekit-guest-audit-posture.postgres.test.ts`.

#### Model admission, relations, validators and migrations

- **A slug is admitted for one model.** The ceiling (`guestSlugTargets`) keeps
  `<collection>.read`/`.create` only when EXACTLY ONE policy target is reachable
  by it (the target whose collection name it is, or any target that lists the
  slug under SELECT/INSERT through an explicit `permissions.postgres` binding)
  and that target passes the ceiling. Two models sharing a collection name, or a
  binding aimed at a second table, drop the slug. `resolveGuestAdmission`
  returns the admitted model per slug; it rides on the guest principal as
  `slugModels` and every generated route admits a guest only when ITS OWN
  qualified name is the admitted one (`isGuestAllowedOnRoute`; a principal with
  no map admits no route).
- **No relation fields.** `defineGuestCreate` rejects foreign keys,
  `@crossPackageRef`, one-to-many/many-to-many and other relation fields in
  `allowedFields`: PostgreSQL checks foreign keys without row-level security, so
  a guest could probe ids across tenants or attach to another tenant's row.
- **No error oracle.** A failure that depends on the submitted values (unique,
  not-null, foreign-key, check, exclusion, invalid input) rolls the savepoint
  back and answers the same `201` as a success; only genuine server faults
  (privilege, missing table, connection, a failed audit write) answer 500.
- **Rejected bodies cost the client.** A client over budget is refused before
  its body is read; a 400/413 body is charged to the client limiter (never the
  tenant's).
- **The audit marker is minted only by the pipeline.** `requireAuditOptions`
  accepts the reserved guest actor only from `guestCreateAuditContext()` (core
  internal, not exported from the package); a bare `{ callerKind: 'guest' }` is
  refused.
- **Raw INSERT skips model validators and hooks.** A guest create does not run
  `validateBeforeSave`, `beforeSave` hooks, slug generation beyond `slug = id`,
  interceptors or computed fields; only column defaults of the model are applied.
  Enforce what matters in the database (NOT NULL, CHECK length/format
  constraints, unique indexes): a violating value answers `201` and writes
  nothing.
- **Migrations before deploy.** Guests need `audit_logs.actor_kind` and a nullable
  `profile_id` (profiles `AuditLog`) and `tenant_guest_grants`. Run
  `smrt doctor --db` and `smrt db:status --parity` and migrate before enabling
  `permissions.guest`; admission refuses guests until the audit table has the
  forced RLS and guest policy, and the guest audit insert fails (so does the
  create) against an unmigrated table.
