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
| `cookbook.apply({id, apply?, expectedRevision?, previewToken?, approvalId?})` | Default: preview, with before/after documents and added/removed recipes. Applying requires the same actor, tenant, revision, template content and preview token. Replacement requires approval except trusted first-run setup with no application records. |

Templates select installed blocks; eager hosts must migrate them before serving.
Lazy SQLite/PostgreSQL hosts pass their `ActivationCoordinator` as `options.activation`;
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

`isAppEmpty` is a required, live server check of application records/configuration.
An empty cookbook with existing data still requires replacement approval. The
trusted context `initialSetup` may waive the cookbook-configuration part only for
a durable unfinished human first run; it is never a tool argument or MCP/assistant
flag. The template host counts the current cookbook list collections under the
actor tenant (including STI scope), excluding technical owner identity records.
Settings restarts never receive this context. The service checks emptiness again
after lazy activation and before commit; arriving data refuses the shortcut.

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
other writes, including enable; it cannot waive replacement approval for an app containing data.

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

The tool suites run on in-process SQLite and PostgreSQL/PGlite; no DuckDB, desktop,
network MCP transport or host application wiring is claimed by this slice.

| Invariant | Trigger / positive | Failure control | Actor and executor | Edge / level / command |
| --- | --- | --- | --- | --- |
| Search and describe | Intent words find billing; human additions and enabled state | Unknown recipe, malformed input | Tenant owner; installed data catalog | Server schema / integration / core `pnpm test` |
| Live activation | Tool enables billing and customers; same REST handler 200, model MCP listed | Disabled 404, disable gates again; AOT definitions unchanged | Owner; two fixture package identities, SQLite/PGlite | REST/MCP / integration / core `pnpm test` |
| Durable approval | Reopen authority, decide and consume disable | Changed args, foreign tenant, stale state, repeat call refused | Owner authority; canonical SQLite/PGlite approval ledger | Cross-package hold / integration / core `pnpm test` |
| Configure | Policy defaults, labels, visibility and nav icon in snapshot | Foreign recipe target, bad icon, unknown field; whole batch unchanged | Owner; private engine, SQLite/PGlite CAS + audit transaction | Engine/document / integration / core `pnpm test` |
| Template | Preview without mutation; fresh apply; non-empty apply held | Missing/stale preview or unavailable installed ids refused | Same owner/tenant; engine + SQLite/PGlite store | Versioned document / integration / core `pnpm test` |
| Authority/exposure | All seven available to permitted owner | Non-owner, no permission, no tenant, unreadable store, preference off; retained assistant/MCP refused | Trusted principal, predicate | MCP/assistant / integration / core `pnpm test` |
| Atomic publication | Persisted state and audit commit together | Failed transaction leaves both storage and live gate unchanged | Host CAS transaction on same SQLite/PGlite executor | Storage / integration / core `pnpm test` |
| Preference | Persist off, reopen, on with current revision; tenant isolation | Non-owner, missing permission, personal tier, invalid payload, stale revision, corrupt/unreadable storage | Ambient principal; existing preference store on SQLite | Preference / integration / preferences `pnpm test` |

Existing generated-server suites execute the single-file/modular code in plain
Node; their stubs forward the new core subpath to the actual implementation.

### Durable template preview receipts

When a validated template apply is held, its existing preview receipt is included
in the ledger's pinned context. An approved replay with identical original args,
requester and live template/revision can restore that receipt after a service
restart. Expired previews, changed templates, foreign actors and stale revisions
still refuse before effects. The native service alone consumes/completes its hold;
a host continuation must use executor-owned consumption. `tools.test.ts` recreates
the service between decision and replay to cover the restart boundary.

Lazy tool activation excludes only validated `models.lists` identities from its
fixed source graph; the editor owns their schema/readiness. Other unknown model
identities still fail activation. The SQLite/PGlite tool fixture enables billing beside
a declared custom list through the real coordinator, then proves an unrelated
unknown feature refuses. The host fixture combines list edits, reference REST and
subsequent recipe enable under this contract.

`cookbook.listTemplates` also returns `description` and `lists` from each
document and its resolved visible navigation (including cookbook labels).

Structural write definitions expose the trusted annotation
`annotations.workProfile: 'design'`; `assistantTools()` preserves it for chat's
pre-execution interception. This is intelligence metadata only: permissions,
revision checks and durable owner approvals remain authoritative.
`previewBeforeApply(context)` is an optional owner-preference callback, default
true. False permits cookbook application without a preview token but still
requires the current `expectedRevision` and all destructive approval checks.
