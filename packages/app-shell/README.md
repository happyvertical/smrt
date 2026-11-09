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

Run: `pnpm build && PORT=3000 SMRT_DATA_DIR=<dir outside the checkout> HOST=127.0.0.1 node build`,
then open `/setup` (loopback only, single use) to create the owner. Health:
`GET /api/_runtime/health`.

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

## The assistant

The dock (`src/lib/assistant/AssistantDock.svelte`, mounted for the owner in
the layout) talks to `mountAssistantRoutes` (`src/lib/server/assistant/`).
Owner session required on all of them (401/403); the POST is same-origin.

| Route | Body | Response |
|---|---|---|
| `GET /api/assistant/status` | | `{ configured: boolean, code?, message? }`; never a key, provider or endpoint. `code` is `assistant_not_configured` (no API key), `assistant_provider_refused` (subscription provider configured) or `ai_unavailable` (inference off) |
| `GET /api/assistant/threads` | | `{ threads: { id, title, updatedAt }[] }` newest first |
| `GET /api/assistant/threads/<id>` | | `{ thread, messages: ThreadMessage[] }`; 404 for a missing or foreign thread |
| `POST /api/assistant/turn` | `{ message, threadId? }` | `text/event-stream`, `event: turn`, JSON `TurnEvent` (below). **503** `{ type: 'unavailable', configured: false, code, error }` when the assistant cannot run; 409 while another turn is running |

`TurnEvent` (`src/lib/assistant/events.ts`): `thread {threadId}`, `text {delta}`,
`tool_call {id,name,args}`, `tool_result {id,name,ok,summary}`,
`approval_required {id,name,approvalId,summary,preview}`,
`approval_decided {id,approvalId,status}`, `error {code,message}`,
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
- **Engine.** `@happyvertical/ai` through core's inference tiers
  (`resolveInferenceTarget`, tier `good`, override `SMRT_APP_SHELL_ASSISTANT_TIER`).
  The key comes from the `ai` block of `smrt.config.ts`, `SMRT_AI_*` or the
  provider's own variable (`ANTHROPIC_API_KEY`), read only server side, never
  logged or sent to the browser, until bring-your-own (#4666) lands. Subscription
  providers (`claude-cli`, `chatgpt-plan`) are refused. With no key,
  status/turn answer the typed not-configured state and the dock shows it.
- **Bounds** (`DEFAULT_LIMITS` in `turn.ts`): 8 model rounds, 2048 output
  tokens per call, 60 000 tokens per turn, 4 calls per round, 60 s per model
  call, 180 s of model/tool time per turn, 15 min per approval wait.
- **Guidance.** `src/lib/assistant/guidance/system.md` (bundled with `?raw`).
- **Threads** persist in shell.db (`assistant_threads`, `assistant_messages`).
- **Tests** inject a stub model (`modelFactory` option, `test-helpers.ts`).

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
