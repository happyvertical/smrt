# plan.s-m-r-t.dev as a ChatGPT app and Claude connector: superseded

**Status: superseded (2026-10-10).** This page designed a hosted service at
`plan.s-m-r-t.dev` (phase 2 of happyvertical/smrt#3751). That design is
dropped:

- the **hosted** app and connector are deferred in
  [happyvertical/smrt#3751](https://github.com/happyvertical/smrt/issues/3751);
- the plan that replaces it is the **local plugin**,
  [happyvertical/smrt#3752](https://github.com/happyvertical/smrt/issues/3752):
  `smrt kitchen mcp` is a stdio MCP server over smrt's cookbook command engine
  (`@happyvertical/smrt-core/cookbook/engine`, smrt#3753), packaged as the
  `smrt-kitchen` plugin (`plugins/smrt-kitchen/` in smrt). No public endpoint,
  no server state; the host's own model reasons and the plan reaches disk as
  `smrt.cookbook.json` through `smrt cookbook apply`.

What was removed from this page: the hosted tool surface, the handoff to a
hosted session, hosting and phasing, and the open questions. The headless
planner it rested on is now `createHeadlessPlanner` over that engine (see
`docs/inference-host.md`).

What is kept below, as dated research, is what an optional MCP Apps widget in
the local plugin (the `Planner` component as an MCP Apps resource) would need:
what OpenAI's and Claude's pages said about MCP Apps (section 1) and about the
widget (section 2). Check it against the pages again before building.

Research date: 2026-10-10. Every spec claim below names the page it came from;
anything the pages did not state is listed under "Not verified".

## 1. What the platforms require

### Sources fetched

- OpenAI, MCP server: https://developers.openai.com/apps-sdk/build/mcp-server
- OpenAI, UI: https://developers.openai.com/apps-sdk/build/chatgpt-ui
- OpenAI, reference: https://developers.openai.com/apps-sdk/reference
- OpenAI, quickstart: https://developers.openai.com/apps-sdk/quickstart
- OpenAI, auth: https://developers.openai.com/apps-sdk/build/auth
- OpenAI, connect: https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
- OpenAI, submission: https://developers.openai.com/apps-sdk/deploy/submission
- MCP Apps overview: https://modelcontextprotocol.io/extensions/apps/overview
- MCP Apps API/quickstart: https://apps.extensions.modelcontextprotocol.io/api/documents/Quickstart.html
- Claude, build a server: https://claude.com/docs/connectors/building.md
- Claude, MCP Apps: https://claude.com/docs/connectors/building/mcp-apps/getting-started.md
- Claude, connector article (search result summary only; the support.claude.com
  page returned 404): https://support.claude.com/en/articles/11503834

The fetches are summarised by a small model, so field names were taken from
passages that quoted them. Re-check against the pages before building.

### One server, two hosts: MCP Apps is the shared layer

OpenAI's UI page says "New UI should use the shared fields and bridge methods"
of the MCP Apps standard, and to add `window.openai` extensions only for
capabilities "that the shared specification does not cover". Claude's page says
an MCP App "can run in Claude and in other hosts that support MCP Apps from one
codebase", registered with `registerAppTool()` and `registerAppResource()`,
which "generate each host's metadata for you". So: build the widget once as an
MCP App; do not write a ChatGPT-only widget.

Naming note: the OpenAI docs now call ChatGPT apps "plugins" and the entry in
ChatGPT "Plugins > Add custom MCP server". Older material says "Apps SDK" and
"developer mode". Expect the UI labels to move.

### Declaring tools and the widget

| Item | Field (verbatim from the pages) |
| --- | --- |
| Tool definition | `name`, `title`, `description`, `inputSchema`, `outputSchema`, `annotations` (`readOnlyHint`, `destructiveHint`, `openWorldHint`) |
| Tool links to widget | `_meta.ui.resourceUri` (e.g. `"ui://widget/todo.html"`). `_meta["openai/outputTemplate"]` is "OpenAI-specific optional/compatibility alias" |
| Status text while running | `_meta["openai/toolInvocation/invoking"]`, `_meta["openai/toolInvocation/invoked"]` (at most 64 characters each) |
| Widget callable from the UI | `_meta["openai/widgetAccessible"]` |
| Auth per tool | `securitySchemes` (`noauth`, `oauth2`), mirrored as `_meta["securitySchemes"]` "for clients that only read `_meta`" |
| Resource MIME type | `text/html;profile=mcp-app` (constant `RESOURCE_MIME_TYPE` from `@modelcontextprotocol/ext-apps`) |
| Resource CSP | `_meta.ui.csp` = `{ connectDomains, resourceDomains, frameDomains? }`; legacy `_meta["openai/widgetCSP"]` |
| Resource look and origin | `_meta.ui.prefersBorder`; `_meta["openai/widgetDomain"]`; `_meta.ui.permissions` (camera, microphone) |
| Tool result | `structuredContent` ("concise data the model can inspect"), `content` (text for the model), `_meta` ("hidden from the model layer") |
| Registering | `registerAppTool(server, ...)` and `registerAppResource(server, name, uri, meta, handler)` from `@modelcontextprotocol/ext-apps/server`; the handler returns `{ contents: [{ uri, mimeType, text }] }` |

Claude adds one requirement: `_meta.ui.domain` must be set, to the first 32 hex
characters of the SHA-256 of the server URL plus `.claudemcpcontent.com`. For
`https://plan.s-m-r-t.dev/mcp` that is
`482d08d029435c4039885c3c35060076.claudemcpcontent.com` (computed with the
command on the Claude page). It changes if the URL does.

### The widget bridge

The widget runs in a sandboxed iframe and talks to the host by JSON-RPC over
`postMessage`. Shared methods named on the pages: `ui/initialize`,
`ui/notifications/tool-input`, `ui/notifications/tool-result` (carries
`structuredContent`), `ui/update-model-context`, `tools/call`, `ui/message`.
`@modelcontextprotocol/ext-apps` wraps them: `new App(...)`, `app.ontoolresult`,
`app.callServerTool()`, `app.connect()` (with no transport argument it detects
the host).

ChatGPT-only extensions, all optional, on `window.openai`: `toolInput`,
`toolOutput` ("Returned `structuredContent`"), `toolResponseMetadata`
("Widget-only result metadata"), `widgetState` and `setWidgetState(state)`,
`callTool(name, arguments)`, `sendFollowUpMessage(message)`, `theme`, `locale`,
`displayMode`, `maxHeight`, `requestModal`, `uploadFile`. The mapping the
OpenAI page gives: `callTool` is `tools/call`; `sendFollowUpMessage` is
`ui/message`. Display modes: inline card, inline carousel, fullscreen,
picture-in-picture.

Two rules from the pages that shape the design: tool output is "untrusted
input" to the widget, and `widgetState` "belongs to one rendered UI instance.
Do not use it as the source of truth for business data."

### Auth

- ChatGPT: "Many plugin MCP servers can operate in a read-only, anonymous mode,
  but anything that exposes customer-specific data or write actions should
  authenticate users." A tool with `securitySchemes: [{ type: "noauth" }]` is
  "callable anonymously". OAuth 2.1 would need
  `/.well-known/oauth-protected-resource`, authorization server metadata with
  `code_challenge_methods_supported: ["S256"]`, and DCR or CIMD.
- Claude: "Your server can let Claude in with OAuth 2.0 ... with a static
  credential ... or with no authentication at all." OAuth redirect is
  `https://claude.ai/api/mcp/auth_callback`.

Our plans are anonymous capability documents with no user data, so: no auth,
`noauth` on every tool. See open question 3 for the write-tools objection.

### Transport and limits

Both require a public HTTPS Streamable HTTP endpoint at `/mcp` (OpenAI:
"Expose a streamable HTTP endpoint, typically at `/mcp`"; Claude: "Use
Streamable HTTP"; legacy HTTP+SSE is "being deprecated"). Claude limits (hosted
surfaces): about 150,000 characters per tool result and 240 seconds per call.
Claude does not support resource subscriptions or sampling. OpenAI documents no
`structuredContent` size limit.

### Connecting and publishing

- ChatGPT, own use: Plugins > plus > "Add custom MCP server", paste the HTTPS
  `/mcp` URL, choose authentication, accept the risk warning. After changing
  tools, use Refresh on the connection and start a new conversation. "Account
  and workspace policies apply"; plan restrictions are not stated.
- ChatGPT, publish: organization or individual verification; HTTPS privacy
  policy, support page, website and terms URLs; domain challenge token at
  `https://<hostname>/.well-known/openai-apps-challenge`; icons (square, at
  least 48 px, light and dark); tool annotations that pass automated scans;
  5 positive and 3 negative test cases, a video walkthrough, release notes and
  a test account "with sample data".
- Claude: add the URL as a custom connector (no Anthropic review), or submit to
  the directory (review; anyone on a paid plan can submit, on Team and
  Enterprise an Owner submits). Custom connectors need a Pro, Max, Team or
  Enterprise plan (search summary, not the page itself).

### Not verified

- The old `text/html+skybridge` MIME type and `openai/outputTemplate` as the
  primary key: the current pages use `text/html;profile=mcp-app` and
  `_meta.ui.resourceUri`. Use the current ones.
- Any `structuredContent` size cap for ChatGPT; the iframe size for each
  display mode.
- ChatGPT's own `ui.domain` format (Claude's is documented, ChatGPT's page
  only names `openai/widgetDomain`).
- The ChatGPT plan tiers that may add custom MCP servers.
- Claude's exact callback and IP allowlist text (support page 404).
- Whether the MCP Apps `App` class works with the v1 `@modelcontextprotocol/sdk`:
  ext-apps 2.0.3 declares peers `@modelcontextprotocol/server`, `client`, `core`
  `^2.0.0` and `zod ^4.2.0`.

## 2. The widget in ChatGPT and Claude

**What renders.** The real planner component, not a look-alike: `Planner` from
`@happyvertical/smrt-planner` with `layout="own"`, `persistence="host"`, no
`inference`, `tabs=['cookbooks','recipes','features','layout','settings']`. The
Export tab is replaced by a small handoff panel (apply command, link, copy).
The widget is inline by default and offers fullscreen via the host's display
mode for the Layout tab.

**Build.** A separate widget build, not the static app. The static app is about
70 MB, most of it the on-device model runtime; a widget has no use for that and
host iframes want a small document. New `widget/` entry in this repository: a
Vite build of `widget/main.ts` that imports `Planner`, `cookbookStore` and the
MCP Apps `App`, emitted as one self-contained HTML string (script and CSS
inlined) that the server returns from `registerAppResource` at
`ui://widget/plan.html`. With everything inline, `_meta.ui.csp` can be empty
(`connectDomains: []`, `resourceDomains: []`), which keeps review simple. The
bundle size is unknown and must be measured in phase 2 (the catalog and recipe
data are bundled). If it is too large for inline delivery, serve the assets
from `plan.s-m-r-t.dev/widget/*` and list that origin in `resourceDomains`.
Singleton stores are fine here: one iframe, one plan.

**How it gets state.**

1. `start_plan`, `run_commands` and `get_plan` return
   `structuredContent: { planId, url, snapshot }` (about 3-5 KB, the size the
   snapshot is tested to) and put the full document in `_meta.cookbook`, which
   the model does not see (and `toolResponseMetadata` exposes to ChatGPT's
   widget; MCP Apps hosts get it in the tool result).
2. The widget receives `ui/notifications/tool-result` through `app.ontoolresult`
   and calls `cookbookStore.replace(cookbook)`. The user watches the plan build
   because each `run_commands` result re-renders the same widget instance.
3. A click in the widget runs the local controller. A thin wrapper forwards each
   successful command with `app.callServerTool('run_commands', { planId,
   commands, expectedRevision })`. On `conflict` it refetches with `get_plan`
   and replaces. The server stays the single source of truth.
4. UI-only state (active tab, scroll) goes in `widgetState` where the host
   provides it; nothing else.
5. After a manual edit the widget tells the model through the host's
   `ui/update-model-context` (or `sendFollowUpMessage` on ChatGPT) with a
   one-line summary, so the next model turn sees what the user changed.
6. Every value from `structuredContent` is treated as untrusted; the planner
   renders with Svelte (escaped).
