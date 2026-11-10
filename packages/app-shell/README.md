# @happyvertical/smrt-app-shell

A smrt app that builds and runs a person's own smrt app from definitions. One
person (the owner) signs in, changes the app (models, fields, code methods,
recipes) through builder operations or the assistant, risky changes wait for the
owner's approval, and every change is versioned and can be undone.

```
smrt-app-shell (SvelteKit + adapter-node, app-runtime local profile)
├── shell.db (the app-runtime database)  users, sessions, App, AppVersion, Approval
├── src/engine                           AppHost: worker thread, migrations, sandbox
└── <data root>/user-app/                app.db, snapshots (plain files; the newest 20 `method-*` are kept, clean up prunes old migration ones)
```

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

`node build` alone never prints a setup link: the shell passes no
`onBootstrapInvitation`, so the link comes from `smrt app setup` (it is saved in
the app's state folder, not the data folder). If the link is lost, stop the
server and run `smrt app recover` for a new one. Setup is loopback only and
single use. Health: `GET /api/_runtime/health`.

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

A FieldDef is `{ type, label?, required?, choices?, ref? }`; `type` is one of
text, number, integer, boolean, date, money, choice, reference, json. Field names
are camelCase (`dueDate`).

## Contracts for the UI and the assistant

Every route needs the owner's session cookie (401 signed out, 403 not the
owner). Writes must be same-origin `application/json`. Errors are
`{ error, code? }`. Live updates: `GET /api/events` (below).

| Route | Body | Response |
|---|---|---|
| `GET /api/shell/describe` | | `{ name, version, recipes, models: { [Model]: { kind: 'app'\|'shipped-subclass', label, table, className, extends, fields: { [name]: FieldDef }, ownFields: string[], methods: { [name]: { description, params } } } }, pendingApprovals }` |
| `GET /api/shell/history` | | `{ versions: { version, parent, author, summary, createdAt, purged, current }[] }` oldest first |
| `POST /api/shell/undo` | none | change result `{ version, summary, statements, snapshot, appRestartMs, ... }`; 409 if purged; **202** `PendingApproval` (with `preview.replaced`, the rows that would be overwritten) when the change being undone converted a field's type |
| `GET /api/shell/approvals?status=` | | `{ approvals: ApprovalView[], pending }`; `status` is `pending`, `approved`, `denied` or `failed` |
| `POST /api/shell/approvals/<id>` | `{ approve: boolean }` | `{ id, status: 'approved'\|'denied'\|'failed', result?, error? }`; 404 unknown, 409 already decided |
| `GET /api/shell/records/<Model>?limit=` | | `{ records: object[] }` |
| `POST /api/shell/records/<Model>` | the record's fields | 201 the record |
| `GET /PUT /api/shell/records/<Model>/<id>` | PUT: changed fields | the record |
| `DELETE /api/shell/records/<Model>/<id>` | | **202** `PendingApproval`; nothing is deleted until approved |
| `/api/app/<route>` (any method) | as the app's REST | the app's generated REST (`/api/app/chores` is the app's `/api/chores`); `DELETE` answers **202** `PendingApproval`; only the app's own collection routes are served (`sync/apply`, `_changes`, `_events` and unknown collections are 404) |
| `GET /api/events` | | server-sent events |
| `POST /mcp` | MCP Streamable HTTP | shell tools plus app tools, one policy |

`PendingApproval = { status: 'pending_approval', approvalId, summary, preview }`.
`ApprovalView = { id, status, summary, preview, action, requestedBy, decidedBy, decidedAt, result, createdAt }`
where `action` is `{ kind: 'command', command } | { kind: 'tool', name, args } | { kind: 'rest', method, url } | { kind: 'record-delete', model, id }`.

`GET /api/events` sends `event: ready`, then `event: shell` with JSON
`{ type: 'changed', version, summary }` (definition changed: reload
`describe`, the menu and the tool catalog), `{ type: 'records', model }`
(`model` may be null: reload lists) and `{ type: 'approval', id, status, summary }`
(`pending`, `approved`, `denied`, `failed`). A `: ping` comment every 25 s.

Builder operations are static methods on `App` and also appear as generated
REST (`POST /api/apps/<op>`) and MCP tools (`app_definemodel`, `app_addfield`,
`app_hidefield`, `app_renamefield`, `app_removefield`, `app_changefieldtype`,
`app_removemodel`, `app_addmethod`, `app_enablerecipe`, `app_undo`,
`app_cleanup`, `app_exporttemplate`, `app_importtemplate`, `app_describe`,
`app_history`), plus `approval_pending`. There is no tool to decide an approval: only the
owner, signed in, decides in the UI, so no model-driven client (the assistant
or an outside MCP client) can approve its own call. The risky ones
(`addMethod`, `removeField`, `removeModel`, `changeFieldType`, `cleanUp`, an
`importTemplate` carrying code) return `PendingApproval` instead of applying.

### Policy module for the assistant

`src/lib/server/policy.ts`:

- `toolsFor(principal): Promise<CatalogTool[]>`: the merged catalog (`{ name, description, inputSchema, annotations?, side: 'shell'|'app', risky }`); empty unless `principal` is the owner.
- `authorizeCall(principal, name): Promise<CatalogTool>`: throws `PolicyError` (`status` 401 no principal, 403 not the owner or unknown tool).
- `callTool(principal, name, args)`: authorize and run. A risky call returns a `PendingApproval`.
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
left sidebar, chat, content; the voice and assistant toggles and the user menu
sit in the sidebar footer. The boundary between chat and content is a draggable
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
- **Tests:** stub CLIs (`agent-cli/test-fixtures/stub-cli.mjs`) over the real
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
assistant dock open; Wizard: shown, disabled, coming soon). Skippable. Finished
or skipped is stored as `onboarding` in the `assistant` preference
(`agent-cli/settings.ts`, the smrt-preferences store smrt-inference also uses;
not a member of the `inference` payload, which the settings panel replaces whole,
and not a tier target of core's inference model). **Settings > Assistant**
(`/settings/assistant`) switches engine and re-opens the steps. JSON routes
(owner only, same-origin writes): `GET /api/shell/onboarding[?fresh=1]`,
`POST /api/shell/onboarding/{connect,engine,complete,skip}`, and
`GET`/`POST /api/shell/onboarding/chatgpt` (start, sign-out, model;
`lib/server/onboarding.ts`).

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
