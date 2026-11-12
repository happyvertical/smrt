# Local cookbook host

The real-HTTP CLI fixture in `__tests__/cookbookHost.test.ts` models a compatible
MCP-only host for both stream protocols: it accepts the locked flags, preflights
successfully, and calls the app MCP endpoint with built-ins absent. It does not
model native Codex 0.162.1's incompatible code-mode host; that version remains
refused as documented in inference's engine contract. The introduction assertion
uses the test's current cookbook (renamed Members plus enabled Memos), rather than
the earlier Customers-only snapshot. It still requires configured readiness and
the same full create/hold/decision/revocation behavior for both compatible stubs.

Cookbook/app workflow results return both text content and the same object as
`structuredContent`, matching the bridge's declared object `outputSchema`.
Current Claude Code and Codex clients reject text-only successful results when
an output schema is declared. This preserves the existing recipe service result
and its policy; it adds no execution or authorization path.

Host TypeScript entry points compile from `host/` to `dist/host/`; smrt-vitest's
workspace alias table maps public TypeScript host entry points back to their authored
sources. `host/InferenceSettingsPage.svelte` is a runtime component with an
effective `svelte` export condition. Only copied scaffold files under
`./template/*` are classified as `smrt.resourceExports`; runtime components must
remain subject to the packed runtime import and Svelte-condition checks.

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
The host opts into core's `qualifyCollidingNames` over the full installed model
scope. Unrelated same-name models cannot poison the catalog or trade aliases
when recipes change; unique model aliases and qualified dispatch stay intact.
It also selects core's `snakeCaseNames` mode so protocol-valid punctuation and
qualified aliases satisfy the existing workflow adapter's stricter grammar.

Inference owns saved-key resolution, ChatGPT-plan connections, CLI detection and
subprocesses. The host supplies per-user selection and private runtime storage.
CLI credentials are scoped to the offered operation/permission intersection,
last 15 minutes and are revoked at turn completion. A bound CLI delete, when the model declares MCP delete, creates a
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
  const assistantBase = createCookbookAssistant();
  let { data, children } = $props();
  const assistant = $derived({ ...assistantBase, introduction: data.assistantIntroduction });
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

First-run onboarding: [composition and test contract](onboarding.md).
## Apply-owned generation (D2)

`host/generate` adds `prepareCookbookHost({root?,objectsDir?,collectionAliases?})`
and `cookbookHostVite(options)`. The first composes the existing subclass,
installed-manifest, consumer aggregation, STI separation and snapshot APIs;
it writes immutable `.smrt/host-snapshots/<digest>.json` and `.smrt/host-options.json`. The second returns the normal
core preset configured with that snapshot, the installed recipe exposure
superset and `lazyActivation:true`. All provider models remain in the activation
graph; only recipe models and explicit cookbook features are hosted as routes.
User-owned feature identities do not get a second subclass.

Core's `aliasHostedCollections(manifest, aliases?, hosted?)` resolves collection
collisions in stable qualified-owner order; later owners receive a provider
prefix. Explicit model-to-collection aliases override that policy. Collection
classes follow their model. The original permission collection and storage table
stay attached. Unsafe alias segments are refused. This is host URL policy;
provider manifests are not mutated.

Mount `loadCookbookModelPage` as the model route's load and
`host/CookbookModelPage.svelte` with `data` and generated `collectionDefinitions`.
The loader composes the session, enabled cookbook entry and effective identity;
the component composes the existing RecipeScreens, entry source and reference
adapters. Dynamic definitions are merged through the same live screen gate.

The CLI's `cookbook-template/` overlay contains only ordinary app routes and
presentation plus calls to these public services. Generic profile-capable
`template/` remains the base. Local sign-in and settings use their original
runtime/controllers. No new assistant, persistence model or record CRUD exists.

D2 reuse: MCP package reviews covered CLI, core, template, profiles, commerce
and content. `build_context` searched snapshot/namespace, recipe prerequisites,
serializer defaults, source checkout and model-page composition; the intent
index and owning sources (including UI, Svelte, chat and core) were searched by
name and purpose. The configured MCP offers context/inventory tools, not
standalone component/recipe/intent search endpoints.

| New production paths | Existing implementation reused |
| --- | --- |
| `host/CookbookModelPage.svelte` | Extracted the existing product route's composition of RecipeScreens, createRecipeScreenEntry and createRecipeScreenReferences. No replacement screens or data source. |
| `cookbook-template/src/**` (route and server mounts) | Existing D1 product mounts, createCookbookApplication, preference/settings controllers, CookbookApp/SectionPage, ConnectAi and approval card. The model route mounts the extracted component/loader. |
| `cookbook-template/vite.config.ts` | New public cookbookHostVite over the existing core preset. |
| `cookbook-template/.pnpmfile.cjs` | The CLI-owned checkout hook; returns config unchanged for published installation. |
| `cli/scripts/source-checkout.cjs` | Moved the existing product checkout integration intact except enabling the published-config path. `rg SMRT_ROOT/local checkout/npm_execpath` found no existing source-link service; build forwarding reuses createPackageManagerRunner. |

New test `template-sveltekit/__tests__/cookbookApply.test.ts` uses the existing
apply engine and actual adapter Server with offline packages; it is not a new
runtime or domain helper. ProfileIdentityRecipe extends SmrtRecipe in the
existing profiles recipe file and reuses Profile/ProfileType; CustomersRecipe
requires it without importing foreign models into commerce's recipe models.

### D2 prerequisite visibility and rebase interactions

An identity prerequisite has models and an empty `nav`; keep it in the cookbook
for activation, migrations and framework tools. Do not add its classes as
`features`: that is explicit navigation placement. The model-page loader accepts
only shell entries, so unplaced identity URLs return 404 and reference pickers
retain lookup access without linking to an invented page. Core's `app.describe`
uses the same placement boundary for assistant-facing list names.

The four applied-host proofs check active Profile/ProfileType HTTP collections,
refused identity pages, refused installed-but-disabled Leases, every list screen's
cookbook title, and sidebar/shortcut paths. Their labels must come from selected
recipe menus or cookbook layout overrides. The in-process host regression combines
same-name Profile replacement, dependency-only exposure, reference-page mapping,
durable business removal across restart and refusal of approval replay.

The integration rebase keeps its compiled-host Vitest aliases; D2's package-root
fallback was dropped. Inference settings retains integration's Svelte runtime
export alongside the new cookbook page export. Generated knowledge is rebuilt.
Reuse search: MCP review/core architecture context, the intent index, and name
and purpose searches for prerequisite/nav/features/describeApp in core, Svelte,
chat and UI found these existing projections; this follow-up adds no production
component, model, route or file. The packed-consumer fixture extends its existing
external-version map with parent-qualified selectors; its isolated pnpm regression
verifies CLI's MCP SDK 2.3.1 and app-mcp's 2.4.0 coexist without global pinning.

Packed providers retain `importPath`/version provenance when authored source files
are not shipped. Host preparation removes foreign absolute `filePath` metadata that is missing or
outside the actual installed owning package (even if a publisher checkout exists) before computing the source-root boundary; app source and existing linked
provider files still require matching digests. The subclass/snapshot fixture proves
missing or existing out-of-package publisher source is omitted, changed app source
is refused, and missing
app source is never discarded. No fallback import or verification bypass is added.

The installed-package boundary reuses core consumer-plugin's existing
`findInstalledPackageJson` resolver, now public; it follows real workspace links
without assuming published package source exists beside its compiled exports.


## D2 onboarding integration rebase

The apply overlay opts into `onboarding: true`, mounts the existing host endpoint
and `FirstRunOnboarding`, forwards `assistantIntroduction`, hides shell chrome on
first-run screens, and exposes the existing Settings restart confirmation. Fresh
renders the shared empty state. No second onboarding authority or component exists.

The four real generated hosts exercise welcome → skip AI → Fresh → owner approval
→ empty app, then Settings-style restart → their template → approval → populated
sections. Each creates a named Customer using the declared inline name/email/phone
inputs, reads the projected name, and checks readable Customer table headers rendered from its
actual generated effective web definition. Identity routes stay active while identity
navigation/screens remain absent. Existing host tests retain restart-safe holds,
live exposure, explicit/omitted STI create dispatch and reference label controls.

Reuse check: repeated MCP `review_smrt_project` and `build_context` for first-run
composition, writeThrough and display.list; read the intent index and searched
FirstRunOnboarding/createOnboardingClient/first-run/typed Customer/default columns
across UI, Svelte, chat, core and template. New scaffold files
`src/routes/onboarding/{+page.server.ts,+page.svelte}` and
`src/routes/api/onboarding/+server.ts` reuse the landed product's thin mounts of
host.onboarding and FirstRunOnboarding. They contain no new workflow/helper/model.
The existing Fresh, settings and layout mounts are extended. The packed CLI route
test includes onboarding so pnpm cannot silently omit it. Integration's authored
source aliases remain the sole Vitest host-resolution mechanism.

## Onboarding write-through regression

`__tests__/onboardingWriteThrough.test.ts` starts with an empty cookbook and a
fresh local state root, claims an owner, completes onboarding/template approval,
and uses deferred activation with same-name app contact replacements. Each
bundled template exercises generated REST and the assistant create dispatcher
with a typed name/email and an untouched blank phone. It uses real SQLite,
sessions, permissions, approval and migration paths; only the external AI reply
and SvelteKit response helpers are substituted.

Reuse check: MCP review, the intent index and `rg` searches for onboarding, lazy
activation, cookbookHost, runtimeProfileReference, create-targets and inline
contact writes found existing host and generated-route fixtures, but none
combined fresh lazy activation with template approval and inline contact
creation. The new test composes the existing host, activation/route generators,
manifest catalog, real runtime writer lease and assistant stream reader. Its
empty Customer/Profile/ProfileType fixture subclasses reproduce the generated
app replacements; they add no production model or parallel write path.


The Q1 onboarding regression additionally starts each bundled template's contact
with name only, reads it through the generated item route, edits all contact
fields, reads projected list/detail values, clears email and phone, then checks
the refreshed list. It uses the same real owner session, template approval and
lazy activation path; it does not pre-apply a cookbook or replace REST handlers.

The CLI bridge mints scopes from its actual canonical MCP name map, intersected
with the original permission ceiling. The API catalog is larger than the package
MCP surface and must not inflate the token request (local tokens keep their
64-scope bound). No extra scope is minted for an operation that cannot be called.
The host stub regression asserts API-only deletes are absent from that bridge;
package MCP restrictions remain in force.

Yoga Studio's Customer omits public MCP delete; the bridge never widens it.
CLI turn tokens and tool lists use the selected cookbook's existing shell
placements, so dependency-only identity models remain available to framework
lookups without being offered as model-facing lists. Same-name app replacements
are matched through the registry's qualified identity. Inline Customer contact
inputs come from the existing write-through schema and ordinary save path.

The CLI path now captures thread-bound destructive MCP calls through the same
OwnerApprovalContinuations adapter as non-thread MCP. The existing chat owner
decision route resumes them with the original argument/permission ceiling, and
the executor rechecks the live MCP offer as well as permissions before effects.
No raw delete, new dispatch authority, route or approval store is added. The
driver observes the persisted outcome; a second decision cannot execute again.
The host publishes a persisted pending hold synchronously before returning its
MCP response; only terminal states are polled. This fixes a fast-response race
that reached chat's protected-result guard before the 100 ms poll. Observers are
bound to a random turn holder as well as the original thread/user/tenant, so an
unrelated hold cannot satisfy the wait. Approval ids from model output remain
unauthoritative. The extended CLI cases failed at that guard before this fix.

The per-turn `describeTool` callback reuses chat's existing label mechanism with
the shell's selected noun/label; successful inline create therefore says
“Added member Test Person” without exposing internal Profile identities. The
introduction reports only operations common to its offered lists, and model
guidance limits claims/alternatives to each live tool schema. It cannot promise
deletion for every list merely because one exposed list supports it.

Both stub CLI host cases check inline name/email/phone creation, inherited
contact-name projection, hidden prerequisite offerings, the canonical alias
mapping, recipe vocabulary, thread-bound continuation context, foreign-owner
refusal and one delete after approval with a refused repeat. Existing explicit
STI/replacement, reference-picker and restart/permission-revocation cases remain
intact; no separate model/reference dispatcher is introduced.

Local harness setup and Settings: [plugin mode](plugin-mode.md).

### Compiled cookbook catalog

`cookbookHostVite()` also provides `virtual:smrt-cookbook-app` (`app`). Pass that
value through the existing `createCookbookApplication({ app, ... })` seam to use
the validated build document and a slim installed catalog. The projection uses
`catalogFromManifests(manifests, true)`: recipe search/help is retained, model
schemas/methods are not. Model details still arrive through activation's deferred
data modules. Default file-based hosts remain supported. Rebuild after changing
installed recipes or the initial cookbook, as for the existing activation graph.
The preset's generated type directory receives `cookbook-host.d.ts`.

The generated module parses once and freezes its JSON records bottom-up. Both
activation preparation and host initialization share those immutable records.
Host initialization forks only its writable catalog envelope; app-model editing
continues to replace its own models array. Request/session/tenant state is not
shared through the catalog. Editable cookbook documents still use the engine's
existing independent copies, and registry schema copies remain independent.

| Behavior/invariant | Positive / negative case | Actor/context/executor/runtime/edge | Evidence |
| --- | --- | --- | --- |
| Slim catalog preserves features and recipe help | Existing catalog model selection plus optional rich projection; no object schemas in payload | Build-only installed metadata; no DB or provider requests; Node 26 + Vite public virtual module | Catalog unit suite, host generation suite and real Yoga/all-recipes harness |
| Immutable sharing preserves edits | Frozen model/array refuses direct mutation; host owns writable envelope | Separate per-tenant engine and model editor, existing transactions and permission checks unchanged | Host generation freeze test, full host model/history/approval tests |
| Unrelated modules remain untouched | Virtual resolve/load returns null for unrelated ids | Vite build/dev; no external contract | Host generation suite |

Reuse: MCP reviews for template-sveltekit/smrt-svelte and product app, the intent
index and searches by installed manifest, recipe catalog, virtual modules and
immutable metadata found `catalogFromManifests`, the host's `app` injection seam,
`prepareCookbookHost`, and the preset's generated type directory. No parallel
catalog, runtime route or provider implementation is added.

The same virtual module exports `initialApp` for the no-principal preferences
fallback. It uses `narrowCatalog` over the shared records, so resolving the initial
shell does not re-read every installed manifest. It contains only the initial
build document and no personal/request data. Person-specific preferences still
resolve `host.cookbookApp(principal.tenantId)` through the existing principal seam.

The host Vite plugin externalizes the Node-only `smrt-app-mcp` and `smrt-app-cli`
server seams. Plugin setup/config imports the CLI only inside its existing async
read/setup/connect operations, after the unchanged local-owner policy checks. This
keeps the published package responsible for resolving its SDK dependency and
preserves its deferred transport imports. Bundling a workspace-linked copy can
otherwise hoist the SDK into a shared host chunk despite dynamic imports. This
is a host packaging boundary, not an application-supplied external/alias list;
Node cookbook hosts already retain installed runtime packages. The generated
initial preferences data also preserves cookbook validation warnings.

The published-host startup test refuses CLI and MCP SDK resolution, then checks
the plugin's first-use read rejects with the original CLI import error. It fails
against the eager build. The existing real-token/SQLite/stdio plugin test still
covers setup, live tools, writes, owner decisions, revocation and secret refusal;
no auth, persistence, retry or protocol implementation is duplicated. Reuse searches
for CLI setup/config and bridge imports found `generateLocalMcpSetup`,
`saveCliConfig`, and the existing async plugin operations; no new helper is added.

## Assistant work profiles

The host resolves owner work-profile preferences in inference for each request.
Normal owner work defaults to assist; actual assistant calls while durable
onboarding is unfinished or rerunning use design. Deterministic Fresh/template
preview and apply remain the canonical onboarding operations. An assist design
tool attempt is intercepted before execution and admitted as a durable design
job; authenticated CLI MCP calls run the same check before side effects. Each
CLI binding also checks app-tool count and pass wall time before execution.

`createInferenceSettingsPage(host.inferenceSettings,host.workProfiles)` composes
the owner quality editor into the existing settings route. Missing engine/model
catalogs leave editing/reset usable. The preferences facade preserves live owner
checks, `inference.customize` and revisions. CLI fallback memos reuse host state,
keyed by owner, engine, requested model, CLI version, connection selection
generation and work-profile preference revision. Selection changes invalidate
old memos; an external CLI account change cannot currently be detected by its
sanitized status API. ChatGPT fallback requires a verified catalog rank, which
the current SDK projection does not provide.

[Durable design runs](cookbook-design-runs.md) use inference checkpoints and the
existing TaskRunner. The host installs its executor before starting one default
queue runner; `host.shutdown()` drains the runner and disposes its executor.
Internal passes reuse authenticated assistant adapters with a private server
profile binding, original permission ceiling intersected with live permissions,
read-only tools, full schema validation, and a detached job cancellation signal.
Technical prompts stay server-side; the owner sees each design summary and
reviewable operations. Current proposal runs cannot atomically apply a final
operation and checkpoint it; final review is explicitly pending. Preview-off
reports that blocker instead of pretending the operation was applied.

The existing assistant endpoint additionally handles owner-scoped design-run
status by thread and same-origin Stop/Resume. `createCookbookAssistant` enables
this transport so tab closure leaves the job alive and reopening restores its
progress. No profile grants authority, disables owner approval, or enables CLI
built-ins. Native CLI per-call output-token limits are unavailable; their token
settings are advisory while reported usage bounds subsequent passes.

Explicit Resume adopts current owner design aggregate token/time settings while
retaining consumed usage and the pinned engine, model and pass definition. A
lowered cap may pause the same run immediately; it never resets its allowance.
