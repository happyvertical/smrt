---
id: agent-tooling
title: Developing a s-m-r-t app with an agent
sidebar_label: Agent tooling
sidebar_position: 4
---

# Developing a s-m-r-t app with an agent

One walkthrough for the tooling a coding agent uses against a s-m-r-t
application: install the development MCP server, point it at the app, run the
handful of calls that answer real questions, and read the provenance label on
every answer. Everything here is deterministic and read-only; nothing writes
to the project or the database.

## 1. Install the development MCP server

Add `@happyvertical/smrt-dev-mcp` to the agent's MCP configuration. The server
speaks stdio and needs no build step in the target app:

```json
{
  "mcpServers": {
    "smrt-dev-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@happyvertical/smrt-dev-mcp"],
      "env": { "DEBUG": "false" }
    }
  }
}
```

Start the agent from the app's root. The server resolves the project from its
working directory and finds objects in this order: `.smrt/manifest.json`, then
`dist/manifest.json`, then a source scan. Run the app's build once so the
manifest exists; discovery reports which source it used and why.

For a project managed by a toolchain-specific Node, point `command` at an
absolute `node` and `args` at the installed `dist/index.js` instead of `npx`.

## 2. The calls that matter, in order

Each call returns an envelope of `{ ok, coverage, diagnostics, data }`. Read
`diagnostics` first: a tool that cannot answer says why, and never fabricates.

1. **`introspect-project`** answers "what objects exist here?" in one compact
   record per object: class, file, `extends`, table, field count, relationship
   summary, MCP operations. Pass `detail: "full"` for fields, schema, and
   methods. Large projects page: pass the returned `nextCursor` back as
   `cursor`. This is the cheapest map of the app an agent can get.
2. **`check-knowledge-freshness`** lists concrete, fixable defects in the
   agent-facing docs and generated knowledge: a stale artifact, a missing
   `AGENTS.md`, a `CLAUDE.md` that is not the required shim. Pass
   `strict: true` in CI-equivalent runs.
3. **`runtime-object`** answers "what will this class actually be at runtime?"
   for one object: fields, methods, tenancy, inheritance, and the `CREATE TABLE`
   the registry would generate for the chosen engine. It boots the project's
   manifests into an in-process registry without importing project code.
4. **`runtime-schema-diff`** compares those booted schemas with the live
   development database using the same comparer as `smrt db:diff`. It only
   introspects; drops and relaxations are never proposed.
5. **`generate-smrt-class`** scaffolds an idiomatic `@smrt()` class from a
   field list. The output is source text meant to be pasted, not an envelope.

For a change review or a design question, **`build-context`** with
`task: "review"` (changed files, focus) or `task: "architecture"` (an idea)
returns the package experts to consult, file-anchored findings, package
hints, and a prompt bundle. `smrt-review` and `smrt-architecture` remain for
one release as deprecated names for the same call.

## 3. Read the provenance label

Every runtime answer carries `provenance`, and the labels are the contract:

| Label | Meaning |
|---|---|
| `static` | Derived from files only; no registry boot, no database. Also the successful fallback when no database is configured. |
| `declared (manifest)` | Facts the confined boot registered from the project and installed-package manifests. |
| `booted (registry)` | The in-process `ObjectRegistry` view, projected through a sanitized snapshot (no constructors, validators, values, or absolute paths). |
| `runtime (live DB)` | Read from the configured development database with SELECT-only queries and redacted output. |

Facts under different labels can disagree; that disagreement is usually the
answer to the question being asked.

## 4. Optional: a live development database

The six `_smrt_*` diagnostics (`migration-status`, `job-health`,
`schedule-health`, `dispatch-health`, `recent-changes`, `registry-drift`)
and `runtime-schema-diff` connect when a database is configured, in this
order: a `dbUrl` argument, the `SMRT_DEV_DB_URL` environment variable, then
the project's `cli.database` config. Accepted forms are `file:///abs/dev.db`,
`sqlite:///abs/dev.db`, a bare path, `postgres://…`, or `duckdb:…`;
`:memory:` counts as not configured.

Without a database every call still succeeds with `provenance: "static"`.
With one, each category reports `available` and a `reason` when it cannot
answer, an older schema is reported as `schema_behind` rather than failing,
and job payloads, schedule `agentConfig`, dispatch metadata, credentials, and
local paths are never returned.

## 5. Optional: the runtime dev-plane over HTTP

`smrt-dev-mcp --http [--port N] [--project DIR]` boots the project once and
serves the nine runtime tools over stateless Streamable HTTP on loopback only,
protected by a bearer token (`SMRT_DEV_MCP_TOKEN`, or one minted and printed
once at start). The static catalog, generated CRUD, custom actions, and `do()`
are never mounted. Use it when several agents or a browser tab need the same
booted view; the stdio server remains the default.

## 6. CLI equivalents

The same knowledge and checks are available without an MCP client:

- `smrt dev:knowledge-index` and `smrt dev:knowledge-check --strict` mirror
  `reflect-knowledge` and `check-knowledge-freshness`.
- `smrt dev:knowledge-review-context` and
  `smrt dev:knowledge-architecture-context` mirror `build-context`.
- `smrt db:diff` and `smrt runtime:check` cover the schema diff and the
  manifest/registry consistency check from the developer's terminal.

## Where the details live

- Tool parameters and response budgets: the `@happyvertical/smrt-dev-mcp`
  package README (copied into **Packages** in this sidebar).
- The `_smrt_*` reader contract: `packages/core/agents/system-diagnostics.md`.
- The sanitized registry snapshot: `packages/core/agents/registry-snapshot.md`.
- The dev-MCP configuration section on the [core page](./core.md).
