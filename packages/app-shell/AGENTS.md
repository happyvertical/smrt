# @happyvertical/smrt-app-shell

An ordinary smrt app (SvelteKit + adapter-node, app-runtime **local** profile)
that builds and runs a person's own smrt app from a versioned JSON definition,
for one person: the owner. Epic #4867; this package is #4872. The engine is
documented in [src/engine/AGENTS.md](src/engine/AGENTS.md) (it must not import
SvelteKit or `src/lib`). README has the route and JSON contracts.

## Where things live

| Path | What |
|---|---|
| `src/engine/` | `AppHost`, worker thread, migrations, QuickJS sandbox. Finished and tested on its own. |
| `src/lib/models/` | Shell models (`objectsDir` in `vite.config.ts`): `App`, `AppVersion`, `Approval`. |
| `src/lib/server/smrt.ts` | `createSmrtSvelteKitRuntime`, `prepareDatabase`, `configureShell`. |
| `src/lib/server/schema.ts` | `prepareShellSchema(db)`: additive first-run schema. |
| `src/lib/server/host.ts` | Holders: shell db, data root, the one lazily opened `AppHost`. |
| `src/lib/server/version-store.ts` | `ShellVersionStore` (engine `VersionStore` on `AppVersion` + the `App` row). |
| `src/lib/server/owner.ts` | Owner check, `Principal`, `assertOwner`, `runAs`. |
| `src/lib/server/approvals.ts` | Approval service; the only place `approved: true` is set. |
| `src/lib/server/builder.ts` | `runCommand`/`runAppTool`/`runRest`/`requestRecordDelete`: execute or turn into an Approval. |
| `src/lib/server/catalog.ts`, `policy.ts`, `mcp-server.ts` | Merged tool catalog, the one policy, the `/mcp` server. |
| `src/lib/server/http.ts`, `events.ts` | Route plumbing; in-process event bus for SSE. |
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
  desktop sidecar contract); health is `/api/_runtime/health`.
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

## Tests and build

`vitest run` (in-process, SQLite, temp dirs; `test-support.ts` seeds an owner
and a member; it opens the real driver because the vitest setup would
pre-create tables). `pnpm build` (tsc engine, `svelte-kit sync`, `vite build`;
the smrt() plugin generates `src/routes/api/{apps,approvals,_changes,_events,
_resources}`: git-ignored) and `pnpm typecheck` must pass. The `smrt()` plugin
needs the models in `src/lib/models`, set via `objectsDir`.
