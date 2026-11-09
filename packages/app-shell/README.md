# @happyvertical/smrt-app-shell

A smrt app that builds and runs a person's own smrt app from definitions. One
person (the owner) signs in, changes the app (models, fields, code methods,
recipes) through builder operations or the assistant, risky changes wait for the
owner's approval, and every change is versioned and can be undone.

```
smrt-app-shell (SvelteKit + adapter-node, app-runtime local profile)
├── shell.db (the app-runtime database)  users, sessions, App, AppVersion, Approval
├── src/engine                           AppHost: worker thread, migrations, sandbox
└── <data root>/user-app/                app.db, snapshots (plain files)
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
| `POST /api/shell/undo` | none | change result `{ version, summary, statements, snapshot, appRestartMs, ... }`; 409 if purged |
| `GET /api/shell/approvals?status=` | | `{ approvals: ApprovalView[], pending }`; `status` is `pending`, `approved`, `denied` or `failed` |
| `POST /api/shell/approvals/<id>` | `{ approve: boolean }` | `{ id, status: 'approved'\|'denied'\|'failed', result?, error? }`; 404 unknown, 409 already decided |
| `GET /api/shell/records/<Model>?limit=` | | `{ records: object[] }` |
| `POST /api/shell/records/<Model>` | the record's fields | 201 the record |
| `GET /PUT /api/shell/records/<Model>/<id>` | PUT: changed fields | the record |
| `DELETE /api/shell/records/<Model>/<id>` | | **202** `PendingApproval`; nothing is deleted until approved |
| `/api/app/<route>` (any method) | as the app's REST | the app's generated REST (`/api/app/chores` is the app's `/api/chores`); `DELETE` answers **202** `PendingApproval` |
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
`app_history`), plus `approval_pending` and `approval_decide`. The risky ones
(`addMethod`, `removeField`, `removeModel`, `changeFieldType`, `cleanUp`, an
`importTemplate` carrying code) return `PendingApproval` instead of applying.

### Policy module for the assistant

`src/lib/server/policy.ts`:

- `toolsFor(principal): Promise<CatalogTool[]>`: the merged catalog (`{ name, description, inputSchema, annotations?, side: 'shell'|'app', risky }`); empty unless `principal` is the owner.
- `authorizeCall(principal, name): Promise<CatalogTool>`: throws `PolicyError` (`status` 401 no principal, 403 not the owner or unknown tool).
- `callTool(principal, name, args)`: authorize and run. A risky call returns a `PendingApproval`.
- `Principal = { id, tenantId, scopes? }`; get one from the request with `principalFromLocals(locals)` (`owner.ts`).
