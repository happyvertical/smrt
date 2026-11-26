# @happyvertical/smrt-app-shell

A smrt app that builds and runs a person's own smrt app from definitions. One
person (the owner) signs in, changes the app (models, fields, code methods,
recipes) through builder operations or the assistant, risky changes wait for the
owner's approval, and every change is versioned and can be undone.

```
smrt-app-shell (SvelteKit + adapter-node, app-runtime local profile)
├── shell.db (the app-runtime database)  users, sessions, App, AppVersion, Approval
├── src/engine                    Shared AppHost: worker thread, migrations, sandbox
└── <data root>/user-app/                app.db, snapshots (plain files; the newest 20 `method-*` are kept, clean up prunes old migration ones)
```

## Shared assistant pieces (Tricia)

The saved data-shell product keeps its own assistant panel, routes, thread
history, builder and draft policy. Engines use smrt-inference; human tool
labels use smrt-chat; approval decisions/consumption use app-runtime's
`OwnerApprovalAuthority` and chat's observation-only hold bridge; connection
onboarding/settings use smrt-svelte's `ConnectAi` and `mountConnectAiRoutes`.

Existing approvals **stay in `approvals`**: no data copy, migration or new
approval ids. `Approval` is a compatibility model/endpoint facade and
`approval-store.ts` adapts those rows to the shared authority. Pending requests
retain their original indefinite lifetime, preview and requester. Decided
history retains its timestamps/results. Atomic conditional updates decide and
consume once across authorities; execution is recorded before live effects.
Interrupted approvals never replay automatically. An old approved row without a
result remains an unknown execution outcome and needs manual reconciliation.
The adapter refuses storage with more than one installation tenant because the
old rows do not encode tenancy; it cannot safely infer another ownership model.

Opt-in shared compatibility options preserve generic record chips, compact
connection wording/grouping, the settings-only ChatGPT model preference, API
selection without a configured key, and remote sign-out confirmation. The
shell keeps its existing sign-out fallback to the API preference, Fresh/Skip
steps, detailed builder/code previews and draft-review link. Other applications
keep the shared defaults. See [adapter contracts and validation](agents/shared-pieces.md).

## Run it

Build once, then set up the data folder and the owner link, then start the
server. Use the same `PORT` for setup and start, because the one-time link
carries it. Keep the data folder outside the checkout.

```sh
pnpm --filter @happyvertical/smrt-app-shell build
cd packages/app-shell
export SMRT_DATA_DIR=<a new folder outside the checkout> PORT=4796 HOST=127.0.0.1 ORIGIN=http://127.0.0.1:4796

node ../cli/bin/smrt.js app setup   # or `smrt app setup`: creates the data folder and issues the one-time owner link
node build                          # start the server with the same exports
smrt app open                       # opens the one-time /setup?token=... link; create the owner there
```

`node build` alone never prints a setup link, but a first start on a fresh data
folder (no owner yet) now saves the one-time link itself, so `smrt app start`
then `smrt app open` lands on Create owner without `smrt app setup` (the server
writes it to the app's state folder, 0600, only when none is saved or the saved
one is older than the token's 10-minute life (a running server checks every minute and renews an expired, unclaimed link); the token is never logged and the claim removes it). The link is not
in the data folder. If the link is lost, stop the
server and run `smrt app recover` for a new one. Setup is loopback only and
single use. Health: `GET /api/_runtime/health`.

From the registry package (no checkout): `npx smrt-app-shell`; SIGTERM/SIGINT drain open apps and exit within `SMRT_APP_SHELL_SHUTDOWN_MS`. A host that owns its own listener imports `@happyvertical/smrt-app-shell/embed` (`handler`, `drain`) instead. See [deploy](agents/deploy.md), which also states the supported Node version.

Desktop: the shell also mounts `GET /api/_runtime/owner-link`
(`createOwnerLinkHandler`), the route the desktop wrapper opens its window on.
It is loopback-only and answers 403 without the wrapper's per-launch secret, so
it does nothing outside the wrapper. With that secret it uses `autoClaim`: the
first launch creates the local owner (named after the OS account, no email) and
signs them in, a later launch with a lost session cookie signs the sole owner
back in, and the window lands on `/`. No owner form is shown. Under the wrapper
the signed-out and `/setup` pages say to quit and reopen the app instead of
naming terminal commands. Tricia, the packaged desktop product, is
[`smrt-desktop/examples/tricia`](../smrt-desktop/examples/tricia/README.md).

## Builder operations (MCP tools and `POST /api/apps/<operation>`)

The same names and parameters on both surfaces. A wrong-shaped argument is a
400 that says what to send (never a 500); a risky operation answers 202
`pending_approval` (REST) or returns it as the tool result (MCP).

| Operation (tool) | Parameters |
|---|---|
| `defineModel` (`app_definemodel`) | `name`, `fields?` (`{ fieldName: FieldDef }`), `label?` |
| `addField` (`app_addfield`) | `model`, `field`, `definition` (a FieldDef) |
| `changeFieldType` (`app_changefieldtype`) | `model`, `field`, `definition` (a FieldDef; REST also accepts the older `to`) |
| `hideField`, `removeField` | `model`, `field` |
| `renameField` | `model`, `from`, `to` |
| `removeModel` | `model` |
| `addMethod` | `model`, `name`, `method` (`{ description, code, params? }`) |
| `enableRecipe` | `recipe` |
| `cleanUp` | `keep?` |
| `importTemplate`, `exportTemplate` | `data`, `includeRecords?` |
| `undoTo` (`app_undoto`) | `version` |

A FieldDef is `{ type, label?, required?, choices?, ref?, calculated? }`; `type` is one of
text, number, integer, boolean, date, money, choice, reference, json. Field names
are camelCase (`dueDate`).

## Contracts for the UI and the assistant

Every route needs the owner's session cookie (401 signed out, 403 not the
owner). Writes must be same-origin `application/json`. Errors are
`{ error, code? }`. Live updates: `GET /api/events` (below).

| Route | Body | Response |
|---|---|---|
| `GET /api/shell/describe` | | `{ mode: 'live'\|'draft', draft: DraftInfo \| null, frozen, name, version, recipes, models: { [Model]: { kind: 'app'\|'shipped-subclass', label, table, className, extends, fields: { [name]: FieldDef }, ownFields: string[], methods: { [name]: { description, params } } } }, pendingApprovals }` (see [Changes waiting](#changes-waiting-the-shell)) |
| `GET /api/shell/history` | | `{ mode, versions: { version, parent, author, summary, createdAt, purged, current, publish: { draftId, name } \| null }[] }` oldest first |
| `POST /api/shell/undo` | none | change result `{ version, summary, statements, appRestartMs, ... }`; 409 if purged; **202** `PendingApproval` (with `preview.replaced`, the rows that would be overwritten) when the change being undone converted a field's type |
| `GET /api/shell/approvals?status=` | | `{ approvals: ApprovalView[], pending }`; `status` is `pending`, `approved`, `denied` or `failed` |
| `POST /api/shell/approvals/<id>` | `{ approve: boolean }` | `{ id, status: 'approved'\|'denied'\|'failed', result?, error? }`; 404 unknown, 409 already decided |
| `GET /api/shell/records/<Model>?limit=` | | `{ records: object[] }` |
| `GET /api/shell/records/<Model>?field=&equals=&limit=` | | The related records of one record: `{ records, total, truncated }` for the rows whose link field equals the id (`records` newest first by the model's main date field, else creation time, capped at `limit`; `total` counts matches among the first 1000 rows, `truncated` when that scan hit its limit). Owner only, one named copy; no new SQL |
| `POST /api/shell/records/<Model>` | the record's fields | 201 the record |
| `GET /PUT /api/shell/records/<Model>/<id>` | PUT: changed fields | the record |
| `DELETE /api/shell/records/<Model>/<id>` | | live: **202** `PendingApproval`, nothing is deleted until approved; draft: **200** `{ deleted: id }` |
| `GET /m/<Model>?where=<field>:<id>` and `/m/<Model>/new?with=<field>:<id>` | | Pages: the table filtered to the records linked to one record, and a new-record form with that link field set (saving returns to the linked record). Only a visible link field and a plain id are honored |
| `/api/app/<route>` (any method; copy in the `x-shell-target` header) | as the app's REST | the app's generated REST (`/api/app/chores` is the app's `/api/chores`); `DELETE` answers **202** `PendingApproval`; only the app's own collection routes are served (`sync/apply`, `_changes`, `_events` and unknown collections are 404) |
| `GET /reports`, `GET /reports/<name>` | | Saved report list and live result in the owner's saved copy; sidebar group appears when reports exist |
| `GET /api/shell/reports/<name>` | | Bounded engine result; labels and reference destinations remain separate from raw ids |
| `GET /api/shell/reports/<name>/csv` | | Server-generated RFC 4180 CSV, screen formatting, labels instead of ids, formula-safe text |
| `POST /api/shell/reports/<name>` | `{ action: 'rename', label }` (display label) or `{ action: 'rename', to }` (definition key) or `{ action: 'remove' }` | Existing builder result or pending approval; live structure is frozen during a draft |
| `GET /api/events` | | server-sent events |
| `POST /mcp` | MCP Streamable HTTP | shell tools plus app tools, one policy |

`PendingApproval = { status: 'pending_approval', approvalId, summary, preview }`.
`ApprovalView = { id, status, summary, preview, action, requestedBy, decidedBy, decidedAt, result, createdAt }`
where `action` is `{ kind: 'command', command } | { kind: 'tool', name, args } | { kind: 'rest', method, url } | { kind: 'record-delete', model, id }`.

`GET /api/events` sends `event: ready`, then `event: shell` with JSON
`{ type: 'changed', target, version, summary }` (definition changed: reload
`describe`, the menu and the tool catalog), `{ type: 'records', target, model }`
(`model` may be null: reload lists) and `{ type: 'approval', id, status, summary }`
(`pending`, `approved`, `denied`, `failed`). A `: ping` comment every 25 s.

Builder operations are static methods on `App` and also appear as generated
REST (`POST /api/apps/<op>`) and MCP tools (`app_definemodel`, `app_addfield`,
`app_hidefield`, `app_renamefield`, `app_removefield`, `app_changefieldtype`,
`app_removemodel`, `app_addmethod`, `app_enablerecipe`, `app_undo`,
`app_cleanup`, `app_exporttemplate`, `app_importtemplate`, `app_describe`,
`app_history`, `app_undoto`, `app_startdraft`, `app_previewpublish`,
`app_publishdraft`, `app_discarddraft`), plus `approval_pending`. There is no tool to decide an approval: only the
owner, signed in, decides in the UI, so no model-driven client (the assistant
or an outside MCP client) can approve its own call. The risky ones
(`addMethod`, `removeField`, `removeModel`, `changeFieldType`, `cleanUp`, an
`importTemplate` carrying code) return `PendingApproval` instead of applying.

### Policy module for the assistant

`src/lib/server/policy.ts`:

- `toolsFor(principal): Promise<CatalogTool[]>`: the merged catalog (`{ name, description, inputSchema, annotations?, side: 'shell'|'app', risky }`); empty unless `principal` is the owner.
- `authorizeCall(principal, name): Promise<CatalogTool>`: throws `PolicyError` (`status` 401 no principal, 403 not the owner or unknown tool).
- `callTool(principal, name, args, scope?)`: authorize and run on the copies `scope` names (default: live). A risky call returns a `PendingApproval`.
- `Principal = { id, tenantId, scopes? }`; get one from the request with `principalFromLocals(locals)` (`owner.ts`).

## Settings

`/settings` is the section menu (`ShellSettingsPage`): Appearance, Account,
Layout and Shortcuts, plus **Assistant** (`/settings/assistant`: the engine,
see Onboarding) and **Inference** (`/settings/inference`), the
`InferenceSettingsPanel` from smrt-inference. Owner only: every load and action
runs as the verified owner (a member or a stranger gets 403 before any body is
read). Saving a provider key (`saveKey`) binds it to its endpoint, stores it in
smrt-secrets (sealed under the app-runtime master key, created once into the
vault key store; `SMRT_SECRET_MASTER_KEY` wins), and `keySet` is read back from
the resolver's redacted view; the key itself never returns to the browser. The
shell registers smrt-inference's user resolver at startup, which is what the
assistant resolves through. The inference, preferences and secrets tables are
created by `prepareShellSchema` on first start (`consumer.packages` in
`smrt.config.ts` lists their packages). The load and writes are smrt-inference's
`createInferenceSettingsController`, shared with the template.

## The assistant

The chat column (`src/lib/assistant/AssistantPanel.svelte`, the `panel` of
smrt-svelte's `AppShell` in `src/routes/+layout.svelte`, mounted for the owner)
talks to `mountAssistantRoutes` (`src/lib/server/assistant/`). The layout is
left sidebar, content, chat (the chat sits at the right of the page, 400px by default); the voice and assistant toggles and the user menu
sit in the sidebar footer. Each model gets its own sidebar icon, picked from its name and fields (`src/lib/ui/model-icon.ts`) and stable across reloads. The sidebar collapses to an icon rail (nav icons with
tooltips, the footer controls as icons) from the chevron above the footer; the
choice is remembered per owner, and the footer has no divider line. The boundary between chat and content is a draggable
separator (arrow keys, double-click resets); its width and the open state are
remembered per owner. As a plugin view (iframe, or `?embed=plugin`) there is no
chat and no toggles: the host app is the chat. Voice mode shows as not
available yet; nothing connects speech to the assistant.
Owner session required on all of them (401/403); the POST is same-origin.

| Route | Body | Response |
|---|---|---|
| `GET /api/assistant/status` | | `{ configured: boolean, engine?, engineLabel?, code?, message?, action? }`; never a key, provider, endpoint or path. `engine` is `api`, `claude-code`, `codex` or `chatgpt`. `code` is `assistant_not_configured` (no API key), `assistant_provider_refused` (subscription provider configured), `ai_unavailable` (inference off), `agent_cli_missing` or `agent_cli_signed_out` (a local CLI engine that is not ready), `chatgpt_signed_out` (Sign in with ChatGPT not done); `action` is the link that fixes it |
| `GET /api/assistant/threads` | | `{ threads: { id, title, updatedAt }[] }` newest first |
| `GET /api/assistant/threads/<id>` | | `{ thread, messages: ThreadMessage[] }`; 404 for a missing or foreign thread |
| `POST /api/assistant/turn` | `{ message, threadId? }` | `text/event-stream`, `event: turn`, JSON `TurnEvent` (below). **503** `{ type: 'unavailable', configured: false, code, error }` when the assistant cannot run; 409 while another turn is running |

`TurnEvent` (`src/lib/assistant/events.ts`): `thread {threadId}`, `text {delta}`,
`tool_call {id,name,args}`, `tool_result {id,name,ok,summary}`,
`approval_required {id,name,approvalId,summary,preview}`,
`approval_decided {id,approvalId,status}`, `error {code,message,action?}`,
`done {stop}` (`complete | max_steps | max_tokens | timeout | aborted | waiting | error`).
Closing the request (the dock's Stop button, a closed tab) aborts the model
call, the running tool and any wait.

- **Tools.** The model is offered `toolsFor(owner)` (builder tools plus the
  app's generated tools); each call is checked against
  a fresh list and then goes through `callTool` (the same policy as `/mcp`).
  Non-owners get no tools and no assistant. Calls run one at a time, in order.
- **Risky calls.** A risky call returns a `PendingApproval`; the turn emits
  `approval_required` and is held (`holdForUser`) until the owner decides it
  (the dock's card POSTs `/api/shell/approvals/<id>`, so it goes through
  `Approval.decide`). The model is then told approved, denied or failed. If the
  wait times out or the client leaves, the model is told it is waiting, the
  turn ends as `waiting`/`aborted`, and the Approval stays pending, unapplied.
  The assistant has no way to set the engine's `approved` flag.
- **Engines.** Three, chosen by the owner (the non-secret `assistant`
  preference, `engine` = `api` | `claude-code` | `codex` | `chatgpt`; default
  `api`):
  - **API key** (`api`): `@happyvertical/ai` through core's inference tiers
    (`resolveInferenceTarget`, tier `good`, override
    `SMRT_APP_SHELL_ASSISTANT_TIER`). The key is the owner's, pasted once in
    **Settings > Inference** (`/settings/inference`, see below), or the
    deployment's: the `ai` block of `smrt.config.ts`, `SMRT_AI_*` or the
    provider's own variable (`ANTHROPIC_API_KEY`). The saved key wins, then the
    stored tier bindings, then config/env, so a desktop app launched from
    Finder works with no environment. The key is read only server side, never
    logged or sent to the browser. Subscription providers (`claude-cli`,
    `chatgpt-plan` from configuration) are refused here, as is any in-app
    Claude subscription login.
  - **Local agent CLI** (`claude-code`, `codex`): the turn runs through the
    person's own, already installed and signed-in Claude Code or Codex
    (`src/lib/server/agent-cli/`, `assistant/agent-turn.ts`). See below.
  - **ChatGPT** (`chatgpt`): the owner's own ChatGPT plan through OpenAI's
    official Sign in with ChatGPT flow (see below).
  With no usable engine, status/turn answer the typed not-configured state, the
  dock shows it with a link to fix it, and it checks again each time it is
  opened, so a saved key or a finished sign-in needs no restart.
- **Bounds** (`DEFAULT_LIMITS` in `turn.ts`): 8 model rounds, 2048 output
  tokens per call, 60 000 tokens per turn, 4 calls per round, 60 s per model
  call, 180 s of model/tool time per turn, 15 min per approval wait.
- **Guidance.** `src/lib/assistant/guidance/system.md` (bundled with `?raw`).
- **Threads** persist in shell.db (`assistant_threads`, `assistant_messages`).
- **Tests** inject a stub model (`modelFactory` option, `test-helpers.ts`).

The reusable CLI engine, ChatGPT model adapter and connection diagnostics live in
[smrt-inference/server](../inference/agents/engines.md). The shell supplies its
owner token scope, MCP route, thread persistence, draft guidance and approval
presentation through thin host adapters; its policy remains the authority.

### Sign in with ChatGPT (a preview for open source apps)

OpenAI's official flow for local open source apps, a **preview**: the
authorization basis and its limits are in OpenAI's
[preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
Claude has no equivalent here: its subscription stays on the Claude Code
engine below, and `claude-cli` and any in-app Claude subscription login stay
refused.

- **Sign-in** (`lib/server/chatgpt.ts`, smrt-inference's
  `createChatGPTPlanConnection`): "Sign in with ChatGPT" on `/welcome` and in
  Settings > Assistant. Under the desktop wrapper this process opens the system
  browser (`open` / `xdg-open` / `cmd /c start`) after checking the address is
  https on `auth.openai.com`; in a plain browser session the page shows a normal
  link. The SDK's loopback listener (127.0.0.1, PKCE, dynamic client
  registration, OIDC validation) receives the callback, the page polls until it
  is signed in and then selects the engine.
- **Credentials** live only in the SDK's own owner-only file,
  `<data root>/chatgpt/chatgpt.json` (directory `0700`, file `0600`, outside any
  source tree; the encrypted backup that seals the data root seals it too).
  This app never reads it and never logs, returns or copies a token: the
  provider gets a `{ accessToken(clientId) }` handle, the browser sees
  signed in / signing in / an account label. Sign out clears it and asks OpenAI
  to revoke. `SMRT_APP_SHELL_NAME` sets the app name OpenAI's page shows.
- **The turn** (`assistant/model.ts`): the `chatgpt` engine asks the resolver
  smrt-inference composed (`installShellInference`) with its own request name,
  and runs ONLY on the `chatgpt-plan` target that sign-in produced; with nobody
  signed in it is unavailable ("Sign in with ChatGPT"), never an API key, never
  another provider. The loop uses `chat()` with `onProgress` (the provider's
  `stream()` rejects tools) and a tool namespace (`shell_tools`); it sends no
  `maxTokens`, sampling, `user`, response format, reasoning option or forced
  tool choice, which the preview refuses. The model is the owner's pick in
  Settings > Assistant, else the first model in the account's catalog.
  Approvals, the offer gate and the deny list are unchanged.
- **Failures** become dock messages: usage limit, revoked session and workspace
  refusals (the last two with "Sign in again", linking to
  Settings > Assistant), "unavailable, still signed in", and the preview's
  unsupported-capability refusal. Only the error class and code are logged.
- **Tests** stub the provider (`assistant/chatgpt-engine.test.ts`), the
  connection (`routes/onboarding-chatgpt.test.ts`) and the opener
  (`lib/server/chatgpt.test.ts`); nothing signs in.

### The local agent CLI engine

**Rule (two lines).** No in-app Claude subscription login: this app never
offers Claude.ai sign-in and never collects, stores or passes on those
credentials. The local-CLI engine only runs the person's own, unmodified Claude
Code or Codex, signed in through the vendor's own flow and billed to them
([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
Product names appear as plain text, no logos.

- **Detection** (`agent-cli/locate.ts`, `detect.ts`): the executable on PATH,
  then the usual install places (`~/.local/bin`, `~/.claude/local`, Homebrew,
  `/usr/local/bin`, npm/pnpm/volta/bun/nvm bins, Windows equivalents), then the
  person's login shell (`command -v`), so an app started from Finder finds it.
  Version and sign-in come only from the tool's own commands (`--version`,
  `claude auth status`, `codex login status`); no credential file or keychain
  item is read, and the browser sees only installed / version / signed in. Not
  installed: a link to the vendor's install page, nothing is installed for them.
  Windows runs a real `.exe` (a `.cmd` shim is not started, there is no shell).
- **Connect** (`agent-cli/login.ts`): signed out, it starts the tool's own
  sign-in (`claude auth login`, `codex login`), which opens the vendor's page
  in the system browser; the app only watches the process end, then asks the
  status command again.
- **A turn** (`agent-cli/session.ts`, `assistant/agent-turn.ts`):
  `claude -p --output-format stream-json --verbose --include-partial-messages`
  or `codex exec --json`, the prompt on stdin, streamed JSON mapped onto the
  same `TurnEvent`s (the dock has no engine-specific code). Locked down:
  - Tools: only the shell's, from `/mcp`, with the same owner policy and
    Approval gate. Every built-in tool that touches the machine is off (Claude:
    `--tools ""` plus a strict MCP config; Codex: shell, exec, apps, plugins,
    hooks, sub-agents, code mode and more disabled, read-only sandbox, approvals
    never, no web search). The stream is also checked: any other tool, or an
    unknown Codex item kind, stops the turn.
  - Token: a short-lived (15 min), owner-bound, `assistant.use`-scoped
    app-runtime local MCP token, issued under one holder (each turn rotates the
    last) and revoked when the turn ends. It is in the child's environment only:
    never argv, a file or a log, and only ever sent to a loopback URL. Claude
    reads it through `${VAR}` in its MCP header config; Codex through
    `bearer_token_env_var`.
  - Environment: an allow-list (`agent-cli/env.ts`); `ANTHROPIC_*`, `OPENAI_*`,
    `CODEX_*`, `CLAUDE_CODE_*` and `SMRT_*` never reach the child, so the tool
    uses the person's own login. Working directory: an empty private folder
    `<data root>/agent-cli/work`. Claude loads none of the person's settings,
    hooks, skills or plugins; Codex ignores their `config.toml` and rules.
  - Approvals: a risky call returns `pending_approval` from `/mcp`; the turn
    shows the card (`approval_required`) and ends `waiting`. Only the owner's
    decision applies it (`Approval.decide`). The tool is told not to retry.
  - Bounds: 10 minutes per turn; cancel (the Stop button) and timeout kill the
    whole process tree. A later turn resumes the tool's own session (stored on
    the thread's last assistant message), else starts a new one.
  - Known gaps: Codex still offers its own code-mode `exec` and `apply_patch`
    tools to the model (no flag removes them; the read-only sandbox and the
    stream guard are what stop them), and it still reads the person's own global
    Codex instructions file (its home folder AGENTS.md). Codex 0.162.1 needs `--enable mcp_2026_07_28` to
    reach `/mcp`. The tool keeps its own session transcript in its own folder.
- **Tests:** stub CLIs (shared `smrt-inference/test-support`) over the real
  `/mcp` route (`assistant/agent-turn.test.ts`); fake binaries on a temp PATH
  (`agent-cli/detect.test.ts`). An opt-in run against a real installed CLI:
  `REAL_AGENT_CLI=claude-code|codex npx vitest run
  src/lib/server/assistant/agent-cli.manual.test.ts` (spends the person's own
  subscription, one short turn).

## Onboarding

`/welcome` (owner only; an owner with an empty app who has not finished or
skipped it is sent there once): **1. Connect your AI** (Use Claude Code,
Sign in with ChatGPT, plus Advanced: the full inference setup at
`/settings/inference`, which links back; Codex is an advanced option under
Settings > Assistant, not on this page) and **2. How do you want to start?** (Fresh: an empty app with the
assistant dock open; From a spreadsheet). Skippable. Finished
or skipped is stored as `onboarding` in the `assistant` preference
(`agent-cli/settings.ts`, the smrt-preferences store smrt-inference also uses;
not a member of the `inference` payload, which the settings panel replaces whole,
and not a tier target of core's inference model). **Settings > Assistant**
(`/settings/assistant`) switches engine and re-opens the steps. JSON routes
(owner only, same-origin writes): `GET /api/shell/onboarding[?fresh=1]`,
`POST /api/shell/onboarding/{connect,engine,complete,skip}`, and
`GET`/`POST /api/shell/onboarding/chatgpt` (start, sign-out, model;
`lib/server/onboarding.ts`).

## Changes waiting (the shell)

Structural changes (models, fields, reports, loads, merges, methods, removals)
made by the assistant, an import or any API caller do not reach the live app.
Each becomes a **card** in the owner's changes waiting and runs only on a
private working copy; the owner reviews them and applies them. Records are
always live. Live **structure** is frozen while any card is active (also after
a restart). All routes are owner-session, same-origin; there is no ``,
`x-shell-target` or `/mcp` any more (400 on `/mcp`).

- `GET /api/shell/changes` -> `{ batchId, status: 'none'|'open'|'held', count,
  generation, digest, checkState: 'none'|'ok'|'blocked'|'stale'|'checking', canApply,
  blockers[], overwrites: { recordsUpdated, recordsMerged, archivedValues,
  archivedTables } | null, held, liveVersion, baseVersion, cards[], discarded:
  { batchId, count } | null, lastApplied: { batchId, appliedAt, versions,
  undone, undoDigest, count } | null }`. A card is `{ id, position, group,
  source: 'assistant'|'import'|'api'|'quick', summary, status:
  'active'|'removed', revision, opaque, commands[], checks[{code,message,cause?}],
  questions[], threadId, messageId, editable }`. `count` is the one number to
  show. Overwrite counts are shown and pinned by `digest`; they never block.
  **Checks** run in the background: every change restarts a ~2 s debounce, then
  the exact checks (`checkBatch`) run on the working copy, serialised with the
  other changes work, and are stored only if `generation` is still the one
  scheduled (an older result is dropped). `checkState` is `stale` (queued) then
  `checking` then `ok`/`blocked`; the `changes` event follows. `digest` is empty
  until a check finishes; Apply always re-runs the exact checks fresh. Cards
  carry what blocks them (`checks`, with the removed change's id as `cause` for
  `depends_on_removed`); a blocker that names no card stays in `blockers`
  (`base_moved`). Blocker copy is plain words (never "draft" or "publish").
  The digest pins the chain, each card's `revision` and the overwrite counts
  only (rows a load would update, rows a merge removes): a record added to live
  while changes wait that overwrites nothing does not move it, one that turns an
  insert into an update does (409, review again; never a block on its own).
  Slice 5's assistant review chains on `setAfterChecks(hook)` in
  `lib/server/changes.ts`: the hook gets `{ batchId, generation, owner, ok,
  isCurrent() }` after each stored check, outside the changes queue, errors
  swallowed; it can read, never apply.
- `POST /changes/cards/:id/remove|restore` `{ generation? }`; `PATCH
  /changes/cards/:id` `{ label?, choices?, field? , generation? }` (quick edit;
  a default cannot be set). All return the new state.
- `POST /changes/apply` `{ expect: digest, generation? }` -> `{ id, status:
  'approved', result }`; 409 when blocked, changed since review, or stale
  `generation`. The owner's click; it records and decides an `apply-batch`
  Approval. No tool, `/mcp` or assistant path can apply. A refusal body is
  `{ error, code: 'refused', reason: 'blocked', blockers: [{code, message,
  cardId?}] }` ("Can't apply yet": the server refuses however the client
  behaves) or `{ ..., reason: 'changed' }`.
- `POST /changes/cards/:id/remove-dependents` `{ generation? }` ("Remove those
  too"): `:id` is a card flagged `depends_on_removed`; it and every card that
  needs the same removed change go, then any the rebuild newly flags. "Put it
  back" is `POST .../restore` of the flag's `cause`.
- `POST /changes/discard`, `POST /changes/restore` ("Put them back"),
  `GET /changes/preview` -> `{ changes, preview }` (SQL, methods, diff).
- `POST /changes/undo` `{ batchId, expect: lastApplied.undoDigest }`: takes an
  applied batch back; records added since Apply stay; 409 while changes wait.
- Structural builder calls answer `{ status: 'change_waiting', waiting: true,
  cardId, count, ...the engine result }`. History's undo and clean up are the
  owner's (409 "Apply or discard your N waiting changes first" while changes
  wait).
- SSE (`/api/events`): `{ type: 'changes', status: 'changed'|'applied'|
  'discarded'|'undone', batchId, count, generation }` (the older `draft` event
  is still emitted for the import workflow).

### Changes waiting UI (#5204)

- The layout loads `GET /api/shell/changes` once (`data.changes`, depends key
  `smrt:changes`, refreshed by the SSE `changes` event); the header pill,
  `/changes` and History read that one count. The pill (`ChangesPill`) sits in
  the header's end slot next to the Assistant button, links to `/changes`, reads
  "N changes waiting" (below 480px "N waiting"), and is absent when nothing
  waits. It shows a spinner while checking and "needs a look" when blocked.
- `/changes`: one card per active change in workbook order, with Remove (x),
  Quick edit (name, choice options; no default) and, on the right, what will
  change, Apply and Discard all. Apply sends the reviewed `digest` as `expect`;
  a 409 refreshes the state and asks the owner to review again. A successful
  Apply toasts "Applied. Your app is live" and lands on the records. Discard is
  instant with "Put them back". Removed cards list with Put back.
- `ChangeCard` shows Comment (`oncomment`, editable cards only) and a `more`
  snippet that `ChangeCardExtras` fills: the comment thread ("Changing this…"
  while the assistant works), the comment box, and the assistant's review
  questions with click-to-answer choices (plain text only). Blockers arrive in
  `state.blockers` (`cardId` marks the card).
- History: one entry per applied batch ("Applied N changes"); only the newest,
  not yet undone one has Undo (`POST /changes/undo` with `undoDigest`). While
  changes wait every Undo is disabled with "Apply or discard your N waiting
  changes first."
- The Apply button uses a button-only shade (`--smrt-app-shell-action`, #c2470a
  in light, 5:1 with white); the global primary token is unchanged.

An open draft from before changes waiting is adopted as opaque cards: no
commands, not removable or editable one by one. A workbook import (#5207) is
cards by table under one group on `/changes` (collapsed, with a count); each
table card can be removed or its name/choices edited (a rebuild replays the
loads, so it says "Rebuilding your changes"), and the import page's Apply is
the same digest-pinned `POST /api/shell/changes/apply`. A template with records
(`importTemplate`) is one card that carries them. The assistant
gets no undo, apply or draft tool; its turn input says changes are collected.

### The assistant and changes waiting (#5206)

- **Reply block.** A turn that made changes ends in a `changes_block` event
  (stored as an empty assistant message with `block: 'changes'`, never shown to
  the model). The dock draws it from the layout's live `changes` state: "N
  changes waiting", the first few changes, "N questions" while any is open, and
  Review (link to `/changes`) / Apply. Review leads while a question is open or
  Apply is not ready; Apply leads once nothing is open. Only the newest block in
  a thread is live; nothing shows once nothing waits. Apply is the owner's own
  click on the same `POST /changes/apply` (digest-pinned).
- **Apply now.** `applyNowEligible` (`lib/server/apply-now.ts`, pure): exactly
  one active card, made by the assistant, only `defineModel`/`addField`/
  `defineReport`, and the exact check found no record updated, merged or set
  aside. `ChangesState.applyNow` carries it (the main button reads "Apply now").
  `POST /changes/apply` with `source: 'chat'` makes the server recompute it
  from the batch and its fresh check and ignore the client: otherwise 409
  `reason: 'review_first'`. It runs the exact checks only; the assistant review
  is never part of Apply.
- **Comment to revise.** `POST /changes/cards/:id/comment {text}` runs an
  assistant turn scoped to that one card (the same engines as chat; its own
  per-card thread, never the dock's latest) and answers the new state once it
  ends; the thread is `card.comments`. The turn is offered `change_revise
  (cardId, command)` and read tools only: no structural builder tool and no
  record writes. `change_revise` replaces that card's commands in an open batch
  (revision +1, rebuilt, re-checked; if it does not fit, the card is put back
  and the engine's reason returned), only for the card the turn was scoped to,
  and it never applies. Scoped by a per-owner slot (`withRevision`) so the CLI
  engines' separate `/mcp` requests see it. 409 while another assistant turn
  runs; 503 without a connected assistant.
- **Review questions.** After the exact checks pass (`setAfterChecks`, installed
  at startup by `hooks.server.ts` through `installChangeReview`), one tool-free
  model call (`change-review.ts`) reads the changes, the overwrite counts and a
  few sample records as untrusted `<data>`, and may return `{questions:
  [{cardId, text, choices: [{label, command?}]}]}`. Output is parsed strictly
  and capped (6 questions, 2 per card, 4 choices, 300/60 characters); each
  choice command must be a known structural, non-History command that the
  working copy's `plan` accepts, else the choice is dropped. Results are
  discarded when the batch generation moved on; the review is skipped (exact
  checks unaffected) when no assistant is connected; it runs on the owner's API
  or ChatGPT engine as one tracked call, and on the local agent CLI engines
  (`claude-code`, `codex`) as one parentless tool-free tracked turn through the
  same no-tools MCP scope workbook planning uses (`createToollessCliDriver`),
  billed like other assistant use on whatever engine is connected. Stored in
  `ChangeCard.questions` (commands stay server-side); the comment thread has
  its own `ChangeCard.comments` column (v0.62.14 kept comments inside
  `questions`; those rows are still read and move on the next write). Answered
  questions are kept so they are not asked again. `POST
  /changes/questions/:id/answer {choice, generation?}` takes only a choice
  INDEX: a choice with a command becomes a NEW card (source `api`, so never
  Apply now), one without just closes the question. Questions never block
  Apply, are not in the digest, and nothing here applies, approves or undoes
  (`invariants.test.ts`).

## Draft then publish (engine API)

The engine can run a second host, a draft, over a copy of the live data and
later replay the draft's changes onto live. Rules and failure behaviour are in
[agents/engine.md](agents/engine.md); the API on `AppHost` (exported from
`@happyvertical/smrt-app-shell/engine`):

```ts
const live = await AppHost.open(dir, { store });
// `owner`: enginePrincipal({ kind: 'user', tenantId: live.tenantId, userId,
//   permissions: [OWNER_SLUG, ...appPermissionSlugs(live.def)] }); execute/forkDraft/publishDraft/restoreSnapshot refuse anyone else
const draft = await live.forkDraft(owner, draftDir, { store: emptyDraftStore }); // autoApprove on
live.setFrozen(true); // live keeps serving records; structural commands are refused
// ...build in `draft` (draft.execute(owner, ...) / draft.create ...)...
const preview = await live.previewPublish(draft); // diff, archives, all method code, digest
await live.publishDraft(owner, draft, {
  author, approved: true, expect: preview.digest, draftName: 'Spring cleanup',
}); // N ordinary live versions; any failure leaves live's app.db untouched
live.setFrozen(false);
await draft.discard(); // closes it and deletes only the directory fork made
await live.execute(owner, { type: 'undoTo', version: base, from: live.version }, { author });
```

`AppHost.open(dir, { store, autoApprove: true })` only works on a directory the
engine marked as a draft. A host start reconciles an interrupted publish
(`host.recovery`). A `VersionStore` may implement the optional atomic
`commit(records, current)`.

## First-run schema

`prepareShellSchema(db)` (`src/lib/server/schema.ts`) creates the tables of every
registered shell model (and the smrt-users, tenancy and profiles tables the
runtime needs) when missing, so an empty data directory boots without
`DB_SCHEMA_MISSING`. It is passed to app-runtime's existing `prepareDatabase`
option. Dependency: the first-run schema hook of smrt#4835 is pending; the
shell will switch to it in `smrt.ts` when it lands.

## Develop

```
pnpm --filter @happyvertical/smrt-app-shell test
pnpm --filter @happyvertical/smrt-app-shell build
pnpm --filter @happyvertical/smrt-app-shell typecheck
```

See [AGENTS.md](AGENTS.md) for the invariants and [agents/engine.md](agents/engine.md) for the engine.

### Draft UI (removed)

The Live/Draft bar and `/draft/review` are gone (#5178): owners see changes waiting instead (see [Changes waiting](#changes-waiting-the-shell); the UI is described under "Changes waiting UI" above). `agents/draft-ui.md` describes the retired bar.

### Engine calculated fields

Definitions remain format 1. `addField.definition.calculated` and
`setCalculation { model, field, calculated }` use core's `GeneratedExpression`
(the SQL SDK's operand nodes). Pass `null` to clear a calculation. Generated
values are database-owned and read-only on all write surfaces. Plan validates
same-model visible inputs and result types. Renames rewrite expressions; hide,
remove and type changes refuse dependents. Changes and undo run transactionally;
undo restores the prior expression. A writable-to-calculated change archives
originals and requires approval. Clearing an expression starts an empty writable
column. See [engine contracts](agents/engine.md).

Calculated fields are read-only in record forms, with their formula in field
labels. New forms show no guessed value; saved records show the engine's value.
Save payloads omit calculated fields. Model pages list every field and its
formula, and table headers sort the loaded records, including calculated values.
Publish review uses the same display-only formula renderer.

The assistant uses reports for aggregate answers, calculated fields for values
from the same record, and asks before saving a one-time answer. Run results use
the same shared report component in chat. Reopened threads keep the summary and
saved-report link; results run again on the report page.

A deterministic QA import body is [agents/reports-ui-seed.json](agents/reports-ui-seed.json).
It needs an empty app and can be posted by the signed-in owner to
`/api/apps/importTemplate?target=live`. It seeds customer links, dates, choices,
money and calculated totals, bar/line/table reports, empty and capped results.

### Engine reports

`AppDefinition.reports[name] = { label?, description?, spec }` stores a
smrt-reports `RuntimeReportSpec`. `source` is an app model name. Commands are
`defineReport { name, definition }`, `renameReport { from, to }`, and
`removeReport { name }`. Reports participate in history, undo, and draft publish.
`AppHost.runReport(nameOrSpec, { maxRows?, timeoutMs? })` runs a live aggregate;
it works on frozen and draft hosts. Only visible app fields are nameable.
No SQL is accepted. Bounds are 1–1000 rows and 1–10000 ms (defaults 1000/5000).
Reference dimensions retain ids and add labels in each column's `labelColumn`;
columns also carry `format`, `choices`, and `reference` hints where applicable.
The server catalog exposes `app_setcalculation`, `app_definereport`,
`app_renamereport`, `app_removereport`, `app_runreport` through the owner policy.

### Engine bulk load

`loadRecords { model, rows, mode: 'insert' | 'upsert', key?: string[],
references?: { [field]: { model, by } } }` loads at most 10,000 rows / 8 MiB.
Plan returns counts and up to 100 row problems (zero-based row, field, reason).
Any rejected row aborts execute. Key upsert counts insert/update/unchanged;
updates require live approval. Reference lookups are batched per target model.
Values use single-record coercion; calculated input is refused. Loads are
versioned, atomic, snapshotted, undone from exact originals, and replayed when
publishing a draft. Catalog tool: `app_loadrecords`.

### Engine extraction

`extractModel { model, field, into, titleField?, normalize? }` turns a writable
text/choice field into a reference. Distinct nonempty values create target rows
or match an existing target's title field. Exact matching is default;
`normalize: true` trims and compares without case. Plan counts folded values.
The new model uses `titleField` or `name`; existing models use their title field
or first visible text. Undo restores exact text and removes created targets only
when no surviving app reference points to them. Catalog: `app_extractmodel`.

### Engine merge

`mergeRecords { model, keep, merge: ids[], fields?: { [field]: 'keep' | id } }`
repoints all app references to `keep`, archives and removes merged rows, and
optionally selects surviving field values from one of those records. Always
requires live approval. Plan lists reference counts per model. Undo restores
exact rows and references, refusing reused deleted ids. Bounds: 1–1000 merged
ids. Draft publish recomputes against current live references. Catalog:
`app_mergerecords`. Calculated fields cannot be selected as writable values.

## Import a workbook

Choose **Import workbook** in the user menu or **Import a workbook** on an empty
Home, or **From a spreadsheet** on Welcome. Drop an `.xlsx` file (up to 25 MB),
or use the file picker. Connect your chosen assistant engine in Settings and
keep AI usage persistence enabled first.
The provisional 250,000-cell ceiling can be changed in **Settings → Import**
(1,000 to 2,000,000 cells). Larger or complex workbooks should be split up.

Planning uses the engine chosen in **Settings → Assistant**: API key, Sign in
with ChatGPT, Claude Code or Codex. It runs as a private child turn with no app
tools; reported usage counts toward the import budget, and calls without usage
are recorded as uncosted. The model returns a plan; only the workflow's checked
load can change the draft.

The `app-shell.import` background workflow proposes a plan from bounded workbook
facts, checks it, loads a fresh draft and proves row counts, source column sums
and calculated fields against cached workbook values. Progress shows Reading,
Planning, Checking, Loading and Proving. Stop saves resumable work; Cancel ends
it. Interrupted work resumes on startup. A budget stop offers a bounded Resume.
Planning shows elapsed time; completed stages remain visible between polls.
An engine failure names the engine and links to Assistant settings. **Try again**
reuses the private upload with a new workflow run, including after a restart.
A refused plan explains where the assistant stumbled and offers the same saved-file
retry, without sending you to settings. Workbook problems show their findings
instead. Cancel/discard removes the file.

The same page shows each table's rows read/skipped/loaded, typed fields and
source columns, links, choices, calculations, reports, findings with sheet/cell
examples and totals proof. **Formulas not translated** lists source formulas
kept as saved values; those fields do not recalculate. **Review and apply** opens the changes waiting view; only the owner's Apply can change live data. **Discard import**
removes the draft and stored workbook. Failed proof also removes its draft.
Models keep readable names such as `Customers` and `Orders`; plan fields become
camelCase (`orderNo`, `unitPrice`, `qty`). Name collisions use numeric suffixes,
with the resolved names retained in `plan.engineNames`. Hidden `workbookRow` and
`workbookLookup` fields support proof and links. Calculations use field labels in
review and History. Year and identifier checks remain in the proof without being
presented as useful totals.
Only one import may run, and none starts while other changes wait (apply or
discard them first). Importing into existing tables, saved mappings,
re-import and export are not included.

The API accepts a raw binary workbook at `POST /api/shell/import`, returning
`202 { id: <workflow run id> }`. `GET` returns `{ import: <current state> | null }`;
The state includes a machine-readable `reason` (`engine`, `plan`, `workbook`, `budget`,
`paused`, `app`, or null) and timestamped `progress` stages.
`POST /api/shell/import/stop|resume|retry|cancel|discard` controls it. All are owner-only;
writes check the same origin. The adapter-node build's entry wrapper defaults
`BODY_SIZE_LIMIT` to 25 MiB before loading its handler (also for desktop starts).
Operators may supply a lower ceiling. No listening service is added.
See [import invariants](agents/imports.md) for ownership, recovery and validation.
