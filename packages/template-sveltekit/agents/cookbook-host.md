# Local cookbook host

`@happyvertical/smrt-template-sveltekit/host/server` exports
`createCookbookHost({ runtime, root?, title?, app?, assistant?, cli?, chatgpt? })`.
Construct it beside `createSmrtSvelteKitRuntime()` before startup. It registers
inference preferences/permissions before owner seeding. Export `host.handle` and
`host.init` from the app hooks. Mount `host.load` in the layout and these handlers:

| Route | Mount |
| --- | --- |
| `/api/_runtime/owner-link` | `GET = host.ownerLink` (auto-claim, launch-secret protected) |
| `/api/assistant/[...path]` | `GET`, `POST` from `host.assistant` |
| `/mcp` | `POST = host.mcp` |
| `/api/connect-ai` | `GET`, `POST` from `host.connectAi` |
| `/api/cookbook/prebuilt` | `GET`, `POST = host.prebuilt` |

This composition supports the **local single-owner SQLite profile**. It refuses
other profiles at startup; it does not claim PostgreSQL, hosted credentials or
cross-process engine sessions. Ordinary app model migrations remain the runtime's
responsibility. Host system tables store versioned cookbook engine state, per-user
engine selection and audit. Cookbook CAS and its change audit commit in one
transaction before publishing an engine. Each authenticated request re-reads
persisted state and the existing tenant pre-built-components preference. An
unreadable store closes the live gate. Template application conservatively always
requires approval: there is no heuristic claiming a database is empty.

The composition installs core's live exposure gate and cookbook tool service.
Generated REST uses the installed gate. Assistant offerings use chat's manifest
catalog and cookbook extra tools, with the normal principal dispatcher, tool
summaries and durable runtime owner approvals. MCP projects the **actual generated
MCP descriptors**, preserving package MCP restrictions and aliases, through the
existing app-MCP principal workflow seam. Tokens are verified by app-runtime;
each call rechecks scopes and live exposure. This endpoint is stateless HTTP:
clients re-list to observe changes; it does not advertise a notification channel.

Inference owns saved-key resolution, ChatGPT-plan connections, CLI detection and
subprocesses. The host supplies per-user selection and private runtime storage.
CLI credentials are scoped to the offered operation/permission intersection,
last 15 minutes and are revoked at turn completion. A bound CLI delete creates a
hold in the same chat thread; the existing assistant owner-decision route executes
the original operation once under its saved ceiling. External MCP deletes use the
shared non-thread continuation authority; pending results name their approval id
and `owner_approval_outcome`. The original caller can read the terminal result.
Settings can mount the existing AssistantApprovalCard without a thread id.

`host.inferenceSettings` is the existing inference settings controller. The app
mounts its own thin page load/actions using the signed-in session; it never adds
another key store. `host.cookbookApp(tenantId)` projects navigation through the
same gate. Only pass the trusted session tenant. Direct model URLs must resolve
an entry from that projection before rendering.

Browser layout:

```svelte
<script lang="ts">
  import { CookbookApp } from '@happyvertical/smrt-svelte/cookbook';
  import { createCookbookAssistant } from '@happyvertical/smrt-template-sveltekit/host/client';
  const assistant = createCookbookAssistant();
  let { data, children } = $props();
</script>
<CookbookApp {...data.cookbookApp} assistant={data.session.authenticated ? assistant : undefined} embed={false} phoneTabBar>
  {@render children()}
</CookbookApp>
```

The shell owns sidebar, assistant panel, content and phone opener. The supplied
registry is also its Provider's registry; `embed` omits the assistant component
entirely. Host-selected labels remain supported.

## Test design

All persistence cases are Node 26/in-process SQLite; external providers and
containers are excluded. Fake models and CLI fixtures are the external executors.

| Invariant / reachable trigger | Positive | Negative/failure | Actor/context and executor | Contract / level / command |
| --- | --- | --- | --- | --- |
| Gate on request | Enabled REST/MCP/nav visible | Disabled or preference off denies | Session owner/tenant, runtime-bound SQLite | HTTP and layout / integration / template test |
| Recipe activation | Assistant tool enables installed recipe, nav appears | Unknown/stale revision refused | Owner, one CAS + audit transaction before publication | Principal tool / integration / template test |
| Business records | Stub reads Customers and creates Profile + Customer | No Bot discriminator | Owner, existing manifest dispatcher/SQLite | Assistant stream / integration / template test |
| Durable delete | Pending hold, decision executes once | Deny, repeat, foreign owner/tenant, closure refuses | Captured actor/ceiling, runtime approval store and dispatcher | Decision HTTP / integration / template test |
| State restart/concurrency | Saved engine reloaded; one CAS succeeds | Failed audit rolls back cookbook; stale CAS refused | Two host state instances, same SQLite transaction | Persistence / integration / template test |
| Dock | Receives transport/registry, toggle changes visibility, phone opener | Embed mounts no assistant | Browser/jsdom, no SQL (presentation only) | CookbookApp / component / smrt-svelte test |
| Engine selection | Stored user's configured engine | Unknown/unready engine fails before authoring | Authenticated owner, inference fakes/subprocess fixture | Connect AI/chat / integration / template test |

Run each touched package's filtered dependency build, full `pnpm test` and
`pnpm typecheck`; root lint, format-check and strict knowledge check. App smoke
must additionally build, boot on a free port above 4900, owner-sign-in, make a
REST request and complete a stub turn.

## Reuse check

MCP `review_smrt_project` inspected template-sveltekit and smrt-svelte;
`build_context` searched SvelteKit host/template composition, cookbook runtime,
MCP and assistant. The configured server has context and model inventory tools,
not separate component/recipe/intent search endpoints. Read the intent index and
searched smrt-ui, smrt-svelte, chat, core, runtime, inference, preferences and
template by names and purpose: host/composition, mountAssistantRoutes,
AssistantDock/transport/registry, cookbook state/store, engine selection,
approval/hold, MCP workflow and subclass generation.

| New production file | Reused capability / reason |
| --- | --- |
| `host/client.ts` | Existing AssistantDock, HTTP transport and data-surface registry; supplies CookbookApp's new optional composition prop. No new chat UI or transport. |
| `host/server.ts` | Existing SvelteKit runtime, core engine/gate/recipe tools, generated MCP descriptors, app-MCP route, chat mount/dispatcher/approvals/summaries, inference adapters/connection/controller and ConnectAi mount. No existing template API composed these services. |
| `host/state.ts` | Existing cookbook engine's versioned state plus SDK SQLite transactions; the template owns host lifecycle and publication. Existing browser cookbook storage is a planner draft and preferences store UI deltas, neither provides cookbook-state CAS plus audit. No domain model or parallel recipe tool. |

Test-only fixtures reuse the package Vitest harness and existing SQLite/users
collections. `assistant-fixture.svelte` only observes injected dock props.

| Additional new production file | Search and reuse |
| --- | --- |
| `host/generate.ts` | MCP host/subclass context and `rg` same-name/app-subclass/generate in core, CLI and template. Uses installed catalog, cookbook validation and the existing replacement contract; no existing cookbook command generated these customization points. |
| `host/preferences.ts` | MCP package reviews; `rg` cookbook persistence/overview/shell settings across preferences, core, template and smrt-svelte. Composes existing preference kinds, overview store, shell adapter and recipe registry. |
| `host/settings.ts` | `rg` inference settings page/controller/saveKey in template and inference. Extracts the existing template actions, preserving permission checks before reading keys. |
| `host/sveltekit-client.ts` | `rg` signOut/postSetting/logout in template, smrt-svelte and users. Publishes the existing template helpers. |
| `host/InferenceSettingsPage.svelte` | MCP template review; `rg` InferenceSettingsPanel/settings page in template and inference. Moves the existing template page to a reusable data-prop component backed by the same panel. |

`cookbookSubclasses.test.ts` is a filesystem fixture proving regeneration preserves
app edits and refuses path escapes. `cookbookHost.test.ts` reuses the inference stub
CLI, runtime principal branding, users collections and SQLite.

## SQLite lazy host and live model publication

`createCookbookApplication({packageName, application?, lazyActivation: {manifest,
loaders, scope, alwaysOn?}, ...hostOptions})` creates the normal runtime and host.
Export its `runtime` from the app server module. Feed generated
`activationManifest`/`activationLoaders` from `smrt-register`, and opt into
`smrt({lazyActivation:true})` during generation. Its runtime preparation disables
eager full-registry schema creation and awaits the existing activation coordinator.
Boot reads the latest editor journal document for every checkpointed tenant,
falling back to that checkpoint/default only without history. It excludes only
declared custom-list identities from the fixed graph; pending journal recipes
are activated before editor replay. Host auth/chat/preferences/inference/approval models are
always on; the caller can supply an explicit always-on set. The ready gate is
composed with the cookbook/preference gate; recipe enables pass the coordinator
to the existing service before publication.

Before serving authenticated tenant data, the host opens `createAppModelEditor`
and awaits replay/publication. `host.modelEditor(trustedTenant)` is the server seam;
`modelEditorFor` supplies the landed `app.*` tools from the same service. Its
native holds own consumption; chat policy delegates those control tools instead
of creating a second hold. Publication
updates the normal cookbook engine and catalog, and supplies dynamic definitions
in layout data. The host handles those registered collection URLs with the existing
APIGenerator under session identity/permissions. Model screens merge these data
with AOT definitions, then apply the same enabled-model filter. Direct URLs retain
the gate. The core service imports recipe writes through the editor journal,
which is the durable authority. Host engine persistence is a derived checkpoint
with a monotonic revision. Custom lists and `app.*` tools remain available when
pre-built components are off; the preference still gates provider models/recipes.

Pass the projected raw cookbook to CookbookApp: it owns raw policy resolution and
uses the generated installed-recipe surface resolver. Hosts need no export map or
resolved field-policy copy. `cookbookModelCatalog` (core app-models) and
`coveredModels` (core cookbook/engine) expose existing engine projection helpers;
they do not introduce competing model-selection rules.

Non-thread native holds use the shared app-runtime continuation adapter with
executor-owned consumption. Cookbook context fingerprints remain unchanged.
Chat's existing owner list/decision routes and card handle these holds; generic
MCP deletes use continuation-owned consumption. Already executing calls do not
replay after a crash; generic external effects cannot claim transactional
exactly-once guarantees. No live provider account was used.

Follow-up reuse check repeated MCP reviews and name/purpose searches across
smrt-ui/smrt-svelte/chat/core/runtime/approvals. Existing host/server.ts and state.ts
compose activation, editor, migration tracker, engine projection and APIGenerator;
no new production file/model/component was added. The app removes its manual
surface resolver and reuses the existing owner approval card/transport.

The Profile fixture is now an empty same-name app subclass. The real customer
turn asserts exact upstream registration is absent, effective lookup returns the
app constructor, persisted create uses that app Profile discriminator (never Bot),
and Customer's JSON projects the linked Profile displayLabel. Published dynamic
definitions are cached only for editor-managed lists/fields; unchanged collections
retain their ordinary generated routes and are not duplicated in layout data.
CookbookToolError uses the existing workflow mapError contract, preserving authored
activation errors while unexpected exception details remain redacted.

The second rebase onto fcf069448e adopts C6's native journal publication path,
removing the host's former duplicate editor-import wrapper. New host tests hold
app.removeField from an assistant turn (one native hold), approve it, hold
app.removeList over MCP and recreate the host before decision. Template apply also
survives host/preview-cache recreation. An owner request resumes an approved but
unconsumed continuation after restart; executing calls remain explicit unknown
outcomes. Repeated outcome reads never replay an already completed call. MCP
control aliases reuse core's public toSnakeCase helper and preserve canonical slugs.

Publication reuses users' seedNewCatalogPermissions inside the existing embedded
transaction helper, so newly registered list operations get owner grants without
re-granting removed permissions. It runs before checkpoint publication. The host
fixture resolves permissions from the real SQLite role mappings instead of
injecting new-list scopes, and proves an old customers.create revocation stays
removed. Reuse search: MCP users package review plus rg seedNew/catalog/created
across users/runtime/core/host found this existing users upgrade API; no parallel
permission algorithm or helper is added.

## Rebased D1 verification (Node 26.8.1)

Base: `fcf069448e6144578bee8b5bfe01165cb56ff670`. Generated knowledge was
rebuilt with the full build, OKF and graph commands, not hand-merged. Dependency
builds passed for all six changed packages (48 tasks); the full root build passed
85 tasks. Full suites and each package typecheck passed:

| Package | Passed | Skipped |
| --- | ---: | ---: |
| core | 7016 | 513 (+4 existing todos) |
| smrt-svelte | 2052 Vitest + 5 Node + 4 conformance | 0 |
| template-sveltekit | 118 | 16 |
| chat | 1119 | 16 |
| app-runtime | 917 | 17 |
| content | 1276 | 3 |

Root lint, format-check, strict knowledge and all 87 instruction chains pass.
Knowledge retains seven existing ingestion static-surface warnings; Svelte
typecheck retains 29 warnings. Provider behavior uses fakes/stub CLIs only.
The SQLite disk-reopen continuation cases and live publication/permission tests
run in process. No container, desktop packaging or real account verification.

## Second integration rebase

Base `437a68c806191603fe1c00032e8b1fd0f3417f81` already contains the first
eleven D1 commits. The remaining six are replayed. Conflicts preserve both legacy
and continuation approval documentation, the card's presentation/detail props
and its optional thread transport. Generated pages are rebuilt, not hand-merged.
The authority audit retains legacy TTL/input options and settled waits.

Host interaction tests parameterize the Customer/Profile assistant scenario with
omitted and explicit `createType` selecting the same-name app Profile. MCP creates
that effective app base and refuses a gated Bot or unrelated model before writes.
These extend the existing gate, STI/display-name, recipe activation, reference
picker/publication and durable approval coverage; no host-side create dispatcher
is introduced. Reuse: public ObjectRegistry create-target APIs and the existing
MCP/assistant dispatchers, found through generators.md and name/purpose searches.
All new execution cases use in-process SQLite, fake providers and existing CLI
fixtures. Tricia's suites are run unchanged as downstream compatibility evidence.
