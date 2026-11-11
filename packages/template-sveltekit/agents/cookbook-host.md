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
the original operation once under its saved ceiling. An unbound external MCP
delete refuses because it has no owned chat-thread approval continuation.

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

## Remaining approval integration boundary

Model-delete approval is mounted and tested end to end. The cookbook service's
`recipes.disable` and nonempty `cookbook.apply` holds use a cookbook-state
fingerprint, while chat's decision route expects a thread/principal continuation.
Those contracts currently do not compose: the hold prevents changes but cannot
be approved through the dock. A shared durable continuation adapter must preserve
the fingerprint, original permission ceiling and thread ownership, emit
`approval_needed`, and resume the service exactly once. Do not remove the hold or
approve a second synthetic request to bypass this boundary. External MCP deletes
without a bound chat thread also refuse. ChatGPT-plan and saved-key adapters are
wired to existing APIs; no live provider account was used.
