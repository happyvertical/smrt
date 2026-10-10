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
   one-time token; open the browser (`--no-open` to skip).
3. The page chats through `/api/planner/chat`, the user builds a cookbook and chooses
   **Send to kitchen**, which POSTs it to `/api/kitchen/cookbook`.
4. The server validates (`validateCookbook` + recipe index, as `cookbook validate`), runs the
   `cookbook apply` engine into `dir` (install progress goes to the terminal), answers the page
   with the result, then the CLI prints the next steps and exits. A refused cookbook (422) or an
   unusable directory (409) leaves the server running so the user can fix and send again.

## Server

| Path | |
| --- | --- |
| `GET /planner.config.json` | `{ inference, kitchen: { endpoint: "/api/kitchen/cookbook", token } }`; `inference` is `{ mode: "host", host: { endpoint: "/api/planner/chat" } }`, or `{ mode: "browser" }` with no model |
| `POST /api/planner/chat` | host contract v1: `parseHostRequest` -> `buildHostPrompt` -> model -> `parseHostReply` -> reply JSON. 400 bad request, 502 model failure (message not forwarded), 503 no model |
| `POST /api/kitchen/cookbook` | header `x-kitchen-token`, same-origin JSON; 200 `{ ok, dir, mode, installed, added, nextSteps }`, 4xx `{ ok: false, errors }` |
| everything else (GET/HEAD) | the planner's `app/` directory; `/` serves `index.html`; no path leaves `app/` |

Guards: every request's `Host` must be this server (DNS rebinding); the cookbook POST needs a
matching `Origin` header (chat: matching if present), `content-type: application/json`, a
timing-safe token match, and is refused after a success. Bodies are capped (chat 256 KB,
cookbook 2 MB). No CORS headers are sent.

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
