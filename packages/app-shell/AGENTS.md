# @happyvertical/smrt-app-shell

An ordinary smrt app (SvelteKit + adapter-node, app-runtime **local** profile,
or **cloud** for many owners: [cloud profile](agents/cloud-profile.md))
that builds and runs a person's own smrt app from a versioned JSON definition,
for one person per app: the owner. Epic #4867; this package is #4872. The engine is
documented in [shared engine](agents/engine.md) (it must not import
SvelteKit or `src/lib`). README has the route and JSON contracts.

Cloud profile (tenant scoping, accounts, what must not exist there): [cloud profile](agents/cloud-profile.md).

Starting the published server, graceful shutdown (SIGTERM/SIGINT drain), embedding on a host-owned listener (`./embed`: handler + drain), Node version: [deploy](agents/deploy.md).

Hosted inference (gate at startup, entitlement, caps): [hosted inference](agents/hosted-inference.md).

Per-tenant storage metering (`storage.bytes` gauge, one read, request-count seam for #5195): [storage metering](agents/storage-metering.md).

Workbook workflow ownership, upload limits, proof and recovery: [imports](agents/imports.md).

Shared assistant adapters and legacy approval storage: [agents/shared-pieces.md](agents/shared-pieces.md).

## Where things live

| Path | What |
|---|---|
| `src/engine/` | `AppHost`, worker thread, migrations, QuickJS sandbox, drafts (`forkDraft`/`previewPublish`/`publishDraft`/`undoTo`, frozen host, draft-only `autoApprove`; see engine.md "Drafts"). Finished and tested on its own. |
| `src/lib/objects/` | Shell models (`objectsDir` in `vite.config.ts`): `App`, `AppVersion`, `Approval`, `AssistantThread`, `AssistantMessage`, `ChangeBatch`/`ChangeCard` (changes waiting). |
| `src/lib/server/smrt.ts` | `createSmrtSvelteKitRuntime`, `prepareDatabase`, `configureShell`. |
| `src/lib/server/registry.ts` | The ONE startup registration path (permissions, preference kinds); `smrt.ts` imports it before the runtime. app-runtime grants newly registered permissions to an existing owner on every start. `registry.test.ts` guards it. |
| `src/lib/server/schema.ts` | `prepareShellSchema(db)`: additive first-run schema. |
| `src/lib/server/host.ts` | Holders: shell db, data root, profile (`shellProfile`, `requireLocalProfile`), the LIVE `AppHost` (`getHost`, never the draft) and the open-draft slot, keyed by tenant in cloud (its app on PostgreSQL when `appDatabase` is set); `hostFor(target)` is how a request reaches either; restart adoption of an open draft (re-freeze live, reopen the draft with `autoApprove`). |
| `src/lib/server/changes.ts`, `drafts.ts`, `target.ts` | Changes waiting (#5178): `changes.ts` owns the batch (cards are the truth; the draft copy is a private working copy rebuilt from them by the engine's `ChangeEngine`), `drafts.ts` is that copy's lifecycle (start, preview, publish/discard internals, History grouping), `target.ts` the always-live `CallScope` (+ `source`). Routes: `/api/shell/changes*` (JSON contracts in each route's header). |
| `src/lib/server/version-store.ts` | `ShellVersionStore` (engine `VersionStore` on `AppVersion` + the `App` row; `commit` is one transaction, a publish's draft mark rides in it; `commitIn` runs inside the hosted claim's swap transaction, #5470) and `DraftVersionStore` (`AppDraftVersion` rows of one `AppDraft`). |
| `src/lib/server/owner.ts` | Owner check, `Principal`, `assertOwner`, `runAs`. |
| `src/lib/server/approvals.ts`, `approval-store.ts` | Shared-authority storage adapter and shell action executor; the only place `approved: true` is set (`decideApproval`; `applyOwnBatch` is the owner's one-step Apply). |
| `src/lib/server/engine-tools.ts` | New engine catalog adapters: owner check, explicit structure/record targets, builder approval path. |
| `src/lib/server/builder.ts` | `runCommand`/`runAppTool`/`runRest`/`requestRecordDelete`: every structural command becomes a card (never live); record deletes become an Approval. |
| `src/lib/server/catalog.ts`, `policy.ts`, `mcp-server.ts` | Merged tool catalog, the one policy, the `/mcp` server. |
| `src/lib/server/http.ts`, `events.ts` | Route plumbing; in-process event bus for SSE. |
| `src/lib/server/inference.ts`, `inference-registry.ts` | smrt-inference host + controller over shell.db and the runtime's master key; `asOwner` runs a settings request as the verified owner; `installShellInference` registers the user resolver (the assistant's key source). |
| `src/lib/server/assistant/`, `src/lib/assistant/` | Assistant: turn loop, hold, config, routes (`mountAssistantRoutes`), thread store; chat column UI (`AssistantPanel`), pure reducer/stream parser, `guidance/system.md`. Definition report results use shared `ReportResult`; tool projections stay transient and stored summaries keep validated report links. |
| `src/routes/+layout.svelte`, `src/lib/ui/layout.ts`, `src/lib/ui/menu.ts` | Shell layout over smrt-svelte `AppShell`: left sidebar (the person's app only), the chat column (`panel`), footer voice/assistant toggles, user menu (Approvals with count, History, Theme, Settings, Sign out), the header `ChangesPill` (slot `header.end`, only while changes wait; the Live/Draft switch and bar are gone), the one `changes` state loaded by the layout (`DEPENDS.changes`, driven by the SSE `changes` event) that the pill, `/changes` and History read, and a `ToastViewport`. Plugin mode (iframe or `?embed=plugin`) has no chat or toggles. Chat open state and the sidebar collapse (`edgeToggles.left`, icon rail) are per owner in localStorage; a fresh owner starts with the sidebar collapsed to the icon rail and the chat closed (a saved choice wins); the rail footer is one centred column (mic, chat, account); `sidebarFooterDivider={false}` removes the footer line so it does not clash with the chat composer's border. |
| `src/lib/server/agent-cli/`, `assistant/agent-turn.ts`, `onboarding.ts` | Thin host adapters over smrt-inference/server (CLI, token scope, shell guidance/approvals), the `assistant` preference (engine, onboarding), onboarding routes; UI `routes/welcome`, `components/ConnectAi.svelte`, `routes/settings/assistant`. |
| `src/routes/settings/` | Settings menu (`ShellSettingsPage`), built-in sections, owner-only `inference/` (panel + actions over the shared controller). |
| `src/routes/reports/`, `src/lib/ui/reports.ts`, `formula.ts` | Definition reports use shared `ReportResult`; owner-only result/CSV routes carry an explicit target. Display formulas in one place; never evaluate in the browser. `fields.ts` omits calculated values from save payloads; RecordForm shows outputs and RecordList sorts loaded values. See [draft UI](agents/draft-ui.md). |
| `src/routes/` | `/api/shell/*`, `/api/app/[...path]`, `/api/events`, `/mcp`, `/setup`, health and owner data pages. |

## Invariants

- **Owner only.** Owner = ACTIVE membership holding the system `owner` role,
  looked up in shell.db on every check (`isOwner`); nothing in a token, header
  or body is trusted. Every route calls `ownerOf(event)` (401/403, same-origin
  for writes). Every `App.*` builder method and `Approval.decide/pending`
  starts with `assertOwner()`, which reads the async scope's tenant context
  (the session handler sets it; routes and `dispatchTool` use `runAs`).
  `operationPermissions` only aliases the generated routes onto CRUD grants, a
  member role may hold those, so `assertOwner` is the rule.
- **Approval gate.** A `<model>_delete` tool, REST `DELETE`, record delete, or
  History's risky undo/clean up never runs: it becomes an `Approval`
  (`pending_approval`, idempotent per identical pending action). Only
  `decideApproval` passes the engine's `approved: true`, and it has exactly two
  callers: `Approval.decide` and `applyOwnBatch` (the owner's own Apply click,
  reachable only from the session route `POST /api/shell/changes/apply`);
  `invariants.test.ts` fails if any other source sets it or calls either, if
  a route reads an `approved` input, or if any tool/`/mcp`/assistant/`App`
  path can reach apply or undo (`requestApply`, `applyApproved`,
  `undoOwnBatch`, the engine's `undoBatch`). The engine refuses without it as
  well. Legacy `publish-draft`/`discard-draft` rows stay readable and cannot
  be approved; a stored structural `command` approval cannot reach live either
  (only undo/undoTo/cleanUp commands still run on approval). The assistant
  pauses only on the out-of-band `CatalogResponse.pending` marker set by
  `dispatchTool`, never on result text. `/api/app/sync/apply` and other
  reserved core endpoints are refused. Snapshots are retained (20 `method-*`;
  clean up prunes old `migrate-*`/`schema-*`).
- **Changes waiting.** Records are always live. EVERY structural command
  (builder tools, REST, `/mcp`, imports, loadRecords/extractModel/mergeRecords)
  entering `runCommand` becomes a `ChangeCard` in the open `ChangeBatch` and
  runs only on the working copy; live structure is frozen while any card is
  active and returns `status: 'change_waiting'`. Remove/put back/quick edit
  (label, choice options) rebuild the copy from the active cards
  (`ChangeEngine.rebuild`); a tail append runs incrementally; exact checks
  (`checkBatch`) run in a debounced, generation-guarded job after each
  mutation (`check-scheduler.ts`; it can only read and store results) and pin
  `digest` = `batchDigest(review digest, active (card, revision))`; Apply
  re-checks fresh and refuses (409 + blockers) while anything blocks, "Put it
  back"/"Remove those too" clear `depends_on_removed`. Records overwritten
  are shown, never blocking. Apply (owner only, `expect` = digest, optional
  `generation` CAS, 409 on mismatch) records and decides an `apply-batch`
  Approval, then publishes atomically. Undo of an applied batch
  (`POST /changes/undo {batchId, expect}`) keeps records added since. While
  changes wait, History undo/clean up are refused ("Apply or discard your N
  waiting changes first"); the assistant has no undo, apply or draft tool and
  its scope is constant (records live, structure to the batch). Its only
  card-editing tool is `change_revise` (comment turns, that one card, never
  applies); review questions (`change-review.ts`) and `answerReviewQuestion`
  only add visible options or a NEW card; `applyNowEligible` is the server's
  one rule for chat's "Apply now". Details: README "The assistant and changes
  waiting". An older
  open draft is adopted as opaque, non-removable cards. A workbook import
  records its commands as cards itself (`recordImportCommand`, one card per
  table, one group; it only records, never applies: [imports](agents/imports.md)). No request names a copy: `?target=`,
  `x-shell-target` and `/mcp?target=` are gone, `hostFor('draft')` is only for
  the working copy's checks/preview, and `autoApprove: true` stays only in
  `openDraftHost`. Table changes here are new tables only (`prepareShellSchema`
  cannot ALTER). Details: README "Changes waiting".
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
  the encrypted backup seals them; export, import and restore checks go through
  the engine's `portable-export.ts` (engine.md), never a direct open. `PORT` and `SMRT_DATA_DIR` are honored (the
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
  `prepareShellSchema` only creates missing tables (no ALTER, but the one
  `tenant_id` adoption for older desktop databases): a model that gains a
  column later needs a real migration step added there.
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
  token in the child env (never argv, file or log), with built-ins absent (Claude) or OS-confined (Codex; inference
  `agents/engines.md`), provider keys stripped and the stream guarded; never read a
  CLI's credential files or keychain, never offer or proxy its login (it opens
  the vendor's page itself), plain-text product names only. Approvals stay the
  shell's: `invariants.test.ts` keeps `agent-cli/` and `agent-turn.ts` free of
  `decideApproval` / `approved: true`. The API key is resolved by
  `resolveInferenceTarget` through the resolver `installShellInference`
  registered: the owner's key saved in Settings, then stored bindings, then
  config/env as `base`. Keys are written only by the owner-only `saveKey`
  action; none is logged or returned (`inference-settings.test.ts`). The assistant is tracked AI work (#5005): its system prompt is the
  registered prompt `app-shell.assistant.system` (`assistant/guidance.ts`,
  resolved through `resolvePrompt` on shell.db with the owner's tenant, so an
  app or tenant override applies; the changes-waiting line is appended per step), the
  `api` engine's model is a tracked model over core's `createTrackedAiClient`
  on shell.db (`assistant/model.ts`; no `getAI`, no transcript copy), and each
  turn opens one `turn` run (`app-shell.assistant.turn`) through smrt-chat's
  `AssistantTurnRun`: a usage row and `call` event per model call, `action` and
  `observation` events per tool call, a requested `approval` event when a risky
  call is held and its decision in the same run once the owner decides (the
  shell holds the turn in process; a decision made after the hold timed out
  is recorded once, in the thread's next turn run, with the request as its
  parent: `threadDecisions` reads the approval ids in the thread's tool
  chips), and messages by reference
  (`assistant-message:<id>`). With usage persistence off a turn answers the
  error `ai_tracking_disabled`. Test stubs through `modelFactory` are plain
  models and open no run. Model errors are never
  forwarded or logged beyond class/code (SDK messages can echo keys). Tests use
  a stub through `modelFactory`.

## Tests and build

`vitest run` then `vitest run -c vitest.dom.config.ts` (the layout's jsdom component tests, `*.dom.test.ts`, over smrt-svelte's built `dist`; rebuild smrt-svelte first). Node suite: in-process, SQLite, temp dirs; `test-support.ts` seeds an owner
and a member; it opens the real driver because the vitest setup would
pre-create tables). `pnpm build` (tsc models, `svelte-kit sync`, `vite build`;
the smrt() plugin generates `src/routes/api/{apps,approvals,_changes,_events,
_resources}`: git-ignored) and `pnpm typecheck` must pass. The `smrt()` plugin
needs the models in `src/lib/objects`, set via `objectsDir`. SvelteKit sync
loads the runtime Vite config, whose code generation reads the built manifests
of the packages listed in `smrt.config.ts`.
