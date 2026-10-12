# smrt-kitchen: the local Kitchen plugin

Plan a business app in conversation, then create the project on your machine.
Your own ChatGPT, Codex or Claude does the reasoning. This plugin adds a
**local** tool server (`smrt kitchen mcp`, over stdio) that holds the plan and
makes the changes, and a skill that tells the assistant how to run the
interview. It needs no separate model, API key, hosted endpoint or browser key
storage, and nothing leaves your machine except package-manifest lookups
against the npm registry.

Tracked in happyvertical/smrt#3752 (epic #3747). The hosted, public-directory
version is deferred in #3751.

## What is in the box

```
plugins/smrt-kitchen/
  plugin.json              portable Agent Plugins manifest (+ extensions.com.openai.interface)
  mcp.json                 stdio server: npx -y @happyvertical/smrt-cli@>=0.55.11 <1 kitchen mcp
  skills/kitchen/SKILL.md  the workflow: interview, pick a cookbook, refine, validate, apply
  assets/                  logo and composer icon (downscaled from smrt-logo.png)
  .claude-plugin/plugin.json   Claude Code overlay (points at mcp.json)
.agents/plugins/marketplace.json     repo marketplace (ChatGPT desktop app, Codex)
.claude-plugin/marketplace.json      Claude Code marketplace (also read by the ChatGPT desktop app)
```

## Tools

| Tool | What it does | Hints |
| --- | --- | --- |
| `list_cookbooks` | Ready-made starting points and the recipes each switches on | read-only |
| `search_recipes` | Find recipes by words in id, name, summary, synonyms | read-only |
| `start_plan` | New plan, empty or from a cookbook; returns the plan id | local state write when `--plans-dir` is set |
| `run_commands` | Atomic batch of plan commands (20 commands: add/remove recipes, settings, theme, rename, hide, undo...). Takes a batch `id` (a retry is applied once) and `expectedRevision` (a stale change is refused) | idempotent |
| `get_plan` | Compact snapshot: revision, recipes, settings, theme, menu | read-only |
| `open_preview` | URL for the live local Planner app shell sharing this plan | read-only |
| `validate_plan` | Document checks plus every recipe, object and field against the package manifests | read-only |
| `export_plan` | The plan as cookbook v1 JSON | read-only |
| `apply_plan` | Create or update the project in an absolute directory (template copy, missing packages into `package.json`, `smrt.cookbook.json`). **Writes only with `confirm: true` plus the `confirmCode` its preview returned for that plan and folder**; without them, or with `dryRun`, it returns a preview (which still fetches the server's template). The template is the server's `--template`, never a per-call argument. Does not install packages unless `install: true` | destructive, idempotent, open-world |

Every tool returns compact text for the model and structured output that
matches its published output schema. With `--plans-dir`, the server saves each
engine state in a private local file and restores revisions and retry receipts
after restart. Undo handles are process-local and expire on restart. Without
`--plans-dir`, plans live in server memory (20 kept). The project's
`smrt.cookbook.json` is the applied copy. Command and error contract:
`packages/core/agents/cookbook-engine.md`.
Server internals: `packages/cli/agents/kitchen.md`.

## Requirements

Node 24 or newer with `npx` on the PATH of the app that launches the plugin
(GUI apps on macOS often have a smaller PATH than your shell; see
Troubleshooting). Network access to the npm registry for the first `npx` run
and for package manifests. The `mcp.json` range `>=0.55.11 <1` assumes the
release that ships `kitchen mcp`; confirm it matches the published
`@happyvertical/smrt-cli` version before telling anyone to install.

Try the server by itself (no host needed):

```sh
npx -y @happyvertical/smrt-cli kitchen mcp          # speaks MCP on stdin/stdout
npx @modelcontextprotocol/inspector --cli node packages/cli/bin/smrt.js kitchen mcp --method tools/list   # from a checkout
```

Options: `--manifests <file|dir>` (repeatable), `--no-registry`, `--packages <name>`,
`--library <dir>`, `--template <path|github:owner/repo[#ref]|url>`,
`--plans-dir <local-directory>`, `--preview-port <port>` and
`--preview-origin http://127.0.0.1:<port>`. The preview bridge listens on
`127.0.0.1`, accepts only that exact browser origin, and exposes the same
`get_plan` and `run_commands` session to the development app shell. The
`render_plan` resource also advertises a ChatGPT thread side panel entrypoint.
The generated local launcher enables durable plans and the preview bridge by
default, with a random loopback port and `http://127.0.0.1:5173` as its allowed
origin. Any page served at that origin can read or edit the bound plan while
the bridge is running, so use that port only for the trusted local Planner.

## Install

Add `--template <local path>` to the server `args` in `mcp.json` if you want to
create projects from a local template instead of `github:happyvertical/smrt-start`.

### ChatGPT desktop app (Work mode / Codex)

**Needs manual verification by the maintainer.** The steps follow OpenAI's
[Package your plugin](https://developers.openai.com/plugins/build/plugins); they
have not been run in the desktop app.

Personal marketplace:

1. `mkdir -p ~/plugins && cp -R plugins/smrt-kitchen ~/plugins/smrt-kitchen`
2. Create or extend `~/.agents/plugins/marketplace.json`:

   ```json
   {
     "name": "personal",
     "interface": { "displayName": "Personal" },
     "plugins": [
       {
         "name": "smrt-kitchen",
         "source": { "source": "local", "path": "./plugins/smrt-kitchen" },
         "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
         "category": "Productivity"
       }
     ]
   }
   ```

3. Restart the ChatGPT desktop app, open the Plugins Directory, choose the
   `Personal` source and install **SMRT Kitchen**.

Or use this repository's marketplace: with the repository checked out and
opened as the project, `.agents/plugins/marketplace.json` lists the plugin from
`./plugins/smrt-kitchen`. Restart the app and pick the `SMRT` source.
`.claude-plugin/marketplace.json` is also read by the app, so the plugin may
appear under both sources; install it from either.

Then start a new chat and try the default prompt "Use SMRT Kitchen to plan an app
for my bakery."

### Codex CLI

**Not verified.** The Codex CLI available when this was written (0.153.2)
refused to add a local marketplace on the development machine because system
requirements restrict marketplace sources, so the command below is from the
documentation only.

```sh
codex plugin marketplace add happyvertical/smrt      # or ./path/to/a/checkout
codex plugin marketplace list
```

Then install **smrt-kitchen** from the `smrt` marketplace in Codex.

### Claude Code

Checked with Claude Code 2.1.296: `claude plugin validate plugins/smrt-kitchen`
and `.claude-plugin/marketplace.json` pass, and loading the plugin from disk
shows the `kitchen` skill and the `smrt-kitchen` MCP server:

```sh
claude --plugin-dir plugins/smrt-kitchen
```

Claude Code reads `.claude-plugin/plugin.json` and its own `.mcp.json` name,
not the portable `plugin.json` and `mcp.json`, so the plugin carries a small
overlay in `.claude-plugin/plugin.json` whose `mcpServers` points at the shared
`mcp.json`. Installing from the marketplace
(`/plugin marketplace add happyvertical/smrt`, then `/plugin install smrt-kitchen@smrt`)
follows Claude Code's documented flow but has **not** been run against this
repository, and the server has not been driven by a live Claude Code session.

## Optional local Planner widget

The local development path below registers an MCP Apps resource for the existing
Planner component. A separate `render_plan` tool opens it; the data tools
remain authoritative and do not remount the widget. Local stdio rendering was
verified in the ChatGPT desktop app on 2026-10-11. The tools work without the widget.

## Verifying it yourself

Automated (no host needed), from `packages/cli`:

```sh
pnpm exec vitest run src/commands/__tests__/kitchen-mcp.test.ts src/commands/__tests__/kitchen-plugin.test.ts
```

These spawn `smrt kitchen mcp` over stdio with the MCP SDK client, check the tool
list, schemas and annotations, run a plan to a project on disk, and check the
plugin files against the Agent Plugins schemas.

Manual (desktop app), the maintainer's checklist:

1. Install as above, restart, and confirm **SMRT Kitchen** shows in the Plugins
   Directory with its icon and default prompts.
2. In a new chat, run the default prompt. Confirm the assistant calls
   `list_cookbooks` / `start_plan` and that the host lists the `smrt-kitchen`
   tools (a stdio MCP server declared in `mcp.json` is the unverified part).
3. Ask for changes (add invoicing, set CAD and 5% tax). Confirm the replies show
   the menu and the tool results show revision numbers moving.
4. Ask it to create the project in an empty folder. Confirm the host asks for
   approval of `apply_plan` and that the first call writes nothing; after you
   agree the folder holds the template, `package.json` with the added packages,
   and `smrt.cookbook.json`.
5. Confirm no model login, API key or sign-in was requested at any step.

## Troubleshooting

- **No tools appear / server fails to start**: the host's PATH may lack `npx`.
  Run `which npx` in a terminal and put that absolute path in `mcp.json`'s
  `command`, or install Node where the app can see it.
- **A plan stays busy after Kitchen was killed**: stop all Kitchen processes,
  then remove that plan's `<plan-id>.json.lock` from the local plans directory
  and retry. Never remove a lock while another Kitchen process may be editing
  the plan.
- **`ETARGET` / no matching version**: the `@happyvertical/smrt-cli` range in
  `mcp.json` is ahead of what is published; use the isolated local checkout
  workflow below. An older published CLI may not contain `kitchen mcp`.
- **Few or no recipes**: the server finds manifests locally (a workspace or
  `node_modules` under the directory the host starts it in) and otherwise from
  the registry. Offline, run from a checkout or pass `--manifests`.
- **Plan not found**: confirm the plan id and the configured plans directory.
  Without `--plans-dir`, a server restart clears in-memory plans; start again
  from an exported cookbook or the project's `smrt.cookbook.json`.

## Local MCP Apps UI development (#3752)

The published manifest stays on its required CLI range. If that version is not
published yet, do not substitute an older CLI: create a separate local plugin
copy pointing at a built checkout, using Node 26 or newer:

```sh
node /path/to/pnpm --filter '@happyvertical/smrt-cli^...' build
node /path/to/pnpm --filter @happyvertical/smrt-cli build
node plugins/smrt-kitchen/scripts/local-plugin.mjs /tmp/smrt-kitchen-local /absolute/planner/app/mcp.html
```

The last command requires a new destination directory. It writes a contained
`./scripts/launch-local` command into **the copy's** `mcp.json`; that launcher
uses the absolute Node executable and built CLI, the checkout cwd,
`--no-registry`, `--ui-smoke`, a private `--plans-dir`, a loopback preview on a
random port for `http://127.0.0.1:5173`, and optional `--planner-ui`. The plugin loader
rejects an absolute executable directly in portable `mcp.json`. Install that
copy through your local marketplace. Omit the HTML argument for the capability
probe alone. Build the Planner artifact with its `node scripts/build-mcp.ts` command.
Restart the host when the Kitchen server code or plugin launcher changes. With
this development server running, rebuilding only the Planner HTML does not
require a restart: the open app tab checks the artifact every 1.5 seconds and
replaces its bundled UI in place when the content changes, keeping its plan
binding and current app tab open. The local
Vite preview continues to provide immediate HMR while editing source files.
If the Planner HTML was missing when the server started, restart the host once
after building it so the UI resource and reload tool are registered.

1. Call `kitchen_ui_smoke`. A compatible desktop host should show “SMRT Kitchen”
   and “Local MCP App resource rendered.” This is only a render capability check.
2. Call `start_plan`, then `render_plan` with the returned `planId`. The second
   tool renders the existing Planner from the self-contained local HTML.
3. Change a setting and call `get_plan` in chat. Its state should match the UI.
   A stale revision must be refused; a failed edit stays visible for recovery.
4. Change the same plan using chat tools and refresh the UI. Confirm both read
   the same server state. With `--plans-dir`, the plan survives a server restart.

Only the dedicated render tools carry `_meta.ui.resourceUri`; the original
data tools remain useful in hosts without UI. Resources use
`text/html;profile=mcp-app`, deny external network/resource origins, and inline
all assets. The Planner resource URI hashes its full content, avoiding stale
host caches after a rebuild. The app-only `planner_ui_update` tool reads that
same operator-selected file on demand and returns HTML only when its version
changes; a tool call cannot choose an arbitrary local file.

The MCP Apps bridge initializes over `postMessage`, checks the parent source,
forwards allowlisted tool calls and tool-result notifications, and returns
`structuredContent` to `window.smrtKitchen`. The `state` field pairs a current
`snapshot` and `cookbook` atomically; the existing command receipt/snapshot can
still describe the original execution of an idempotent replay. The UI must read
`state`, bind its plan id, and reject older revisions. Project creation remains
in chat through the existing confirmed `apply_plan` workflow.

The local desktop host check rendered the Planner shell, kept its app tab open
through a bundled UI change, and restored the normal bundle without a restart.
If a rebuilt UI cannot load, the tab shows a reopen notice and avoids repeatedly
sending the rejected bundle. Packaged and published plugin installation remains
to be checked separately.

Protocol references: [OpenAI MCP Apps UI](https://developers.openai.com/plugins/build/chatgpt-ui)
and [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).
