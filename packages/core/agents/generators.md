# smrt-core/code generators

Module semantics for `src/generators/` + `src/vite-plugin/`. Package orientation, the cross-module
invariants, and the traps that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

## Code Generators

| Generator | Location | Output |
|-----------|----------|--------|
| REST API | `src/generators/rest.ts` | OpenAPI-compliant CRUD endpoints |
| MCP Server | `src/generators/mcp.ts` | Model Context Protocol tools |
| Web collections | `src/vite-plugin/web-collections.ts` (selectors) + `generateWebModule` | `@happyvertical/smrt-virt-web` — one typed collection definition per API-exposed REST collection (#1761), consumed by `@happyvertical/smrt-web` |

### Write bodies set fields only

Every generated or request-facing write path filters the body through its
writable policy before `collection.create(data)` or `applyUpdateInput(item, data)`:
runtime REST and MCP (`applyWritablePolicy` in `rest.ts` and `mcp.ts`), both
emitted MCP servers (`mcp.ts` modular, `mcp-runtime-template.ts`), the emitted
SvelteKit create and update handlers, and sync apply (`sync/apply.ts` and the
emitted sync route). Each copy drops `_`-prefixed keys, server-managed fields,
read-only fields, anything outside an `api.writable` allowlist, and every key
for which `ObjectRegistry.isServiceOptionInput(model, key)` is true: a service
option key (`SMRT_SERVICE_OPTION_KEYS`) the model does not declare as a field,
and `options`. A new write path must apply the same rule; the collection also
enforces it on construction (see [object-runtime.md](object-runtime.md),
"Services never come from data"). The policies are still separate copies;
they share the rule, not the code.

### An update sets declared fields and settable accessors

No update path assigns a body with `Object.assign`. After its writable policy,
each one calls `applyUpdateInput(instance, data, model)` (`src/request-input.ts`
over the rule in `src/write-input.ts`): runtime REST update and sync apply,
in-process MCP, both emitted MCP servers, the emitted SvelteKit `PUT` and sync
route, the CLI `update` command (`packages/cli`) and the assistant tool loop
(`packages/chat`). The structural sync processor uses the same rule for a host
that supplies no `mutate` seam.

- A key is assigned when it names a field the object's own class (or an
  ancestor) declares, a write-through field, or an accessor with a setter on
  the prototype chain or the instance. Models take derived input through
  getter/setter pairs (`Contract.sellerTaxRegistrations`, `Content.assetIds`);
  those keep working. `slug` and `context` are accessors of every object.
- A key that names a method, an accessor without a setter, a member of
  `Object.prototype` (`constructor`, `toString`, `__proto__`), or nothing the
  model declares is refused: `WriteInputError`, code
  `VALIDATION_UNKNOWN_FIELD`, a typed 400 whose message names the key. Sync
  apply reports the item `rejected` / `invalid_payload`. Every key is checked
  before the first is assigned.
- The model is read from the instance's prototype, so an STI row loaded through
  its base collection may set its own subtype's fields, and obeys its own
  subtype's write policy too: keys the subtype marks read-only or leaves out
  of its `api.writable` allowlist are skipped, on top of the route's policy.
- `displayLabel` is skipped without an error on a model that projects one, so a
  body read from the API can be sent back.
- A class with no registered field at all (an unscanned inline class) is judged
  by its instance's own plain properties.
- Create input follows the same rule before the object is constructed:
  `assertCreateInput(model, data)` (`src/request-input.ts`) runs after each
  create path's writable policy (runtime REST, the emitted SvelteKit POST,
  in-process and both emitted MCP servers, runtime and emitted sync, the CLI
  and the assistant) and refuses a key that is not a declared field, a
  write-through field or a settable accessor of the class (`VALIDATION_UNKNOWN_FIELD`,
  sync `invalid_payload`). A constructor that copies its options would
  otherwise install any request key on the instance. A model with no field
  metadata is not checked. The smrt-dev-mcp class generator emits per-field
  constructor assignments, never `Object.assign(this, options)`.
- Sync apply checks an update payload against the stored row
  (`SyncApplyTarget.assertUpdate`) before it answers a replay or a stale
  write, so an unknown key is always `invalid_payload`.

Output: every transport finds the serialiser with `publicSerializerOf()` /
`toPublicJSONValue()` (`src/public-json.ts`), which read `toPublicJSON` from
the prototype chain. An own property of that name on an instance is never
called and never hides the class's serialiser. A result that may hold models
anywhere inside it (a custom action's result, a custom serialiser's
envelope) goes through `toPublicResultValue()`, which projects every nested
model too; the assistant tool loop uses it for every observation.

Tests: `src/__tests__/update-input-fields.test.ts` executes all seven
transports; `packages/cli/src/__tests__/cli-writable-policy.test.ts`;
`packages/chat/src/tool-loop.test.ts`.

### Host-resolved principal on runtime REST (#5195)

`APIConfig.resolvePrincipal(req)` returns the request's
`APIRequestPrincipal` (`{ tenantId, allowCrossTenant, authenticated, userId?,
permissions?, callerKind?, superAdminBypass? }`) or `null` (anonymous). The
host decides it; nothing in the request changes it. `handleRequest` calls it
once per request, before custom routes and before `authMiddleware`, with the
request as received, and passes the result (`ResolvedRequestPrincipal`,
`generators/request-principal.ts`) explicitly to every check: CRUD, custom
actions, each `sync/apply` item, subtype re-checks, `_changes`, `_events`,
`_inference` and `_preflight`. Rebuilt requests (sync items, subtype checks)
never resolve it again. A throw, or a value of the wrong shape, is a 500 that
carries only a request id. Permissions are copied into a `Set` once. The
answer is kept per request object (`requestPrincipals`, carried to the
request an `authMiddleware` returns); a request without one is a 500, never
another caller. With `resolvePrincipal` configured, `resolveTenant` (kept
for hosts that supply only a tenant) is not called. The principal's tenant,
user, permissions, grant and sign-in are the settled principal of
`resolveRequestActor` (`settledPrincipalOf`); `_changes`, `_events` and
`_inference` run as that actor (`withActorContext`: its tenant, or a system
context for a cross-tenant grant; `_events` captures it at open).

When it is configured, runtime REST enforces, from the principal:

| Rule | Where | Refusal |
|---|---|---|
| Sign-in: `authenticated`, unless `api.public` opens the route (`'read'`: reads only), as `requireRouteAuth` decides on the emitted routes | `admitObjectRequest`, `authorizeRowModel`, sync `authorize`; `_changes` / `_events` are never public (`authenticateFeedRequest`) | 401; sync `auth_required` |
| `<collection>.<action>` through one `requirePermission(principal, model, action)`: create, update, delete; mutating custom actions as `<collection>.<method>` (or the `operationPermissions` alias); each sync item as `<collection>.<op>`; a subtype row's own model on create, update, delete and sync | `routeCrudOperation`, `dispatchCustomCollectionAction`, sync `authorize`, `authorizeRowModel` | 403 `PERMISSION_DENIED`; sync `forbidden` |
| A write body naming a tenant other than `tenantId` (`tenantId`, `tenant_id`, or an ownership column of the model, any spelling of the column; `null` included) | `assertWriteTenant` on create (base and selected subtype), update (and the subtype row's model), sync `prepare` | 403 `TENANT_MISMATCH`; sync `forbidden` |
| Query filters on a tenant ownership column are removed unless `allowCrossTenant` | `withoutTenantFilters` in `applyTenantReadScope` (list, count) | none: the filter is ignored |
| Read redaction, query field checks and `_preflight` use `principal.permissions` | `getPublicJsonOptions(principal)` | — |

The permission collection is `resolvePermissionCollection()`
(`src/permission-collection.ts`), the function the emitted CRUD, action and
sync routes use: `@smrt({ collection })`, else the model's manifest
collection. `api.public: true` models need no permission (as on the emitted
routes). `superAdminBypass` stands in for a permission only on a model with
`tenantScoped: { allowSuperAdminBypass: true }`; the emitted routes'
`tenantContext.superAdminBypass` skips the check on every model. GET custom
actions need no permission, as on the emitted routes. `authMiddleware`, when
also set, runs after these checks as an extra check and can only refuse.
`APIContext.user` / `permissions` are not read.

`APIConfig.onRequest(principal, { route, model?, action? })` is the seam for
rate limits and metering (#5198, #5199): called once right after resolution
(`route` is `object`, `sync/apply`, `_changes`, `_events`, `_inference`,
`_preflight`, `custom` or `unmatched`; an object route names its model and
`list` / `get` / `count` / `create` / `update` / `delete` or the custom
action), and once per sync item after the item was authorized. A returned
`Response` answers the request. For a sync item it rejects that item only,
before any of it is applied (`auth_required` for a 401, else `forbidden`),
and the batch goes on. A throw is a 500 (a sync item: `write_failed`).

Without `resolvePrincipal`, the tenant is `resolveTenant`'s answer or the
fixed `APIContext` one, and the fixed principal applies to every request
(`tenantId`, `allowCrossTenant`, `permissions`;
`authenticated` = an `authMiddleware` is configured), `authMiddleware` alone
decides authentication and authorization, and none of the rules above apply:
behaviour is unchanged. `onRequest` then receives that fixed principal.
Tests: `src/__tests__/rest-request-principal.optional.test.ts` (SQLite, and
PostgreSQL in the `test:postgres` lane),
`packages/tenancy/src/__tests__/rest-request-tenant.test.ts` (real tenancy).

### Request tenancy: one resolver for every request path (#5375)

Runtime REST, the emitted SvelteKit routes, both sync apply paths and both MCP
surfaces decide tenancy in one place, `src/request-tenancy.ts`, with the actor
rule of `src/request-actor.ts`. Per request (per sync item, per tool call):

1. **Actor.** `resolveRequestActor()`: the principal the transport settled
   (REST `APIConfig.resolveTenant(req)`, an MCP context or
   `SMRT_MCP_TENANT_ID`), else trusted `locals` (`tenantId`, then `user`,
   `session`, `tenantContext`). An active tenant context must agree, grant or
   no grant (a different tenant or user is `RequestTenantConflictError`,
   rendered as the plain `permission_denied` 403); without a principal
   tenant, the active context is the actor, and a cross-tenant grant does not
   widen it (the request stays in that tenant). A system actor comes from an
   active system context, or from `allowCrossTenant` outside a host-entered
   tenant context, and then for this operation only: on GET/HEAD (MCP
   `list`/`get`) it is a read grant and never writes. The actor records the
   read grant (`readGrant`) even where a host-entered tenant kept the request
   in one tenant, and a nested resolution (`runInRequestTenancy` inside the
   request) inherits it, so such a request writes no tenant-scoped row
   whatever context its code enters. The bypass needs the
   tenancy super-admin flag. A complete principal (`api.principalContext`)
   runs with its own permission snapshot even inside an active context of the
   same tenant. Runtime REST asks `resolveTenant` once per request object the
   middleware returned; a sync item uses that answer and its own operation,
   never a request copy. The settled principal of #5195 replaces the
   transport answer when it lands.
2. **Policy.** `resolveRequestTenancy({ model, served, actor })` resolves the
   model by strict identity (`resolveStrictModelKey`: an exact qualified key,
   or a simple name exactly one class owns; never the first match) and reads
   each policy from the `TenantPolicySource` smrt-tenancy installs
   (`policyOf(key)`: absent, resolved or failed). A member records its
   `state` (`unscoped`, `scoped`, `failed`); a failed lookup (with or without
   a reason, or a throwing source), a policy with no usable mode or field, a
   source that omits tenancy the registry declares, a resolved policy looser
   than the declaration or on another field (a stricter one, such as a
   runtime override to `required`, resolves), an unknown or ambiguous model,
   or enabled tenancy with no source makes every decision refuse (403
   `TENANT_POLICY_UNRESOLVED`). `served` is the STI members the route reads
   for the operation (`servedFamilyTypes`: surface, server model list,
   per-request admission); on the emitted routes and both MCP surfaces a
   member is admitted only when it is on the server's model list (an MCP
   server's models; an emitted CRUD or action route's family members the
   manifest generates, `TENANCY_MODEL_SCOPE`; the emitted sync route's
   models, `SYNC_MODEL_SCOPE`, when the manifest declares a family), switched
   on for the actor's tenant, its own complete-principal requirement met
   (`api.principalContext`: tenant, user and permissions in `locals`, on the
   API surface), and readable by the
   caller (`api.public`, or a caller the transport signed in: a signed-in
   principal in `locals`, an MCP context with a user; a tenant context the
   host entered does not count). An MCP point read uses the
   members open for `get`, a list those open for `list`. `creatable` is the
   members a create may select (`familyCreateTargets`: `create` open; on
   runtime REST also its model list, while an MCP server's model list limits
   only what is read through a base), a separate set that is never read.
3. **STI membership.** A served member is admitted only when its policy
   *equals* the route model's (scoped, mode, ownership columns,
   `allowSuperAdminBypass`, bounded-hierarchy allowance). Every read, count,
   point read, write and sync item on the family table is restricted to
   `_meta_type in admitted` (positive: a stored type that is not registered,
   or not admitted, never matches; a list or point read whose filter is one
   condition record also names the registered members left out, since a child
   collection replaces any type list with its own subtree, keeps the caller's
   own `_meta_type in` / `not in` as a conjunction (an empty intersection
   selects nothing; two caller keys for one operator are a 400), and keeps
   every other caller key in that record, so a child still replaces a caller's
   `_meta_type` equality under any spelling with its own type). A new row is held to
   the create targets, a stored row to the admitted types, and a natural-key
   save never adopts a stored row of a type the request does not admit (403
   `TENANT_MEMBER_EXCLUDED`). A member left out is simply absent from lists and counts, a
   point read answers 404, a base-route create that selects it is refused
   (403 `TENANT_MEMBER_EXCLUDED`), and a sync item naming its row is
   `not_found` (update) / an opaque `id_conflict` (create). Runtime REST
   finds the row of an update or delete among the members the route reads;
   the row's own model then decides the write (405 when it does not enable
   it, else its authorization), as the sync path does.
   The runtime warns once per family (`SMRT_MIXED_TENANCY_FAMILY`); `smrt
   doctor` lists the families the manifest declares.
4. **Decisions** (pure, on the frozen result): `readScope` (`open`,
   `context`, `all`, `global-only` = `{ <ownership field>: null }`, or a
   refusal: required mode with no tenant is 401/403), `writeGate` (a tenant,
   a system actor with a write grant, or a bypass the member opts into; a
   caller with no tenant never writes a tenant-scoped row, rows without an
   owner included), `customActionScope` (a mutating action needs the write
   gate; on the emitted routes a read by a caller with no tenant runs only
   when its scanned parameters carry the scope: one `options` parameter, or
   parameters named after every ownership property, and a method's source is
   never parsed; runtime REST hands no custom collection action the scope, so
   it refuses a caller with no tenant every custom collection action of a
   tenant-scoped model, GET actions included, whatever the method's
   parameters, and serves it rows without an owner through the CRUD list, get
   and count only),
   `cachePolicy` (shared caching only when no admitted member is scoped, or,
   with tenancy off, declares tenancy, and every admitted family member's
   reads are public: a member admitted for this caller only makes the rows
   depend on who calls) and `etagDiscriminator` (actor scope, admitted types
   and a fingerprint of every member policy; with tenancy off, a family
   read with members still keys on its admitted types).
5. **Binding.** The operation runs inside `withResolvedTenancy()` (REST, sync
   items, MCP tools) or after `enterResolvedTenancy()` (an emitted handler's
   `enterTenancy(locals, operation)`), in the actor's tenant or system
   context. The actor's tenant context is entered whether or not tenancy is
   enabled: smrt-tenancy lends core its context store when the package is
   loaded, so a complete principal (`api.principalContext`) on a model with
   no tenancy is what the request's code reads (`getCurrentTenant()`), and an
   active context of another tenant refuses the request; enforcement decides
   only which rows it touches. The `smrt-request-tenancy` collection interceptor (priority 110,
   installed on first bind) holds every collection call of the request,
   custom action bodies included, to the bound decision: membership, the
   rows-without-an-owner scope for a caller with no tenant, the write gate,
   and a policy-changed check: a member whose live policy no longer matches
   the bound one refuses with `TenantPolicyChangedError` (403
   `TENANT_POLICY_CHANGED`, never adopted). A family operation rechecks every
   admitted type it reads, and tenancy turned on or off since admission
   refuses too. A model the request did not resolve (a custom action reading
   or writing another model) is held to the same actor rules under its live
   policy: a caller with no tenant reads only its rows without an owner
   (required mode refuses) and writes none; a read grant writes no
   tenant-scoped row of any model. A read of another STI family
   that has members is restricted to that family's types of equal tenancy
   to the model queried (resolved for the same actor; a system actor reads
   every type), so an unrelated unscoped base never serves rows of a
   tenant-scoped member. Every save and delete of an STI model (any family)
   is also decided under the policy of the row's stored type (read by id
   where the family has members) and of the instance's `_meta_type`: that
   type's write gate applies, a type whose policy differs from the class
   written through is refused, and so is a stored owner other than the
   acting tenant under the class's policy (`TENANT_MEMBER_EXCLUDED`; a new row taking the
   id of such a row gets the insert's unique-constraint error, so a hidden
   row reads as a taken id), because the owner is stamped and checked under
   the class's policy only. A system actor writes every type. Code that
   enters a system context inside
   the request acts as the system, and code that enters a tenant context in
   a request with no tenant acts in that tenant (each call is held to the
   context active when it runs), except under a read grant, which no context
   lifts. Raw `query()` stays under the raw-query
   policy, not this decision. The resolved members and admitted types are
   read-only, and owner stamping (`autoPopulate`) is bound with the policy.
   smrt-tenancy's interceptor reads the bound policy for every member
   (`boundMemberTenancy`). An emitted MCP server turns the installed tenancy
   layer on when a tool's model (or an STI member) is tenant-scoped at call
   time, a registration after generation included.

The manifest's `tenantScoped` flag selects nothing on a request path: emitted
routes are generated with the same core calls for every model, so tenancy
registered at run time (or after an MCP server was generated) is enforced
like declared tenancy. A refusal is a typed error with `status`
(`RequestTenancyError`), rendered by `normalizeTypedHttpError` on REST and the
emitted routes, as a tool error on MCP, and as `auth_required` / `forbidden`
on a sync item. A validator issued before a registration changed any member's
policy never revalidates, the body-hash validators included (they hash the
discriminator with the body), and the discriminator covers an active bounded
hierarchy read scope (`TenantPolicySource.hierarchyReadScopeKey`). Not
covered: a registration landing during the asynchronous table-version lookup
of the zero-query path can still revalidate once. A shared-cache copy issued
before a run-time registration lives until its own `s-maxage`.

| Caller | Read | Write (create, update, delete, mutating action, sync item) |
|---|---|---|
| Has a tenant | That tenant (interceptor filter) | That tenant |
| `allowCrossTenant` on a read | Every tenant | Refused (403 `TENANT_WRITE_REFUSED`), for every tenant-scoped model the request touches |
| `allowCrossTenant` inside a host-entered tenant context | That tenant | That tenant |
| `allowCrossTenant` on a write / system context | Every tenant | Every tenant |
| Neither, optional mode | Rows without an owner | Refused (401/403) |
| Neither, required mode | Refused (401/403) | Refused |
| A tenant other than the active context | Refused (403) | Refused (403) |

The CLI is outside this contract (it runs with the operator's credentials;
tracker issue per #5375 D2).

Tests: `packages/tenancy/src/__tests__/effective-tenancy-*.test.ts` (real
tenancy, every transport), `src/__tests__/request-tenancy.test.ts`,
`src/__tests__/sti-family-tenancy.pglite.test.ts`,
`packages/cli/src/__tests__/doctor-sti-tenancy.test.ts`.

### Tool identifiers are non-empty strings

MCP arguments are untyped JSON. The `get`, `update`, `delete` and item-action
tools of the in-process generator and of both emitted servers read `id` /
`slug` through `requireIdentifierArgument()` / `identifierArgument()`
(`src/tool-arguments.ts`): `undefined`, `null` and `''` are absent (the
existing "ID is required" answers), a non-empty string is the identifier, and
any other value (a number, a boolean, an array, an object of conditions) is
`ToolArgumentError`, code `VALIDATION_INVALID_ARGUMENT`, a typed 400. A
present, unusable `id` never falls back to `slug`. Tests:
`src/__tests__/tool-identifier-arguments.test.ts`.

### A request reaches one model, under that model's policy

Runtime REST resolves a URL or sync `object` segment to one registered model
and then looks up every policy by that model's qualified registry key
(`qualifiedName || name`): the `authMiddleware(objectName, action)` argument,
`api.public`, enabled actions, the writable policy, read permissions, tenant
scope and the collection factory. Two packages may declare models with the
same simple name; a simple-name lookup resolves to whichever registered first,
so no REST policy lookup uses one. The `registerCollection()` branch already
passed the qualified name; auto-discovery and sync now do too.

Auto-discovery (`findClassByCollectionSegment` over `collectionSegmentIndex()`,
rebuilt when the registry generation moves) maps each segment to the model it
serves: a collection class to its row model, an STI subtype that keeps its
base's collection to the ancestor that owns it. Models with `api: false` are
not candidates. A segment that two distinct models serve is ambiguous: a
request naming it fails with `ConfigurationError`
(`REST_COLLECTION_SEGMENT_AMBIGUOUS`, an opaque 500) before any middleware or
policy runs, instead of being served by registration order.
`createRestServer(objects)` / `startRestServer(objects)` serve the models in
`objects` and no other registered model (an unregistered class is warned about
and not served); two of them on one segment make the server refuse to start
with the same error. Such a server also creates only its models: an STI
create selecting a subtype that was not among `objects` is refused with
`CreateTargetError` (a subtype of a served base is a model of its own, served
when it was given too), and reads through the base (list, count, get, and the
lookup before update, delete and a sync item) reach only rows of the base and
of the subtypes it was given that open the read on `api`
(`servedFamilyTypes()`, a `_meta_type in [...]` filter). A row the route does
not read is `404` / `not_found`. An update or delete through the base of a
row whose own model is a subtype needs that subtype's action (`405` /
`op_not_allowed`) and authorization: with `resolvePrincipal`, its sign-in and
`<collection>.<action>`, then its `authMiddleware` decision under its own
name; without, that decision, or its `api.public` without middleware. Every REST server also
admits each subtype per request (`settleFamilyAdmission`): its rows are read
through the base only when it is switched on for the request's tenant and, for
a read, the caller may read the subtype itself (its `authMiddleware` decision
under its own name, or its `api.public` without middleware). Only subtypes the
server could serve are put to the exposure gate and middleware
(`familyMembersInScope`: on its model list, with a read or row operation open
on `api`), so a host needs no policy for a model it does not serve; a write to a
subtype row checks the subtype's exposure too (`404` / `not_found`). Reads of
an STI base under an `authMiddleware` vary by caller, so they are cached and
validated like reads with permission-gated fields. Membership is enforced by the bound request tenancy (above): a caller's own
`_meta_type` filter is intersected with the admitted types (none left serves
nothing), and a restricted point read resolves the segment as
`collection.get()` does, so a slug still finds its row. A plain `new APIGenerator()` spans the whole registry,
which may hold models the host never serves, so it does not refuse at
construction. Tests: `src/__tests__/rest-model-identity.test.ts`.

A create through an STI base selects a subtype with `createType` (or
`_meta_type`). The base's surface decides whether the base accepts creates; the
selected subtype's own surface decides too. Every transport calls
`assertCreateTargetSurface(base, target, surface)` (`src/create-target.ts`)
on what `ObjectRegistry.resolveCreateTarget()` returned: runtime REST and the
emitted SvelteKit POST route with `'api'`, the in-process MCP generator and
both emitted MCP servers with `'mcp'`, the CLI with `'cli'` (before it
prompts). A selected subtype also authorizes the create itself: runtime REST
runs its sign-in and `<collection>.create` when the host resolves principals,
then its `authMiddleware` decision (or its `api.public`), the emitted route
`requireCreateTargetAccess` (an authenticated principal and the family's
`<collection>.create` unless the subtype is `public: true`), even when the
base is public. A subtype that is abstract, has
`api: false` / `mcp: false`, or an `include` list without `create` (or an
`exclude` with it) on that surface is refused with `CreateTargetError`
(`CREATE_TARGET_UNAVAILABLE`, a typed 400) before anything is written. The MCP
create schema offers only subtypes `isCreateOpenOnSurface(name, 'mcp')`
admits, so the offer and the execution agree. The assistant tool loop
(`packages/chat`) checks the `api` surface, whose write policy and permission
catalog its manifest tools follow, and offers only subtypes open on it; the
CLI's `--createType` help and OpenAPI's `createType` enum list only subtypes
open on their surface. `resolveCreateTarget()` and `getCreateTargets()`
themselves do not read subtype surfaces (registry-owned). Tests:
`src/__tests__/sti-create-target-surface.test.ts`,
`src/__tests__/rest-sti-row-policy.test.ts`,
`packages/cli/src/__tests__/cli-create-target-surface.test.ts`,
`packages/chat/src/assistant-create-surface.test.ts`.

The same web virtual module exports `webMcpToolDefinitions` (#2518), a
canonical per-tool array selected independently of list materialization. Every
non-empty canonical API action set contributes tools, so get-only and
custom-action-only models are discoverable; custom actions declared on a
`SmrtCollection` merge into the owning row collection. Each definition carries
complete route and invalidation metadata. `collectionDefinitions` and its
embedded descriptor copy remain unchanged for existing cache-backed consumers.

Generated API clients share `selectApiClientEntries()` across the runtime Vite
module, its ambient declaration, and physical prebuild declarations. When a
collection class and its populated model share an endpoint, the model owns the
canonical collection key and row payload schema; the collection class remains
available under a deterministic class-derived secondary key. Selection and
collision suffixes must not depend on manifest insertion order (#2027).
Client entry selection skips the framework base classes exactly as route
emission does (`isFrameworkBaseClass`, #2642): a consumer aggregating
`@happyvertical/smrt-core` receives `SmrtObject`/`SmrtCollection`, and the
client must not advertise their CRUD or methods (static helpers included) as
callable actions that no route serves (#3295). Static model methods stay
collection-scoped (`method(options)`), instance methods item-scoped
(`method(id, options)`), matching the emitted route files.
Route emission iterates manifest objects in the same deterministic
qualified-identity order (`orderedManifestObjectEntries`), so when two models
share one collection the last writer of each route file — and therefore the
CRUD method set `resolveGeneratedEndpointCrudMethods` mirrors into
`smrt-client.d.ts` — is stable across scan orders (#2754).
The generated sync-apply route keys `SYNC_TARGETS` by segment and resolves one
owner per segment among models exposing a mutating op: STI base (an
API-enabled base without mutating ops fails the segment closed), else first in
qualified-identity order. A shared segment's registry key and write policy are
byte-stable across scan orders (#2807).
For aggregated manifests, inheritance and item-type references resolve exact
qualified names first, then package-local simple names, then a stable identity
fallback so duplicate class names across packages cannot reintroduce ordering.

Object row-type declarations (`XData` in `smrt-objects.d.ts`, `smrt-types.d.ts`,
the Vite ambient `virtual-modules.d.ts`, and the `@smrt/types` module) are one
per CLASS, selected by `selectObjectDeclarations()` in
`src/manifest/object-declarations.ts`; every emitter reads it. Built workspace
libraries list a consumed model under their own package name (#3110), so an
aggregated consumer manifest can name one class several times: listings with
the same absolute declaring `filePath`, `className`, and field shape collapse
to one declaration, rendered from the first listing in qualified-identity order
(#3296). A path alone is machine-local evidence, so a relative or missing
`filePath`, or disagreeing fields, keeps the listing separate. The aggregated
manifest itself keeps every listing.

Names follow the qualified identity when simple names collide (#3115): a
unique class keeps `${className}Data`; distinct classes sharing a simple name
each get a package-qualified name (`@ergot/market-core:LicenseSale` ->
`ErgotMarketCoreLicenseSaleData`), none keeps the bare name (a stem without a
known package is suffixed), and the generator warns with each name and every
listing it covers. The prefix is the package of the declaration's first
listing in qualified-identity order, which for a class relisted by consumer
packages (#3296) need not be the declaring package. One class whose listings
disagree on fields (a stale relisting) also forms a collision group, so it
loses its bare name until the stale package is rebuilt. Client and web declarations resolve row types
through `createObjectDeclarationIndex().interfaceNameFor()` and import them
(`import('./smrt-objects')`, `import('@happyvertical/smrt-virt-types')`);
a bare name does not resolve inside an ambient module.

The web module also emits a build-time **`manifestHash`** constant (#1764): `computeWebManifestHash(manifest)` is a deterministic, replica-stable digest of the emitted web-collection SHAPE (name/className/endpoint/idField/actions/fields/relationships), canonicalized (recursive key sort) before `sha256 → base64url`, truncated to 16 chars — so the same schema always hashes the same, and a field add/remove/type-change/edge-change changes it. A change means old persisted client rows may mis-hydrate, so smrt-web keys its durable persistence namespace on it and its `updateAvailable` contract signal compares against it. Four co-managed emission sites must not drift: the runtime value (`generateWebModule`), the `@happyvertical/smrt-virt-web` ambient d.ts (`vite-plugin/index.ts`), the physical `@smrt/web` d.ts (`prebuild/index.ts`), and the hand-written type mirror in `@happyvertical/smrt-web` (`packages/smrt-web/src/index.ts` — dependency-free, so textual sync only).

`webMcpToolDefinitions` is deliberately outside that digest: tool-only route,
identifier, or annotation changes cannot alter persisted row hydration.

Per-field web emission (#2046): `buildWebFieldDefinitions` carries `description` (from `@field({ description })`) and sanitized `ui` hints (from `@field({ ui: { basic, group, order, locked } })`, read off the manifest `_meta.ui` bag through per-key type guards) into each emitted field definition, and `buildWebToolDescriptors` threads the same `description` into browser MCP tool schemas. `sensitive`/`transient` fields are excluded from emission entirely, so their descriptions never ship. Both keys are conditional, so hint-less schemas emit byte-identical definitions (and hashes) as before; adding a description/ui hint changes the manifest hash — deliberate over-invalidation, harmless per the #1764 contract.

## MCP `get` serializers

A model may add an async serializer only to its standard generated MCP `get`
tool. Configure a module specifier and named export under `mcp.serializers.get`:

```ts
@smrt({
  mcp: {
    serializers: {
      get: {
        importPath: '@scope/package',
        exportName: 'serializeThingMcpGet',
      },
    },
  },
})
```

The named export receives `(item, options: PublicJsonOptions)` and returns the
get result (or a promise for it). Bare package specifiers resolve with ESM
conditions from the declaring model's loaded module, so the serializer's owning
package is an application dependency rather than a dependency of core or a
generic dispatcher. This anchor is independent of `process.cwd()`. Relative
references retain ordinary dynamic-import behavior. The MCP runtime imports
and caches the named module, then calls the serializer after normal
authentication, tenant-scoped lookup, and read access have admitted and loaded
the item. A missing or non-function export makes that `get` call fail. The hook
replaces only the standard `get` result; generated `list`, writes, deletes, and
custom actions keep their existing contracts.

The serializer owns its public projection. Start with
`item.toPublicJSON(options)`, and project each related model with that model's
`toPublicJSON(options)` before adding it. The final transport pass cannot make
arbitrary plain aliases permission-safe: returning a DTO does not cause fields
inside it to be filtered by model policy. Do not use `toJSON()` or spread model
instances into a serializer result.

## Generated MCP server output language

`MCPGenerator` builds every file as TypeScript, so the requested `outputPath`
extension decides what is written (#2279). `.ts`/`.mts` targets keep the source
verbatim for `tsx` or Node type stripping — which is why the generated source
must stay erasable-syntax-only (no parameter properties, enums, or namespaces).
Every other target (`.smrt/mcp-server/index.js` by default) is transpiled to
JavaScript with lazily loaded `oxc-transform` before writing, because the
printed run script and the generated `claude-config.example.json` both invoke
it with plain `node`. Ordinary core imports and `.ts`/`.mts` output therefore
do not load OXC's native bindings.
This keeps `typescript` dev-only in `@happyvertical/smrt-core`; generated MCP
source must remain erasable-syntax-only. A `.cjs`/`.cts` target is rejected
outright: generated servers are ES modules. `src/generators/mcp-emit.ts` owns
those decisions — do not reintroduce a bare `writeFile` of generated source.

Modular output writes `config`, `tools/index`, and `handlers/index` with the
entry point's own extension, and emits the entry's relative import specifiers
with that same extension, so the files it imports both exist and load with the
same module semantics — an `.mjs` entry gets `.mjs` siblings, not `.js` ones a
CommonJS package would then parse as CommonJS. The entry is written at the
requested path rather than a hardcoded `index.js`.
Generated code also has to be valid in an ES module: `arguments` is not a legal
binding name there, however convenient it reads.

## Inference status route (#4757)

`GET {basePath}/_inference[?tier=<tier>]` (`src/generators/inference-status-route.ts`)
on the runtime `APIGenerator` returns the ambient principal's `InferenceStatus`
(`{ available, mode, reason?, tier? }`, never a key), runs inside a
host-resolved principal's tenant, runs
`authMiddleware('_inference', 'status')` when one is configured, and refuses
non-`GET` with 405. SvelteKit apps serve the same body from their own
`+server.ts` with `createInferenceStatusHandler()`; no route file is
generated. Contract: [inference.md](inference.md#inference-mode-and-ai_unavailable-4757).

## Browser-plane playbook preflight route (#2590)

`GET {basePath}/_preflight?key=<playbook key>` (`src/generators/preflight-route.ts`)
is an advisory, read-effect, idempotent report of what a caller's playbook would
be allowed to do — capability *selection*, never authorization. Resolution and
verdict shaping live in `@happyvertical/smrt-playbooks`, which depends on this
package, so core takes the evaluator as the `APIConfig.playbookPreflight` seam and
the dependency stays one-way. Without a provider the route 404s.

**`authMiddleware` is never invoked by preflight**, and that is enforced
structurally rather than by discipline: `PlaybookPreflightRouteOptions` has no
auth member of any kind, and `rest.ts` passes the boolean `appAuthConfigured`
instead — so there is no handle in the module to invoke by mistake. A synthetic-
`Request` dry run is explicitly not an option: the middleware is request-bound,
returns a `Response` rather than a boolean, and may consult session stores,
rate-limit, or audit. The app-auth layer therefore reports `unknown`, which is the
honest answer, and a future `authPredicate` seam can fill it in without changing
the contract. `appAuthConfigured` is true when either `authMiddleware` or
`resolvePrincipal` is configured; the caller's permission slugs are the
request principal's.

The static layers preflight predicts against are exported from the same module —
`isApiActionEnabledForObject`, `isRestActionRoutable`, `isRestRoutePublic`,
`restFieldReadPermissions`, `restMethodForApiAction`,
`resolveRegisteredObjectName` — and `APIGenerator`'s own
`isApiActionEnabled` / `isRoutePublic` now delegate to them, so the route and the
prediction of the route cannot drift. Exposure and existence are separate
questions: `include`/`exclude` gate a route, they do not conjure one, so
`isRestActionRoutable` additionally requires a custom action to be declared in
`api.routes` — the only map `dispatchCustomCollectionAction` iterates. A custom
action is predicted against the verb its own route config declares, so a
`public: 'read'` opt-out neither silently covers a `POST` action nor falsely
denies a declared `GET` one. Every unresolvable key returns the provider's single uniform
"unavailable" body with an unconditional 200: unknown and unauthorized keys are
indistinguishable at the HTTP layer too.

## Emitted agent surface (#2591)

Generated model tools have always been build-time artifacts — virtual module,
manifest, knowledge graph. View intents (#2588) and playbooks (#2589) existed
only once something mounted, so "what can an agent do in this app" had no answer
short of enumerating every route. This closes that.

The same OXC scan that builds the manifest also runs the scanner's
agent-surface matcher (`ScanResults.agentSurface`). `smrtPlugin()` captures it
in `scanWithOxc`, projects it with `toKnowledgeAgentSurface`, and passes it to
`buildDomainKnowledgeManifest` as `agentSurface`. Note that declaration
discovery is NOT bound to the plugin's `include` glob — an app that scans
`src/lib/objects/**` for models still has its `src/lib/agent/*.intents.ts`
sidecars found (see `packages/scanner/AGENTS.md`). Two more consequences worth
holding onto:

- **It never touches `manifest.json`.** The runtime manifest stays
  runtime-focused; the agent-addressable surface is an agent/developer contract,
  so it lands in `.smrt/smrt-knowledge.json` and `dist/smrt-knowledge.json`
  only, under `agentSurface: { intents, playbooks, diagnostics }`.
- **It is passed in, not scanned in `knowledge.ts`.** The scanner carries a
  native parser binary and `smrt-core`'s main entry is browser-reachable, so
  core's sync knowledge builder must not import it. The Vite plugin already
  imports the scanner lazily on the Node side and is the only caller that writes
  this artifact.

The field is **omitted entirely** when a package declares nothing, which is what
makes it additive in practice rather than only on paper: every existing
package's checked-in artifact stays byte-identical.

Each declaring module gets a `sourceHashes` entry under the
`agentSurface:<package-relative path>` prefix (`AGENT_SURFACE_HASH_PREFIX`), so
EDITING an intent sidecar marks the artifact stale exactly like editing
`AGENTS.md` does (`stale-domain-knowledge`).

Hashes alone cannot see an **added** declaration, though: a brand-new sidecar
has no recorded hash to mismatch, the runtime manifest never carries intents,
and `AGENTS.md` is untouched — so every other signal stays green while the
artifact omits a real operation. `dev:knowledge-check` therefore also re-derives
the declaration SET from source and compares it to the artifact by identity,
reporting either direction as `stale-agent-surface`. The scan is bounded like
the numeric-precision lint: `src` only, behind the scanner's token pre-filter.

That re-derivation must model what the EMITTER sees, not merely what is on
disk, or it reports drift no rebuild can clear. Which files count is decided by
the scanner's exported `isAgentSurfaceSourcePath` — the same predicate the
emitter itself uses, never a list copied into the checker — and the per-file
results run through `mergeAgentSurfaces` before comparing, because the merge is
where a duplicate identity and a derived tool-name collision are resolved and
the artifact is the merged result.
Diagnostics are compared alongside identities: a sidecar containing only a
computed declaration adds no identity and has no prior hash, so without that,
"a diagnostic, never silence" would quietly become "a diagnostic, until the
artifact goes stale". The walk covers `<pkg>/src` while the emitter globs the
whole project root, so an emitted entry from outside `src` is not reported as
missing — this check did not look there, and claiming otherwise would be an
error nothing could clear.

Both `stale-*` codes are warnings by default and errors under `--strict`, which
is what CI runs. Alongside them: `agent-surface-missing-identity`,
`agent-surface-duplicate-identity`, and `agent-surface-empty-playbook` are
errors, and `agent-surface-not-static` and `agent-surface-tool-name-collision`
are warnings. A cross-file duplicate arrives as a *diagnostic* rather than two
entries — the scanner's merge already dropped the loser — so that diagnostic
maps to the duplicate error rather than the not-static warning; otherwise the
error would be unreachable for the case it exists to catch.

A `tool-name-collision` diagnostic (#2725) is derived from the MANIFEST, not
from the declaration: the plugin compares each emitted intent against
`buildWebMcpToolDefinitions` for the same build, which is already filtered by
the exposure policy, and appends the result to the surface. So it is excluded
from the drift comparison above — that pass re-derives declarations from source
alone and has no manifest, so counting one as "declared" would report every
collision as drift no rebuild could clear. The check is advisory and drops
nothing: `defineIntent` accepts the id, so the intent is emitted, and the
document-global tool-name lock (#2613) rejects whichever registers second — the
build-time notice is the earlier, cheaper form of the same answer. A build
cannot see the provider's WebMCP `namespace` or `effects` policy, either of
which separates the pair outright, so the message states that precondition
rather than asserting the collision.

`smrt doctor` prints the whole surface — model tools, intents, playbooks — from
these artifacts alone, with no application running.

## Collection exposure

A collection class is registered as a resource of its own, so every transport
generates operations for it (`<name>collection_create` MCP tools,
`<name>collection:create` CLI commands, routes for its public methods). It may
never publish more than its model. `registry/collection-exposure.ts` holds the
rule; the manifest generator applies it (`mergeInheritedFields`) and
`ObjectRegistry.getConfig()` applies it again at runtime, so a manifest built
before the rule is held to it too. For each of `api`/`mcp`/`cli` the collection
leaves unset, it inherits the model's: `false` stays `false`; an `include`
list keeps only its CRUD verbs (the other names are the model's instance
methods, so the collection's own methods stay closed); an `exclude` list is
copied; an open model leaves the collection open. A `sensitive: true` model's
collection gets read-only MCP; one that configures `mcp` itself keeps its
custom methods, but the runtime CRUD cap below still drops its MCP writes. The CLI treats
a collection's `include` as the complete allowlist, as MCP and REST do.

The scanner records the surfaces it copied as `inheritedExposure` on the
collection's manifest entry. At runtime those surfaces follow the model's
effective config, narrowed and never widened (`false` wins, `include` lists
intersect, `exclude` lists union), so a consumer that closes the model
(`registerOverride`, or a subclass manifest that replaces it) closes the
undecorated collection too. On `mcp`/`cli` the runtime also caps every
collection's generated CRUD verbs to the model's effective ones, decorated or
not; custom methods a collection lists stay its own opt-in, closed with
`registerOverride` on the collection class. `exclude: ['*']` is not a
wildcard any generator reads, so both the scanner and `getConfig()` normalize
it to `include: []` (fail closed; smrt-profiles `MagicLinkToken`). See #3468,
`registry/__tests__/issue-3468-closed-collection-exposure.test.ts`. Surface
tests must match `<model>collection_` tool names as well as `<model>_`.

A collection opens its own methods by listing them in its own `@smrt()`. A
collection decorator's config is merged over its model's at runtime, so repeat
the model's CRUD verbs (and storage keys) there. The build fails with
`CONFIG_COLLECTION_EXPOSURE` when a collection's own surface opens an MCP or
CLI CRUD write its model closes. Gates: `registry/__tests__/collection-exposure.test.ts`,
`packages/cli/src/__tests__/collection-exposure.test.ts`, and the cross-package
`packages/bundle-gate/src/__tests__/collection-exposure.spec.ts`.

## Explicit collection action resources

A typed `SmrtCollection<Model>` may declare `@smrt({ collection: 'operations',
api: { include: ['submit'] }, cli: { include: ['submit'] } })` to give its
custom actions a distinct route namespace. The explicit `collection` controls
routes; the collection still inherits its model's storage/schema. Without an
explicit namespace, the existing model collection name is inherited. When both
the model and its action host expose HTTP CLI commands in that inherited
namespace, discovery combines disjoint commands under the model resource shell,
while evaluating each command with its original class policy. Explicit duplicate
namespaces and overlapping routes/commands remain configuration errors.

HTTP CLI discovery includes only named custom methods in the collection's
`cli.include` that its API exposes. Boolean/default CLI config, wildcard-only
includes and `mirror: 'api'` alone do not opt a collection into discovery;
collections never advertise CRUD. Both static and instance collection methods
use collection-scoped URLs without an item id. Existing unsupported-signature
warnings and the handler's per-command policy still apply.

The collection must declare or inherit its real `_itemClass` and be registered
as that model's collection constructor. A facade may extend an undecorated
domain collection to retain its instance behavior; include that collection
ancestry in the consumer manifest. Generated startup retains its existing
side-effect imports and registers discovery metadata and exact live constructor
bindings only for named API/HTTP
CLI action hosts and their collection ancestors. Ordinary collections stay
side-effect-only. Runtime schema ownership also recognizes real
`SmrtCollection` prototype ancestry when a domain parent is not registered;
class names and `_itemClass` alone do not exempt a model from table ownership. Generated routes resolve the model's registry
identity and invoke the registered collection, not an arbitrary model instance.
A distinct route namespace does not change authorization: collection-hosted
writes retain the model collection's permission slug (#2977). Discovery is
capability filtering, not row authorization; the route and domain action remain
authoritative for authentication, permissions and tenant ownership.

## Subclass exposure

A model that extends another registered model (`Person extends Profile`, an
STI contract subtype, a CTI subclass) is generated as a resource of its own,
but every operation it inherits is its parent's. `registry/subclass-exposure.ts`
holds the rule; the manifest generator applies it (`mergeInheritedFields`,
before the collection pass, so a subclass's collection sees it) and
`ObjectRegistry.getConfig()` applies it again at runtime. For each of
`api`/`mcp`/`cli` the subclass leaves unset it inherits the parent's effective
value as is, and `sensitive: true` is inherited and cannot be dropped. An
abstract parent's synthesized write exclusions are not inherited: its authored
surface is, so its concrete subclasses can lift them.

A subclass's own `@smrt()` may narrow its parent's surface. The build fails
with `CONFIG_SUBCLASS_EXPOSURE` when it opens a CRUD verb or a parent method
(on REST, MCP or CLI, read the way each generator reads `include`/`exclude`)
that the parent closes, unless the subclass lists that operation in
`widenParentExposure: { api: ['create'] }`; a listed operation that widens
nothing also fails. Methods only the subclass declares are not checked. Gates:
`registry/__tests__/subclass-exposure.test.ts`,
`packages/cli/src/__tests__/subclass-exposure.test.ts`, and the cross-package
`packages/bundle-gate/src/__tests__/subclass-exposure.spec.ts`.

## Custom-action contract

`resolveCustomActionMetadata()` is the common discovery and invocation contract
for generated REST routes and API clients, MCP, CLI, WebMCP, and simple
REST-resource discovery. Receiver scope comes from the executable method, never a
configuration-only `api.routes[name].scope` override: instance model methods
are item-scoped and require `id`; static model methods and recognized
`SmrtCollection` methods are collection-scoped and do not accept `id`. Route
configuration may still choose its path and HTTP verb, but it cannot turn an
instance call into `ClassRef.action` or vice versa.

When scanner method metadata exists, discovery projects each named parameter
and its JSON-schema type, and invokers pass the values positionally in declared
order. The legacy single `options` bag remains compatible when metadata is
absent (or the declared method takes `options`). Do not infer this from runtime
function arity. An omitted typed `options` parameter remains `undefined`, so a
method's JavaScript default initializer continues to apply; an explicit `null`
remains `null`. Flat tool and CLI inputs reserve `id` for receiver parsing. If
an action declares an `id` parameter, its flat MCP/WebMCP field is `actionId`
(and CLI uses `--action-id`); REST keeps its independent path/body
namespaces. Typed CLI actions may use standard flag names such as `limit`,
`offset`, `where`, and `format` without those values being stripped as CRUD
flags.

A parameter typed with a bare alias name declared in the method's own module
(`type ActionOptions = Record<string, unknown>`) is resolved by the scanner
(`resolveParameterAlias`, `packages/scanner/src/oxc-parser.ts`). Chains are
followed, and the alias target is recorded as `resolvedType` beside the authored
`type`, using only the declaring module's aliases, so neither a same-named alias
elsewhere nor a subclass in another module can rebind an inherited parameter.
Schema emitters and argument decoders read `declaredParameterType(parameter)`
rather than `parameter.type`. A cyclic or over-long chain sets
`aliasUnresolved` and is advertised with no type constraint. An imported or
unknown name keeps the existing fallback, and the wire-ability gate still
judges the authored name (#4327).

MCP static dispatch resolves the exact qualified registry entry's model
constructor first, then its registered `collectionConstructor`. Manifest-backed
collection resources can retain a stub model constructor after generated
`registerCollection()` binds the live class; invoke the static method with the
selected constructor as `this`. Receiver resolution does not add tool exposure
or permit an item-scoped method to run without its ID.

Custom actions may return an explicit, domain-neutral failure object with
`ok: false`, `code`, and `message` plus optional `status`, `details`,
`retryable`, and `correlationId`. `normalizeCustomActionFailure()` redacts it;
generated REST returns `{ error: failure }` with the non-2xx status, while MCP
returns `isError: true` and `_meta['io.happyvertical/smrt']`. Opaque successful
objects (including `{ code, message }`) remain untouched; thrown exceptions are
not reclassified as domain failures.

Custom route metadata also classifies browser-tool effects. Set `effect` to
`read`, `write`, or `destructive`, with truthful `idempotent` and `openWorld`
flags. CRUD classification is fixed: list/get are read, create/update are write,
and delete is destructive. An undeclared custom action deliberately defaults to
destructive, non-idempotent, and open-world so a browser capability policy never
fails open.

Generated reads (`list`/`get`) on the REST and SvelteKit generators support conditional GET (helpers in `src/generators/conditional-get.ts`). ETag v2 (#1765): the validator is the table's change-feed version (`getTableVersion`) keyed by the request representation, so a **concrete** `If-None-Match` short-circuits into a 304 with an empty body **before** the collection query runs — an unchanged table revalidates with zero table scan. A wildcard `If-None-Match: *` is deferred until the payload builds (existence confirmed), so a missing item still returns 404, not a false 304. Tenant-scoped reads fold the active tenant into the representation (`resolveTenantEtagDiscriminator`) so one tenant's cached validator never satisfies another's read of the same URL. Routes whose GET renders via a **custom serializer** (which can load related tables the base-table version can't observe) keep the v1 body-hash ETag (`#1757`, query-first but correct); the default `toPublicJSON` path — all REST reads and non-serializer SvelteKit reads — uses v2. v2 is weakly consistent by design (the cost of not reading the data): a revalidation in the sub-statement window between a committed write and its feed append can return a stale 304 that self-heals on the next revalidation. The other v2 window — a deploy that changes the response shape WITHOUT a table write — is closed by the **#1764 ETag salt**: `computeTableVersionEtag(version, representation, manifestHash?)` folds the build's web-collection shape digest into the digest, so a shape-only redeploy busts every read validator (`undefined` reproduces the pre-#1764 unsalted value byte-for-byte for direct helper callers). The generated SvelteKit route bakes the digest in as a `MANIFEST_HASH` constant (via `generateConditionalGetRouteHelper`'s `manifestHash` option, sourced from `computeWebManifestHash(manifest)`) — automatic for the SvelteKit transport. The runtime `APIGenerator` auto-populates the same salt from the runtime registry with `computeRuntimeWebManifestHash()` when `APIConfig.manifestHash` is omitted; explicit `APIConfig.manifestHash` still wins for custom setups. The digest scope is get-OR-list (`selectWebEtagSaltEntries`), so **get-only** routes are salted too. Strong consistency still requires the v1 body-hash path. Cache-Control policy (unchanged from #1757): `private, no-cache` by default; public models may opt into shared caching via `@smrt({ api: { public: true | 'read', cache: { sMaxage } } })` → `public, max-age=0, s-maxage=<n>`; non-public models never emit shared-cache headers. Tenant-scoped models (any mode) never emit them either — bodies vary with session-cookie tenant context that URL-keyed shared caches cannot see; `sMaxage` is neutralized to `private, no-cache` with a one-time warning.

## Generated dev-plane route (#2782)

`src/vite-plugin/dev-plane-route.ts` emits `<routesDir>/_dev/[...tool]/+server.ts`
only when `svelteKit.devPlaneRoute.enabled === true` and
`@happyvertical/smrt-dev-mcp/dev-plane` resolves from the consumer under ESM
import conditions (the shared `consumerResolvesImport` guard used by
`_resources`; the subpath is `types`/`import`-only, #3913). The route is dev-only (`$app/environment`
`dev`, else 404), refuses to start without `SMRT_DEV_MCP_TOKEN` (503), and
delegates everything else to `createDevPlane`, passing `getSmrtConfig(...).db`
from the embedded access prelude (below) so the plane shares the app's
connection.
Core never imports smrt-dev-mcp; only the generated file does, at consumer
runtime. The route carries the auto-generated header so the sweep owns it.

Generated SvelteKit write routes (#2977) call `requireRoutePermission(locals, action)` after `requireRouteAuth`: CRUD writes need `<collection>.create|update|delete` and mutating custom actions `<collection>.<method>` in the session permission snapshot on `locals`, else 403 (fail-closed; `api.public: true` stays open, `tenantContext.superAdminBypass` skips). See `packages/users/agents/permissions.md`. Runtime REST enforces the same slugs when the host resolves principals; see "Host-resolved principal on runtime REST" above.

## MCP protocol identifiers (#3219)

MCP discovery preserves existing names matching `[A-Za-z0-9_.-]{1,64}`.
Previously invalid names use their first 31 sanitized ASCII characters, `_`,
and the first 32 hex characters of SHA-256 over the JSON tuple
`[original class name, lowercased action name, original raw tool name]`.
This makes long or punctuation-bearing identifiers deterministic without
collapsing common prefixes. Discovery reserves compliant names first and fails
closed on any duplicate raw name or final alias collision instead of advertising
ambiguous dispatch (including class names differing only by case across packages).
Consumers must use the advertised name rather than constructing one.

The generator retains a separate class/action binding for each descriptor and
emits that mapping for generated runtimes. Dispatch, task eligibility, tenant
scoping, ordering, and STI metadata use this binding; protocol aliases are not
execution identities. The advertised catalog still gates execution. The direct
runtime-template API accepts `toolTargets`; omitting it retains the legacy
`object_action` convention for existing direct callers. Supply explicit targets
for canonicalized names or class names containing underscores. This contract
does not change CLI, REST, or WebMCP identifiers.

`MCPGenerator.getToolIdentity(tool)` exposes the generator-validated original
class, action, and raw generated name to in-process catalog composers. App MCP
uses it for class allow-lists, tenant checks, and compatible workflow guards;
those consumers must not reverse protocol aliases. The alias remains the sole
wire tool name and is still the key for public patterns and generic tool policy.

`MCPConfig.classNames` scopes generation (simple names, case-insensitive, or
qualified `@scope/pkg:Class`); omitted, every registered class is a candidate.
A simple name matching more than one registered class throws (scope it by
qualified name). Each tool keeps its class's registry key, and configuration,
fields, methods, dispatch, tasks and collections resolve through that key —
never through the first same-named class. Generated servers (single-file and
modular) carry it as `registryKey` in their tool targets and task actions and
use it for every emitted collection, policy, class and STI-base lookup;
`objectName` stays the wire/display name.
A host with an allow-list passes it so the duplicate-name check runs over the
published set only: an unrelated collision among classes it never lists must
not fail its catalog or calls (#3490). App MCP always scopes its generators.

`MCPConfig.qualifyCollidingNames` is an opt-in for a host whose declared scope
contains unrelated models with the same aliases. Before live exposure filtering,
every tool of each colliding model gets its qualified registry identity as the
prefix, then the existing protocol canonicalizer handles punctuation/length.
Qualified `classNames` also reserve names for deferred, not-yet-imported models;
effective registered replacement aliases collapse to their actual identity.
Unique models keep their published aliases; the original name/class/action
binding never changes. Duplicate aliases within one model and any remaining
collision still fail closed. Keep the declared scope stable across recipe
changes: filtering the scope to enabled models would let an old alias retarget
another model. The cookbook host opts in over its entire installed catalog.
Class-scope tests cover unchanged default refusal, unique aliases, qualified
dispatch to two real SQLite collections, stable names across exposure changes,
and stale disabled-call refusal. The host suite includes two disabled colliding
catalog models so listing enabled tools cannot regress to a 500.

`MCPConfig.snakeCaseNames` opts into the stricter lowercase snake_case grammar
used by authored workflow adapters. The same canonicalizer preserves compliant
names, hashes invalid names with the original identity, sanitizes the prefix and
ensures a lowercase leading letter. Default protocol aliases remain unchanged.
The cookbook host selects this mode before projecting descriptors as workflows.
Its enabled-collision regression covers the actual workflow constructor; testing
only disabled colliding models would miss this consumer grammar boundary.

## Generated route collection access (#3416)

There is no generated route-access module. Every generated SvelteKit route
that needs collections (CRUD, custom actions, `_changes`, `_events`,
`sync/apply`, `_dev`) embeds the prelude from
`generateCollectionAccessImports()` (`sveltekit-config-import.ts`): it imports
the generated `smrt-register` module, then the app's config module
(`$lib/server/smrt` by default) as `* as smrtApplication`, and destructures
`getCollection`/`getSmrtConfig` from `createGeneratedCollectionAccess()`
(`src/generated-collection-access.ts`). Generation fails before writing
anything when `configFileName` resolves to the registration module
(`smrt-register` with any script extension or case).
That helper resolves per call, never caching: a legacy `getCollection` /
`getSmrtConfig` export wins (deprecated, warned once per module, for one
release), else the exported app-runtime `runtime.getCollection()` /
`classOptions()`, else it fails with an error naming the module. `_resources`
and static collection-scoped actions only need registration, so they import
`smrt-register` and then the config module. When the config module is missing
and `@happyvertical/smrt-app-runtime/sveltekit` resolves from the consumer, the
generator writes a runtime-shaped default instead of the legacy
`getCollection` file.

## Enum-constrained fields (#3598)

The scanner emits `enum: [...]` on a manifest field typed as a TS enum or
string/number literal union. Registry-sourced fields mirror it into
`_meta.enum` (`createFieldFromManifest` / `mergeManifestField`); read it with
`readFieldEnum()` (top level first, then `_meta`), never directly. Generated
tool schemas (`fieldTypeToJsonSchema`, so MCP and WebMCP descriptors), OpenAPI
(`swagger.ts`) and the legacy `generateSchemaProperties` emit JSON Schema
`enum` for `text`/`integer`/`decimal` fields only; a nullable field appends
`null` to the list so `type: [.., 'null']` still validates. The client web
collection `fields` map does not carry `enum` yet (it feeds the shape digest and
three hand-mirrored d.ts files); tool inputs read it from the manifest field.

## Custom-action permission aliases (#3878)

`@smrt({ operationPermissions: { run: { action: 'read' } } })` lets a custom
method reuse an existing CRUD grant in its own collection. Generated SvelteKit
POST routes and smrt-users operation guards resolve the same mapping; the
catalog emits the target grant rather than a second method-named permission.
CRUD itself cannot be aliased. Malformed declarations fail closed. Optional
`databaseActions: ['SELECT', 'UPDATE']` adds explicit PostgreSQL policy bindings
for the aliased grant (for example a status-only archive guarded by `create`
that must load its item before updating it). This is server-authored authority
metadata: grant only the actions the method needs, review it with the method's
model-level validation, and regenerate RLS policies when adopting a changed
binding.

Custom actions retain the `{ action, result }` response envelope.

## Collection-hosted REST factory identity (#4320)

Generated collection custom-action handlers resolve their executable collection
using the declaring resource's exact qualified registration key. Keep that
factory key separate from the item model's qualified type/policy metadata:
item collection slugs still govern permissions, and ordinary model routes keep
their own factory lookup. A resource in another package must neither rebuild
an item identity under its package nor steal the item's existing package when
its collection decorator merges configuration. Registration and generated
factory selection share one identity resolver; never install global aliases to
repair an inferred or bundled class name.

Every collection hosting a generated REST action receives its exact constructor
binding even with `cli: false` or omitted CLI configuration. This runtime-only
binding does not add discovery metadata: named HTTP CLI resources keep their
existing explicit-include eligibility. Constructor-only qualified receivers keep
their own collection-cache identity while resolving backing item metadata, so
ordinary model factories cannot reuse a different resource receiver. Neither
CLI nor MCP discovery gains a resource or default CRUD surface from this binding.

When consumer registration owns external packages (`smrtDependencies`), its
`.smrt/register.js` binds external REST action receivers using the resolved
canonical/provider-context export. The SvelteKit registration module continues
to delegate external imports there; external bindings also add no discovery
metadata and do not depend on CLI inclusion.

## Provider-facing tool schemas (`toProviderToolSchema`)

Generated MCP input schemas are valid draft 2020-12 but model providers accept
less: a `<model>_get` tool declares a top-level `anyOf` (id or slug) and OpenAI
and Anthropic both answer 400 for the WHOLE request when any one tool carries
it ("schema must have type 'object' and not have 'oneOf'/'anyOf'/... at the top
level"; "input_schema does not support oneOf, allOf, or anyOf at the top
level"), so one app model broke every model call. Any code that hands generated
tools to a provider (an assistant, an agent loop) must pass each `inputSchema`
through `toProviderToolSchema()` (`src/generators/provider-tool-schema.ts`): it
inlines local `$ref`/`$defs`, drops `$schema`, and removes top-level
`anyOf`/`oneOf`/`allOf`/`not`/`enum`/`const`, keeping `required` alternatives as
a description sentence. MCP clients keep the original schema. Test:
`src/generators/__tests__/provider-tool-schema.test.ts`.

Same-name app replacements select one effective route, collection, tool and row
type; upstream manifest declarations remain for ancestry. See
[app-subclasses.md](app-subclasses.md).

## Shared STI create identity

Runtime REST collection discovery resolves a shared collection to its effective
STI root even when a subtype registered first. An explicit child namespace uses
its oldest matching ancestor, so deeper descendants cannot retarget it.
MCP's discriminator catalog walks
qualified ancestry through registry replacements, so provider children remain
selectable after an app replaces their same-name base. Omitted discriminators
create the effective base; explicit MCP discriminators must name an advertised
family member. Unknown or unrelated identities fail before any create.

| Invariant | Trigger and positive case | Failure/control | Context and executor | Edge / level | Command |
| --- | --- | --- | --- | --- | --- |
| Shared CRUD owner | Profile/Bot and generic family, explicit branch namespaces, either registry order, base and same-name app root | Subtypes never replace base metadata | Users catalog, no database | Assistant dispatch metadata / regression | users `pnpm test` |
| Default create | REST, MCP, CLI create handler and assistant choose Profile or generic root | Persisted discriminator is never the sibling's | Authenticated transport or authorized principal stub, one in-process SQLite handle, ordinary create lifecycle | Generated dispatch / integration | users `pnpm test` |
| Explicit CLI selector | JSON file names a valid descendant | Unknown, unrelated and sibling identities fail before creation | CLI create handler and public collection, in-process Node/SQLite | Discriminator validation / regression | users and core `pnpm test` |
| App root and children | Child-first REST and MCP create app Profile; explicit provider Person stays Person | Unknown/unrelated MCP discriminator writes nothing | In-process Node and SQLite for app fixture; recording collection for rejection | Qualified identity / integration and unit | core `pnpm test` |

These changes select dispatch identities; mutation atomicity, rollback, SQL
syntax, tenancy and authorization contracts remain owned by existing collection
and transport tests. No new persistence algorithm or dialect-specific behavior
is introduced. The cross-path fixture executes SQLite, not external services.

## Live cookbook gating over AOT definitions

[Runtime exposure](runtime-exposure.md) is opt-in and separate from declaration
exposure. `MCPGenerator.generateToolDefinitions()` returns the build-time superset;
`generateTools()` is the live per-tenant listing. Runtime REST and generated
SvelteKit CRUD/custom actions gate before collection access; generated sync-apply
refuses disabled targets. Generated MCP servers filter static definitions on each
list/call and emit `notifications/tools/list_changed`. Static definitions, their
canonical tool names, route files and web manifest hashes remain stable.
`ObjectRegistry.getExposureModel()` resolves a collection to its effective row
model using the existing package-qualified collection resolver. Gates preserve
same-name replacement provenance and never substitute simple-name matches.

Provider-qualified MCP class scopes follow explicit app replacement provenance;
they never match an unrelated class with the same simple name. Generated hosts
with an app editor reuse the live MCP generator; see [app tools](app-tools.md).

## Public collection create targets (A1b)

`ObjectRegistry.getCreateTargets(collectionKey, context?)` describes the effective
`base` and its `subtypes` as exact registry `{ name, label }` choices, plus
`polymorphic`. Labels use `ui.label`, falling back to the model name. Collection
receivers resolve to their bound item model. Qualified declared ancestry preserves
provider children after same-name app replacement; unrelated classes and separate
tables never enter the family. Abstract children are excluded. Omit context only
for AOT artifacts; live offerings pass trusted `RuntimeExposureContext` to remove
disabled/unready children. No catalog is cached across cookbook changes.

`ObjectRegistry.resolveCreateTarget(collectionKey, input, context)` validates STI
create `createType` (qualified model id) or the compatible `_meta_type` alias. Conflicting,
malformed, unknown, foreign and gated choices fail before writes. It returns the
selected `name`/`label`, the `collectionName` receiver to execute, and `data` with
selectors removed. The original receiver is preserved for omitted/base selectors;
a selected subtype uses its exact collection. Every model keeps its ordinary
`type` field as business data. Apply the chosen collection's writable policy to `data` afterward; default creates retain receiver restrictions.
MCP (in-process and emitted), REST (runtime and emitted), CLI and chat share this
API; generated MCP no longer freezes a private discriminator map. REST OpenAPI
POST schemas advertise the same optional choices; pass `exposureContext` for live
documentation. Existing CRUD auth, permission and tenant gates still apply.

| Behavior/invariant | Reachable trigger | Positive case | Failure/control | Actor/context | Executor/transaction | Runtime/dialect | Contract edge / level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Family identity and replacement | All four create paths, provider/app fixture | Omitted selector persists effective base; explicit subtype persists child and own writable fields | Foreign/unknown/malformed/gated selectors write zero rows | Authenticated MCP/REST, CLI host and authorized principal stub; trusted tenant | Existing collection lifecycle on one SQLite handle; no new transaction algorithm | Node/SQLite | Registry → transport → persistence / integration | chat full test (`create-targets.test.ts`) |
| Live offerings | Same MCP/chat/CLI catalog and REST OpenAPI | Exact ids and human labels agree | Disabled child absent; child namespace cannot select parent | Trusted tenant, live gate | No persistence | Node | Catalog / integration | chat full test |
| Write policy and compatibility | Explicit subtype, legacy alias and plain model | Child writable field survives; selectors removed; STI business `type` retained | Readonly field excluded; conflicting aliases refused | Same authorized create | Existing collection and writable policy | Node/SQLite | Input boundary / regression | chat full test; core generator tests |
| Business classification | All four paths with a Content-style STI family | `type: "article"` persists for default base and explicit `createType` child | MCP/schema/OpenAPI/CLI offerings reserve only `createType`; no flat `type` selector | Same authorized create, provider and replaced base | Same SQLite handle | Node/SQLite | Transport schema and dispatch / regression | chat `create-targets.test.ts`; emitted REST runtime test; root content API suite |
| Users canary | Chat assistant's Profile create tool | Default Profile; explicit Bot via either selector; summary preserves type | Existing offer/execution authority tests remain | Real principal and tenant permissions | Existing SQLite chat/tool-loop fixture | Node/SQLite | Assistant → profiles / integration | chat full test (`tool-loop.test.ts`) |

No PostgreSQL/DuckDB execution is claimed by these new cases; no SQL, schema,
retry, atomicity or tenant-authority algorithm changes. Existing suites own those
contracts. Reuse search used configured MCP `review_smrt_project` (core/chat/CLI),
`build_context` architecture query for registry/collection STI create discovery,
the intent index, and `rg` name/purpose searches for create targets, STI variants,
subtype selectors and discriminator dispatch across core, chat, users, smrt-ui and
smrt-svelte. The existing MCP ancestry walk moved into its registry owner; existing
replacement, collection receiver and runtime exposure APIs supply its identities.
No new production file, component, model, route or tool was introduced.

Regression evidence: with the pre-change chat dispatcher restored temporarily,
both new Profile→Bot selector canaries failed (actual Profile); the three
selector-free Profile/Person/Bot controls passed. Restoring this implementation
passed all five. The dispatcher file was restored before final validation.

The first full-root run exposed the Content collision: `smrt-content`'s
`contents-api.test.ts` POST create returned 400 for business `type: "article"`.
The follow-up reserves `createType` across transports and leaves business `type`
untouched, including on STI families; the four-path fixture reproduces that input.
Emitted SvelteKit POST tests also call the real registry API for provider/app
families, check the exact receiver and child writable fields, and prove invalid
or gated selectors never reach collection creation.

## Unexpected HTTP failures

Both emitted SvelteKit routes and `APIGenerator.generateHandler()` preserve
typed 4xx failures. Other failures use the server-only
`reportUnexpectedHttpError(cause, request)` export: the framework logger receives
a fresh `requestId`, method, pathname and bounded, redacted Error cause chain.
Request headers, query parameters, bodies and arbitrary thrown objects are not
logged. The 500 body contains only `error: "Internal server error"` and that
`requestId`. Keep this helper out of the browser-safe typed-error module.

Reuse check: configured smrt-dev-mcp `review_smrt_project` (core, commerce,
smrt-web, smrt-svelte), the intent index, and `rg` queries for route errors,
correlation/request IDs, loggers, redaction, inline writes and template activation
across core, chat, smrt-ui, smrt-svelte and config found no shared opaque HTTP
reporter. New `src/generators/route-error.ts` composes the existing SDK logger,
config secret redactor and core database URL redactor. Its test file exercises
that helper; no duplicate logger, route, model or tool is introduced.

Hosted collection aliases select REST routes, not MCP class identities. The
class-scope regression applies aliasHostedCollections to two same-name models,
registers those distinct collections and proves default MCP still rejects the
ambiguous alias. The existing optional canonicalizer mode then yields two valid
workflow names with exact original identities. These are distinct protocol
boundaries; no additional REST or MCP alias mechanism is introduced.

## Runtime API discovery entry

`@happyvertical/smrt-core/api-actions` exposes the existing method-name, action-set,
custom-action and route-configuration resolvers for Node runtime discovery.
Their implementation lives with the pure manifest projection in
`vite-plugin/web-collections.ts`. The SvelteKit emitter re-exports those same
bindings for compatibility; runtime consumers must use the leaf rather than the
Vite-plugin barrel. This keeps route emission and resource discovery on one
policy without importing the emitter, activation generator or scanner build graph.
Existing emitter/web projection tests cover CRUD, custom receivers, withheld
methods, replacements, collection ownership and malformed config. The published
root/leaf guard also checks binding identity with the old build API.
