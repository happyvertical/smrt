# @happyvertical/smrt-app-shell

An ordinary smrt app (SvelteKit + adapter-node, app-runtime **local** profile)
that builds and runs a person's own smrt app from a versioned JSON definition,
for one person: the owner. Epic #4867; this package is #4872. The engine is
documented in [agents/engine.md](agents/engine.md) (it must not import
SvelteKit or `src/lib`). README has the route and JSON contracts.

Shared assistant adapters and legacy approval storage: [agents/shared-pieces.md](agents/shared-pieces.md).

## Where things live

| Path | What |
|---|---|
| `src/engine/` | `AppHost`, worker thread, migrations, calculated fields (`setCalculation`, core SDK expressions), definition reports (`runReport`, smrt-reports compiler), atomic bulk loads (`loadRecords`), QuickJS sandbox, drafts (`forkDraft`/`previewPublish`/`publishDraft`/`undoTo`, frozen host, draft-only `autoApprove`; see engine.md "Drafts"). Finished and tested on its own. |
| `src/lib/objects/` | Shell models (`objectsDir` in `vite.config.ts`): `App`, `AppVersion`, `Approval`, `AssistantThread`, `AssistantMessage`. |
| `src/lib/server/smrt.ts` | `createSmrtSvelteKitRuntime`, `prepareDatabase`, `configureShell`. |
| `src/lib/server/registry.ts` | The ONE startup registration path (permissions, preference kinds); `smrt.ts` imports it before the runtime. app-runtime grants newly registered permissions to an existing owner on every start. `registry.test.ts` guards it. |
| `src/lib/server/schema.ts` | `prepareShellSchema(db)`: additive first-run schema. |
| `src/lib/server/host.ts` | Holders: shell db, data root, the LIVE `AppHost` (`getHost`, never the draft) and the open-draft slot; `hostFor(target)` is how a request reaches either; restart adoption of an open draft (re-freeze live, reopen the draft with `autoApprove`). |
| `src/lib/server/target.ts`, `drafts.ts`, `view.ts` | The copy a request names (`live`/`draft`, `CallScope`), the draft lifecycle (start, describe, preview, publish and discard apply, History grouping) and the owner's saved view. README "Draft then publish (the shell)" lists routes, payloads, events. |
| `src/lib/server/version-store.ts` | `ShellVersionStore` (engine `VersionStore` on `AppVersion` + the `App` row; `commit` is one transaction, a publish's draft mark rides in it) and `DraftVersionStore` (`AppDraftVersion` rows of one `AppDraft`). |
| `src/lib/server/owner.ts` | Owner check, `Principal`, `assertOwner`, `runAs`. |
| `src/lib/server/approvals.ts`, `approval-store.ts` | Shared-authority storage adapter and shell action executor; the only place `approved: true` is set. |
| `src/lib/server/engine-tools.ts` | New engine catalog adapters: owner check, explicit structure/record targets, builder approval path. |
| `src/lib/server/builder.ts` | `runCommand`/`runAppTool`/`runRest`/`requestRecordDelete`: execute or turn into an Approval. |
| `src/lib/server/catalog.ts`, `policy.ts`, `mcp-server.ts` | Merged tool catalog, the one policy, the `/mcp` server. |
| `src/lib/server/http.ts`, `events.ts` | Route plumbing; in-process event bus for SSE. |
| `src/lib/server/inference.ts`, `inference-registry.ts` | smrt-inference host + controller over shell.db and the runtime's master key; `asOwner` runs a settings request as the verified owner; `installShellInference` registers the user resolver (the assistant's key source). |
| `src/lib/server/assistant/`, `src/lib/assistant/` | Assistant: turn loop, hold, config, routes (`mountAssistantRoutes`), thread store; chat column UI (`AssistantPanel`), pure reducer/stream parser, `guidance/system.md`. |
| `src/routes/+layout.svelte`, `src/lib/ui/layout.ts`, `src/lib/ui/menu.ts` | Shell layout over smrt-svelte `AppShell`: left sidebar (the person's app only), the chat column (`panel`), footer voice/assistant toggles, user menu (Approvals with count, History, Theme, Settings, Sign out). Plugin mode (iframe or `?embed=plugin`) has no chat or toggles. Chat open state and the sidebar collapse (`edgeToggles.left`, icon rail) are per owner in localStorage; `sidebarFooterDivider={false}` removes the footer line so it does not clash with the chat composer's border. |
| `src/lib/server/agent-cli/`, `assistant/agent-turn.ts`, `onboarding.ts` | Thin host adapters over smrt-inference/server (CLI, token scope, shell guidance/approvals), the `assistant` preference (engine, onboarding), onboarding routes; UI `routes/welcome`, `components/ConnectAi.svelte`, `routes/settings/assistant`. |
| `src/routes/settings/` | Settings menu (`ShellSettingsPage`), built-in sections, owner-only `inference/` (panel + actions over the shared controller). |
| `src/routes/` | `/api/shell/*`, `/api/app/[...path]`, `/api/events`, `/mcp`, `/setup`, health. UI pages are placeholders. |

## Invariants

- **Owner only.** Owner = ACTIVE membership holding the system `owner` role,
  looked up in shell.db on every check (`isOwner`); nothing in a token, header
  or body is trusted. Every route calls `ownerOf(event)` (401/403, same-origin
  for writes). Every `App.*` builder method and `Approval.decide/pending`
  starts with `assertOwner()`, which reads the async scope's tenant context
  (the session handler sets it; routes and `dispatchTool` use `runAs`).
  `operationPermissions` only aliases the generated routes onto CRUD grants, a
  member role may hold those, so `assertOwner` is the rule.
- **Approval gate.** A risky builder command, `<model>_delete` tool, REST
  `DELETE` or record delete never runs: it becomes an `Approval`
  (`pending_approval`, idempotent per identical pending action). Only
  `decideApproval` (called by `Approval.decide`) passes the engine's
  `approved: true`; `invariants.test.ts` fails if any other source does, or if
  a route reads an `approved` input. The engine refuses without it as well.
  `undo` is risky when the version being undone has a type conversion (it would
  overwrite newer values with the archived originals); `POST /api/shell/undo`
  then answers 202 `pending_approval` and History links to /approvals. The
  assistant pauses only on the out-of-band `CatalogResponse.pending` marker set
  by `dispatchTool` (from `requestApproval`), never on result text, and shows the
  stored Approval's summary and preview. `/api/app/sync/apply` and other
  reserved core endpoints are refused (only the app's own collections are
  served). Snapshots are retained (20 `method-*`; clean up prunes old
  `migrate-*`/`schema-*`).
- **Drafts and targets.** Every request names its copy; there is no ambient
  "current host". REST: `?target=` (`x-shell-target` on `/api/app/*`); MCP:
  the URL (`/mcp`, `?target=draft`, `?scope=assistant`); tools and the
  assistant pass a `CallScope`. Default live. `getHost()` is live only; the
  draft host is reached only via `hostFor('draft')`; `invariants.test.ts` keeps
  request paths on `hostFor` and `autoApprove: true` in `openDraftHost`. While a
  draft is open live is frozen (also after a restart): builder calls naming live
  are refused naming the draft; live records keep working. `publishDraft` is
  always an Approval (`publish-draft`, pinned to the preview digest; the engine
  refuses at apply if the chain changed); a discard is direct from the UI route,
  an Approval from a tool. Approvals only ever run against live. Table changes
  here are new tables only (`prepareShellSchema` cannot ALTER).
- **Decorator configs are literals** (`@smrt({...})` on `App`, `Approval`). The
  scanner reads them statically; a shared constant silently falls back to full
  CRUD routes. Collections are undecorated. The shell models expose only their
  custom operations (no generated list/get/create/update/delete); keep
  `mcp.test.ts` asserting that.
- **One policy.** `toolsFor(principal)` / `authorizeCall(principal, name)` /
  `callTool(...)` in `policy.ts` are the only entry for MCP tools (the `/mcp`
  route and the assistant). Non-owner: empty list, 403. App tools never shadow
  shell tools (`app_*`, `approval_*`; `defineModel` refuses those names).
- **Data layout.** `shell.db` is app-runtime's database file; the user app is
  `<data root>/user-app/` (`app.db`, `snapshots/`, archives inside app.db):
  plain files and directories inside the app-runtime data root, no symlinks, so
  the encrypted backup seals them. `PORT` and `SMRT_DATA_DIR` are honored (the
  desktop sidecar contract); health is `/api/_runtime/health` and the desktop
  wrapper's owner link is `/api/_runtime/owner-link` (both app-runtime handlers;
  the Tricia desktop product is `smrt-desktop/examples/tricia`).
- **App-subclass rule** lives in the engine (`enableRecipe` creates app
  subclasses of shipped models). The shell never registers user models in its
  own registry.
- **`prepareDatabase` consumer.** app-runtime's first-run schema hook is
  smrt#4835 (pending, another session). Until it lands the shell passes
  `prepareShellSchema` as the existing `prepareDatabase` option. Do not edit
  `packages/app-runtime` from here. Switching is one line in `smrt.ts`.
  `prepareShellSchema` only creates missing tables (no ALTER): a model that
  gains a column later needs a real migration step added there.
- **Generated change feed** (`_changes`, `_events`) is limited to the owner by
  `change-feed.ts`.
- `/mcp` is stateless Streamable HTTP, so `tools/list_changed` cannot be
  pushed on it; the UI and assistant listen to `/api/events` (`changed`).
  `tools/list` is sent with `ttlMs: 0`.
- Never log request bodies, tokens or definitions; `errorResponse` returns
  messages only, 500s are generic.

- **Assistant.** Same policy as `/mcp` (`toolsFor`/`callTool`). No tool
  decides approvals (`approval_decide` is not in the catalog, and
  `ASSISTANT_DENIED_TOOLS` repeats it): only the signed-in owner does, in the UI. A risky call is held (`holdForUser`) on its Approval; only the
  owner's `Approval.decide` applies it. The loop is bounded (`DEFAULT_LIMITS`),
  serial, aborts on disconnect. Three engines (`assistant` preference): `api`
  (`config.ts` refuses `claude-cli` and any configured `chatgpt-plan`; no
  in-app Claude subscription login), `chatgpt` (the owner's Sign in with
  ChatGPT, a PREVIEW for open source apps: `chatgpt.ts`, `assistant/model.ts`,
  README "Sign in with ChatGPT"; runs only on the target smrt-inference's
  sign-in resolver made for the `AppShellAssistantChatGPT` request, never an
  API key; `chat()` + `onProgress`, none of `maxTokens`/sampling/`user`/
  response format/reasoning/forced tool choice; the SDK keeps the credentials
  in `<data root>/chatgpt/chatgpt.json`, never read, logged or returned here)
  and a local agent CLI (`claude-code`/`codex`, the person's own signed-in
  tool; `agent-cli/`, README "The local agent CLI engine"). The CLI engine gets
  tools only through `/mcp` under a short-lived owner-bound `assistant.use`
  token in the child env (never argv, file or log), with every machine-touching
  built-in off, provider keys stripped and the stream guarded; never read a
  CLI's credential files or keychain, never offer or proxy its login (it opens
  the vendor's page itself), plain-text product names only. Approvals stay the
  shell's: `invariants.test.ts` keeps `agent-cli/` and `agent-turn.ts` free of
  `decideApproval` / `approved: true`. The API key is resolved by
  `resolveInferenceTarget` through the resolver `installShellInference`
  registered: the owner's key saved in Settings, then stored bindings, then
  config/env as `base`. Keys are written only by the owner-only `saveKey`
  action; none is logged or returned (`inference-settings.test.ts`). Model errors are never
  forwarded or logged beyond class/code (SDK messages can echo keys). Tests use
  a stub through `modelFactory`.

## Tests and build

`vitest run` then `vitest run -c vitest.dom.config.ts` (the layout's jsdom component tests, `*.dom.test.ts`, over smrt-svelte's built `dist`; rebuild smrt-svelte first). Node suite: in-process, SQLite, temp dirs; `test-support.ts` seeds an owner
and a member; it opens the real driver because the vitest setup would
pre-create tables). `pnpm build` (tsc engine, `svelte-kit sync`, `vite build`;
the smrt() plugin generates `src/routes/api/{apps,approvals,_changes,_events,
_resources}`: git-ignored) and `pnpm typecheck` must pass. The `smrt()` plugin
needs the models in `src/lib/objects`, set via `objectsDir`.
