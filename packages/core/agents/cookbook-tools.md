# Installed recipe server tools

`@happyvertical/smrt-core/cookbook/tools` owns the seven recipe server tools.
The same service optionally supplies [app customization tools](app-tools.md). Their
schemas and execution are defined once by `createCookbookToolService`:

| Tool | Behavior |
| --- | --- |
| `recipes.search({query, limit?})` | Rank installed names, summaries, synonyms, model descriptions, navigation and supplied intent descriptions. Return human additions, dependencies, enabled status and revision. |
| `recipes.describe({id})` | Explain one installed recipe and its stable menu item ids. |
| `recipes.enable({id, expectedRevision, approvalId?})` | Engine `add_recipes`, including dependencies. Default: no approval. |
| `recipes.disable({id, expectedRevision, approvalId?})` | Engine `remove_recipes`, retaining required dependencies. Default: durable owner approval. |
| `recipes.configure({id, expectedRevision, fields?, items?, approvalId?})` | Atomic engine field policies plus cookbook navigation label/icon overrides. `fields` uses `set_policy` inputs; `items` uses `{id,label?,icon?}`. Null restores an override. Only this enabled recipe's fields/items are accepted. |
| `cookbook.listTemplates({})` | Bundled bakery, mechanic, welder and yoga-studio documents, or host `catalog.cookbooks`. Report missing installed ids. |
| `cookbook.apply({id, apply?, expectedRevision?, previewToken?, approvalId?})` | Default: preview, with before/after documents and added/removed recipes. Applying requires the same actor, tenant, revision, template content and preview token. A non-empty cookbook always requires approval. |

Templates select installed blocks; eager hosts must migrate them before serving.
Lazy SQLite hosts pass their `ActivationCoordinator` as `options.activation`;
enable and template apply await its full model closure before committing any
cookbook state. These tools do not install packages, generate code or rebuild an
app. Tokens last 15 minutes,
are bounded to 500 per service and are process-local; after restart/replacement
of the service, preview again. Durable holds remain in the host approval ledger.
The engine remains the sole owner of dependency and document validation rules.
Intent descriptions are supplied on catalog recipes as `intents: string[]` by the
host's installed manifest/knowledge projection; `RecipeDefinition`'s `summary`
and `synonyms` are consumed directly. Search is deterministic lexical ranking,
without inference, network calls or a second search index.

## Host integration

Install once, before requests:

```ts
import {
  createCookbookToolService, setCookbookToolService,
} from '@happyvertical/smrt-core/cookbook/tools';
import {
  createCookbookRuntimeExposure, setRuntimeExposureGate,
} from '@happyvertical/smrt-core/runtime-exposure';

const service = createCookbookToolService({
  activation, // optional: the lazy host's createActivationCoordinator result
  catalog, // installed recipes/models; omit cookbooks for the bundled templates
  engineFor: ({tenantId}) => store.currentEngine(tenantId),
  isOwner: ({tenantId, userId}) =>
    isApprovalOwner(db, {tenantId, id: userId}),
  can: (context, slug) => permissions.can(context, slug),
  approvals: ownerApprovalAuthority,
  isAppEmpty: context => store.hasNoAppRecordsOrConfiguration(context),
  commit: change => store.compareAndSwapWithAudit(change),
  audit: event => auditSink.record(event),
});
setCookbookToolService(service);
setRuntimeExposureGate(createCookbookRuntimeExposure({
  catalog,
  engineFor: ({tenantId}) => store.currentEngine(tenantId),
  predicate: (_model, {tenantId}) => prebuiltPreference.isEnabled(tenantId),
}));
```

`isAppEmpty` is a required host check of application records/configuration, so
an empty cookbook with existing data still requires replacement approval.

`commit` is a required host storage adapter: serialize writes or CAS the exact
`before` state, persist `after` and the provided audit event in the same
transaction, then publish a restored engine (`createCookbookEngine({catalog,
state: after})`) through `engineFor`. Refuse on stale state or failed storage;
never publish uncommitted state. The tool mutates a private engine until this
commit succeeds. Existing engine subscriptions and explicit runtime exposure
notifications refresh clients after publication. `audit` records reads, previews,
holds and refusals using the host's existing audit rail. Do not pass a no-op sink
in production. Hosts with multiple processes must invalidate each process's
engine/preference cache when persisted state changes.

With `activation`, enable/template writes await the coordinator before this CAS.
`activation_failed` includes a clear migration failure and leaves cookbook state
unchanged. A later authority, preference or CAS refusal may retain migrated code
and tables, but grants no tenant exposure. Approval consumption/completion keeps
its existing durable contract. Install `activation.gate(cookbookGate)` so model
readiness is also checked; the data-only recipe control tools can bootstrap an
empty cookbook under their normal live owner/preference checks.

`isOwner` must check live built-in owner membership (reuse app-runtime's
`isApprovalOwner`); `can` must check the operation slug. All seven tools require
both, even reads. Identity comes from the transport/principal, never arguments.
A missing tenant/user, unavailable engine, closed host predicate or permission
denial refuses listings and execution. `CookbookTools` is the reserved control
identity: the cookbook runtime gate checks its host predicate without requiring
an already enabled recipe. Model endpoints retain normal membership checks.

The `approvals` contract is structurally satisfied by app-runtime's existing
`OwnerApprovalAuthority`, backed by `createSqliteOwnerApprovalStore` and
smrt-approvals. Host UI decides the returned `approvalId`; re-invoke with the
original arguments and that id. The adapter checks tenant, requester, tool,
arguments and before/after state fingerprints, consumes once before effects,
and records completion. Live authority/exposure is rechecked before commit.
There is no model-supplied `approved` flag. `requiresApproval` can configure
other writes, including enable; it cannot waive non-empty template approval.

`setCookbookToolService` makes tools available to the existing in-process
`MCPGenerator` and generated single-file/modular servers. Generated stdio hosts
install the service in their registration/bootstrap and supply trusted
`SMRT_MCP_TENANT_ID` **and** `SMRT_MCP_USER_ID`; they have no per-request user
session. In-process MCP uses `MCPContext.user.id`. Recipe tools stay out of the
AOT model definitions; runtime lists/calls use the live service. Generated
catalog caches are private with zero TTL while the service is installed.

Chat/agents reuse the same schemas through the existing `PrincipalTool` seam:
`extraTools: context => service.assistantTools({surface: 'assistant', tenantId:
context.principal.tenantId, userId: context.principal.runAsUserId})`. Add only the
permitted slugs to the persona's `allowedTools`. Execution reasserts its principal
allow-list and operation permission, then takes identity from `run.context`.
No chat/app-shell tool implementation is required. Dispose registration with
`setCookbookToolService(undefined)` when retiring a host.

The tenant preference is `createPrebuiltComponentsPreference` in
smrt-preferences. Load it before serving; use its synchronous `isEnabled` in the
host predicate. An unknown/unreadable tenant is closed. Successful writes and
explicit invalidations notify `tools/list_changed`; retained tools still refuse.

## Test design and evidence

All persistence below is in-process SQLite; no PostgreSQL/DuckDB, desktop,
network MCP transport or host application wiring is claimed by this slice.

| Invariant | Trigger / positive | Failure control | Actor and executor | Edge / level / command |
| --- | --- | --- | --- | --- |
| Search and describe | Intent words find billing; human additions and enabled state | Unknown recipe, malformed input | Tenant owner; installed data catalog | Server schema / integration / core `pnpm test` |
| Live activation | Tool enables billing and customers; same REST handler 200, model MCP listed | Disabled 404, disable gates again; AOT definitions unchanged | Owner; two fixture package identities, SQLite | REST/MCP / integration / core `pnpm test` |
| Durable approval | Reopen authority, decide and consume disable | Changed args, foreign tenant, stale state, repeat call refused | Owner authority; canonical SQLite approval ledger | Cross-package hold / integration / core `pnpm test` |
| Configure | Policy defaults, labels, visibility and nav icon in snapshot | Foreign recipe target, bad icon, unknown field; whole batch unchanged | Owner; private engine, SQLite CAS + audit transaction | Engine/document / integration / core `pnpm test` |
| Template | Preview without mutation; fresh apply; non-empty apply held | Missing/stale preview or unavailable installed ids refused | Same owner/tenant; engine + SQLite store | Versioned document / integration / core `pnpm test` |
| Authority/exposure | All seven available to permitted owner | Non-owner, no permission, no tenant, unreadable store, preference off; retained assistant/MCP refused | Trusted principal, predicate | MCP/assistant / integration / core `pnpm test` |
| Atomic publication | Persisted state and audit commit together | Failed transaction leaves both storage and live gate unchanged | Host CAS transaction on same SQLite executor | Storage / integration / core `pnpm test` |
| Preference | Persist off, reopen, on with current revision; tenant isolation | Non-owner, missing permission, personal tier, invalid payload, stale revision, corrupt/unreadable storage | Ambient principal; existing preference store on SQLite | Preference / integration / preferences `pnpm test` |

Existing generated-server suites execute the single-file/modular code in plain
Node; their stubs forward the new core subpath to the actual implementation.
