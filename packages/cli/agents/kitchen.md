# `smrt kitchen` (#3750)

Code: `src/commands/kitchen.ts` (registration, Ctrl-C), `src/commands/kitchen/`
(`run.ts` orchestration, `planner.ts` locating the planner, `server.ts` HTTP,
`ai.ts` the model, `apply.ts` the cookbook hand-off). Planner side:
`happyvertical/smrt-planner` `docs/inference-host.md` ("Send to kitchen").

```
smrt kitchen [dir] [--planner <dir>] [--template <t>] [--no-open] [--no-install]
             [--manifests <p>]... [--no-registry] [--port <n>]
smrt kitchen apply <url|file> [dir]     # = cookbook apply (any URL that returns cookbook JSON)
```

`dir` must be absent, empty, or already hold `smrt.cookbook.json` (then it is updated).
Checked before anything starts.

## Flow

1. Find the planner (below), import its plain-Node `./core`.
2. Resolve the model; start the server on `127.0.0.1` (random port, or `--port`) with a random
   one-time token; open `http://127.0.0.1:<port>/#kitchen=<token>` in the browser (`--no-open`
   skips opening; the same address is printed as `Open <url>`, because the token is in it).
3. The page chats through `/api/planner/chat`, the user builds a cookbook and chooses
   **Send to kitchen**, which POSTs it to `/api/kitchen/cookbook`.
4. The server validates (`validateCookbook` + recipe index, as `cookbook validate`), runs the
   `cookbook apply` engine into `dir` (install progress goes to the terminal), answers the page
   with the result, then the CLI prints the next steps and exits. A refused cookbook (422) or an
   unusable directory (409) leaves the server running so the user can fix and send again.

## Server

| Path | |
| --- | --- |
| `GET /planner.config.json` | `{ inference, kitchen: { endpoint: "/api/kitchen/cookbook" } }`, **never a token**; `inference` is `{ mode: "host", host: { endpoint: "/api/planner/chat" } }`, or `{ mode: "browser" }` with no model |
| `POST /api/planner/chat` | host contract v1: `parseHostRequest` -> `buildHostPrompt` -> model -> `parseHostReply` -> reply JSON. 400 bad request, 502 model failure (message not forwarded), 503 no model |
| `POST /api/kitchen/cookbook` | header `x-kitchen-token`, same-origin JSON; 200 `{ ok, dir, mode, installed, added, nextSteps }`, 4xx `{ ok: false, errors }` |
| everything else (GET/HEAD) | the planner's `app/` directory; `/` serves `index.html`; no path leaves `app/` |

Guards: every request's `Host` must be this server (DNS rebinding); the cookbook POST needs a
matching `Origin` header (chat: matching if present), `content-type: application/json`, a
timing-safe token match, and is refused after a success. Bodies are capped (chat 256 KB,
cookbook 2 MB). No CORS headers are sent. Only one cookbook POST applies at a time
(the slot is claimed before the body is read).

### The token is in the URL fragment

The one-time token is **not served by any endpoint**: `/planner.config.json` carries only the
cookbook endpoint, so another local process that sends this server's `Host` cannot read it. The
token is the fragment of the address the CLI opens and prints, `http://127.0.0.1:<port>/#kitchen=<token>`
(`server.openUrl`; `server.url` has no secret). A fragment is never sent to a server. The planner reads
`location.hash`, keeps the token in memory only (not in storage, not in any request but the cookbook
POST's `x-kitchen-token` header), and strips the `kitchen` parameter from the address with
a replacing navigation (`goto(..., { replaceState: true })`, because a bare `history.replaceState` would leave the
token in SvelteKit's own copy of the address) before anything else reads the URL, so it is not in the history
entry either.
Opening the address without the fragment (or reloading after it was stripped) leaves the page without
a token: the export panel then says so and offers Download. A planner older than this contract shows no Send
button at all, and a planner at this contract served by an older CLI (which still puts `token` in the config)
refuses to use it and says to update the CLI, so release this change before, or with, the planner's first
publish. The contract is specified on the planner
side in `happyvertical/smrt-planner` `docs/inference-host.md` ("Send to kitchen"); change both
together. The kitchen defends against browsers, not against other users on the same machine
(who can read your terminal and process list): run it on a machine you trust.

## Model

`ai.ts` loads `smrt.config.*` (from `dir` if it exists, else the cwd) and resolves the provider
with smrt-config's `tryResolveConfiguredAIProvider` (config `ai` block, `SMRT_AI_*`, then a
provider key variable such as `OPENAI_API_KEY`), then builds it with `getAI` from
`@happyvertical/ai`. Calls are `chat([system, ...messages], { temperature: 0 })`. With no provider
the config is served in `browser` mode and the terminal says so.

## Finding the planner

`@happyvertical/smrt-planner` carries a ~70 MB static app, so it is not a dependency. In order:

1. `--planner <dir>`: a packaged checkout (`pnpm package` in the planner repo).
2. `<cache>/<version>/package/`, where `<cache>` is `$SMRT_CACHE_DIR/planner`, else
   `$XDG_CACHE_HOME/smrt/planner`, `~/Library/Caches/smrt/planner` (macOS),
   `%LOCALAPPDATA%\smrt\planner` (Windows) or `~/.cache/smrt/planner`.
3. The registry that owns the `@happyvertical` scope (`cookbook/registry.ts`, the same scope and
   token resolution as the recipe index): the latest version is downloaded and extracted into the
   cache. If the registry cannot be reached, the newest cached version is used.

Otherwise it stops with an error naming `--planner`.

## Tests

`src/commands/__tests__/kitchen.test.ts` uses a generated fake planner package and a stub model.
Set `SMRT_PLANNER_DIR=<packaged planner checkout>` to also run the suite against the real `./core`.

## `smrt kitchen mcp` (#3752)

```
smrt kitchen mcp [--template <t>] [--manifests <p>]... [--no-registry] [--packages <name>]... [--library <dir>]... [--plans-dir <dir>] [--preview-port <n> --preview-origin <local-origin>]
```

A stdio MCP server (`@modelcontextprotocol/server`, `serveStdio`) for the local
agent plugin in [`plugins/smrt-kitchen`](../../../plugins/smrt-kitchen/README.md).
The host's model reasons; the server holds plans and calls `createCookbookEngine`
(`smrt-core/cookbook/engine`). It never calls a model and takes no credential.
**stdout is the protocol stream**: every notice goes to stderr (this is why the
`.smrt/register.js` warning in `cli-generator.ts` uses `console.warn`).

Code: `src/commands/kitchen/mcp/` (`tools.ts` definitions + `KitchenSession`, `catalog.ts`,
`server.ts`). Tests: `__tests__/kitchen-mcp.test.ts` (spawns the CLI over stdio with the SDK
client), `__tests__/kitchen-plugin.test.ts` (plugin files against the Agent Plugins schemas).

| Tool | Hints | |
| --- | --- | --- |
| `list_cookbooks`, `search_recipes` | read-only | library (`cookbooks/*.cookbook.json`, kept equal to core's fixtures by a test; `--library` adds dirs) and catalog recipes |
| `start_plan` | not read-only, not destructive | empty, or from a library cookbook; returns `planId` |
| `run_commands` | idempotent | one atomic `engine.batch` (`id`, `expectedRevision` pass through); a lone `undo` runs as a command |
| `get_plan`, `validate_plan`, `export_plan` | read-only | `validate_plan` = engine `validate` + `validateCookbookText` against the catalog's manifests |
| `open_preview` | read-only | URL for the same plan in the local development app shell when the preview bridge is enabled; binds the plan so the bridge will serve it |
| `apply_plan` | destructive, idempotent, open-world | `createCookbookApplier` (= `cookbook apply`); absolute `dir`; **writes only with `confirm: true` + the preview's `confirmCode`** (sha256 of dir, server template and exported plan, so a changed plan or dir needs a new preview), otherwise (or with `dryRun`) a preview + `confirmation_required`; template is the server's `--template` only; `install` defaults to false and its output goes to stderr; templates containing symlinks are refused |

- **Plans** are stored in `--plans-dir` as private engine-state JSON files when set. This
  retains the revision and idempotency journal across server restarts. Undo handles
  remain available within the running process; a restart clears them. Writes to
  a shared plans directory use a per-plan cross-process lock so stale revisions
  cannot both succeed. Otherwise plans live
  in server memory (20 kept, oldest dropped). `smrt.cookbook.json` in the project
  (written by apply) is the applied copy.
- **Preview** binds to `127.0.0.1` and accepts only the configured loopback
  browser origin. The app shell and MCP tools call the same `KitchenSession`.
- **Catalog** is built lazily on first use, once: manifests are resolved for the library's recipes
  exactly like `cookbook validate` (`--manifests`, workspace, `node_modules`, registry unless
  `--no-registry`; `--packages` adds more) and turned into `EngineCatalog` (`catalog.ts`: recipes from
  `manifest.recipes`, models from `manifest.objects`, `exposed` from `decoratorConfig.api`). A package
  that cannot be found shows up in `warnings` and as `snapshot.unavailable`. Tool schemas are static
  (no recipe-id enums) so `tools/list` never waits on the network; `search_recipes` is the id source.
- **Output**: every tool returns compact text for the model plus `structuredContent` that matches its
  `outputSchema` (`ok` always; `error {code,message,path?,details?}` when false, with `isError`).
- Optional UI: `--ui-smoke` registers a static capability resource and `kitchen_ui_smoke`;
  `--planner-ui /absolute/path/app/mcp.html` registers a content-versioned Planner resource
  and `render_plan`. The planning tools have no UI template and keep working if
  the optional artifact is missing. The operator supplies self-contained HTML
  built in smrt-planner. The separate preview is loopback HTTP only.
- `start_plan`, `get_plan`, and `run_commands` return `state: { snapshot, cookbook }`
  atomically. Read this field for live UI state; replayed command receipts and their
  original snapshots retain their previous meaning. The app bridge allows
  get/run/export/validate plus its UI reload check.
- Not here: public or remote HTTP transport. See the plugin README for local build/install and
  the explicit manual desktop capability check.

