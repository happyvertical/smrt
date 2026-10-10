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
| `start_plan` | New plan, empty or from a cookbook; returns the plan id | writes only server memory |
| `run_commands` | Atomic batch of plan commands (20 commands: add/remove recipes, settings, theme, rename, hide, undo...). Takes a batch `id` (a retry is applied once) and `expectedRevision` (a stale change is refused) | idempotent |
| `get_plan` | Compact snapshot: revision, recipes, settings, theme, menu | read-only |
| `validate_plan` | Document checks plus every recipe, object and field against the package manifests | read-only |
| `export_plan` | The plan as cookbook v1 JSON | read-only |
| `apply_plan` | Create or update the project in an absolute directory (template copy, missing packages into `package.json`, `smrt.cookbook.json`). **Writes only with `confirm: true` plus the `confirmCode` its preview returned for that plan and folder**; without them, or with `dryRun`, it returns a preview (which still fetches the server's template). The template is the server's `--template`, never a per-call argument. Does not install packages unless `install: true` | destructive, idempotent, open-world |

Every tool returns compact text for the model and structured output that
matches its published output schema. Plans live in the server process (20 kept);
a restart forgets them, and the project's `smrt.cookbook.json` is the durable
copy. Command and error contract: `packages/core/agents/cookbook-engine.md`.
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
`--library <dir>`, `--template <path|github:owner/repo[#ref]|url>`.

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

## Optional widget (not built)

The planner UI (the `Planner` component of `@happyvertical/smrt-planner`) could
be offered as an MCP Apps resource. The tools stay authoritative; the widget
would only render the same snapshot. It would attach by registering a
`ui://` resource on the server and adding `_meta.ui.resourceUri` to the tools
whose result it shows (`get_plan`, `run_commands`, `start_plan`). Whether the
ChatGPT desktop app renders a UI resource from a **local stdio** server is the
open question of the #3752 spike and is **needs manual verification by the
maintainer**; nothing here depends on it.

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
- **`ETARGET` / no matching version**: the `@happyvertical/smrt-cli` range in
  `mcp.json` is ahead of what is published; use `@latest` while testing.
- **Few or no recipes**: the server finds manifests locally (a workspace or
  `node_modules` under the directory the host starts it in) and otherwise from
  the registry. Offline, run from a checkout or pass `--manifests`.
- **Plan not found**: the host restarted the server. Start again from the
  exported cookbook or the project's `smrt.cookbook.json`.
