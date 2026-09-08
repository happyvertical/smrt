# @happyvertical/smrt-dev-mcp

Development MCP server for the s-m-r-t framework providing code generation,
project introspection, deterministic ecosystem knowledge, and portable review
or architecture prompt bundles.

## Installation

New to agent-assisted s-m-r-t development? Start with the end-to-end guide on
the docs site: [Developing a s-m-r-t app with an agent](https://s-m-r-t.dev/docs/agent-tooling)
(source: `docs/content/agent-tooling.md`). It walks through install, the
calls that matter in order, provenance labels, and the optional live-database
and HTTP setups this README details.

```bash
pnpm install @happyvertical/smrt-dev-mcp
```

## Agent Plugins package

The published package root is a self-contained [Agent Plugins 1.0.0](https://agent-plugins.org/specification)
plugin. Compatible clients discover `plugin.json`, `mcp.json`, and
`skills/smrt-code-review/SKILL.md` directly from the installed package root.
The shipped `mcp.json` declares only the local stdio server:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "smrt-dev-mcp": { "type": "stdio", "command": "./dist/index.js" }
  }
}
```

The executable path is plugin-relative and must remain inside the resolved
plugin root. Clients provide `PLUGIN_ROOT` (the resolved package root) and the
client-managed, persistent `PLUGIN_DATA` directory; this package does not set
or override either reserved environment variable. Portable configuration never
contains credentials, secrets, authorization headers, or OAuth settings.
Clients own authorization interaction and credential storage.

Agent Plugins 1.0.0 is a Working Draft. This package targets only the canonical
1.0.0 schema identifiers and includes pinned schema snapshots for offline
validation; clients must not fetch schemas when loading the package.

`streamable-http` is not shipped: its endpoint is gated on #2147. A future,
credential-free configuration could declare a `streamable-http` URL only after
that endpoint exists; it must not be inferred from this package today.

## Usage

Add to your project-local `.mcp.json`, Codex MCP config, or Claude Desktop
config:

```json
{
  "mcpServers": {
    "smrt-dev-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@happyvertical/smrt-dev-mcp"]
    }
  }
}
```

For global MCP client config, prefer a launcher that does not depend on the
current working directory. Avoid `command = "pnpm"` with
`args = ["exec", "smrt-dev-mcp"]` in user-level config: MCP clients can start
servers from repositories that do not install this package, and pnpm can run
dependency-status or build-approval checks before the MCP server starts.

Install the package in a stable location and point Codex at the built server:

```toml
[mcp_servers.smrt-dev-mcp]
command = "node"
args = ["/absolute/path/to/node_modules/@happyvertical/smrt-dev-mcp/dist/index.js"]
```

If your Node runtime is managed by a toolchain, use a tiny absolute wrapper
instead:

```sh
#!/usr/bin/env sh
exec /absolute/path/to/node /absolute/path/to/node_modules/@happyvertical/smrt-dev-mcp/dist/index.js "$@"
```

```toml
[mcp_servers.smrt-dev-mcp]
command = "/absolute/path/to/smrt-dev-mcp-wrapper"
args = []
```

Set `DEBUG=true` in the environment to enable diagnostic logging.

## Workspace Discovery And Coverage

Package discovery reads the workspace globs, so `apps/*` products are indexed
the same as `packages/*` ones. Resolution order:

1. `pnpm-workspace.yaml` `packages:` — literals, `dir/*`, `**`, and `!` negations
2. `package.json#workspaces` (array or `{ packages: [...] }`)
3. `packages/*` as a last-resort fallback

Workspace globs must remain relative to the declared root: absolute paths and
`..` segments are rejected, and matched directories are realpath-confined before
their manifests are read. Positive globs share a 10,000 directory-entry
traversal budget. Exceeding it stops discovery with an error diagnostic and no
partial package set; deeply nested valid `**` matches remain supported because
the limit is based on work performed rather than directory depth. A separate
512-package cap prevents broad matches from fanning out package reads, package
paths are revalidated immediately before those reads, and scanner fallbacks run
with at most eight concurrent scanners.

The workspace root is also indexed when it has a `package.json`, which is how
single-package repositories work; it is scanned with the member package
directories excluded so it can own objects without absorbing theirs. Per package, objects resolve from a domain
artifact, then a package-local manifest, then a source scan
(`@happyvertical/smrt-scanner`) — the same fallback `introspect-project` uses, so
both paths agree on one root. Every package records `objectSource`
(`domain-artifact | manifest | scanner | none`) plus a reason.

Manifest objects that belong to another package are rejected rather than counted:
a runtime `.smrt/manifest.json` is often an aggregate registering a package's
dependencies too, and counting those inflates the relationship facts. A consuming
package's artifact can also restate its dependency's objects under its own name,
so `Relationships-v2` collapses a shared `className::tableName` across a
dependency edge — by connected component, keeping the copy the others depend on —
and reports `duplicate-object-identity`. Unrelated packages that share a class
name stay distinct.

The index therefore carries two extra blocks (added in `schemaVersion: 2`):

- `coverage` — `workspaceGlobs`, `workspaceGlobSource`, `packageDirs`,
  `packagesWithObjects`, and `packagesWithoutObjects` with a reason, the artifact
  paths checked, and a remedy for each
- `diagnostics` — discovery problems. Discovering **zero** objects is an
  error-grade diagnostic naming the roots and artifact paths checked plus the
  commands to fix it, so an unseen project is never reported as a project with no
  model. `smrt-architecture`, `smrt-review`, and the `reflect-*` tools surface it.

`schemaVersion: 3` adds the consumer-app view: `installedPackages` lists every
installed `@happyvertical/smrt-*` package plus the known SDK packages — the ones
the project installs rather than authors — each with `isInstalledDependency`, its
version, and `agentDocSha256`, the hash of its shipped `AGENTS.md`. That hash is
what a downstream project diffs against a recorded baseline to find documentation
drift. Reach it with `--scope installed`.

## Response Budgets

Knowledge and introspection tools return a **summary** by default and accept
`detail: "complete"` for complete knowledge context payloads (`introspect-project` uses `full`).

- `introspect-project` summary returns one compact record per object
  (`className`, `qualifiedName`, `extends`, `tableName`, `tenantScope`,
  `fieldCount`, compact relationship strings, `mcpOperations`). A response
  that exceeds its character budget, or that was cut short by `limit`, reports
  a `truncated` block with the omitted count and guidance instead of being
  silently cut. `maxChars` overrides the budget, and any truncated response
  carries `nextCursor`; pass it back as `cursor` to read the next alphabetical
  page. `runtime-registry` pages the
  same way (`page.nextCursor`, `limit` default 50) while its summary stays
  global.
- `smrt-architecture`, `smrt-review`, and the `build-*-context` tools list
  authored `AGENTS.md` and module docs **by path** rather than embedding them,
  and return compact package records. With `detail: "full"`, they embed the package
  AGENTS doc plus module docs matching changed files or request text. Source paths and globs
  in the same Modules-table row as a doc link also select that module. Missing or
  unmatched hints leave all module docs listed by path for on-demand reading.
  `detail: "complete"` embeds every module and returns complete package records.
  With `detail: "full"` or `"complete"`, prompt
  bundles also render high-signal object facts: tenant mode/field, `cti`/`sti`
  strategy, conflict columns, method signatures, and field
  defaults/constraints/readonly/transient flags.

The `smrt dev:knowledge-*` CLI commands request `detail: "full"`, so they remain
structurally detailed and unbudgeted. Add `--complete` to embed every module.

## Knowledge Boundary

`smrt-dev-mcp` is model-agnostic. Its review and architecture tools do not call
Codex, Claude, or any other model provider directly. They return deterministic
findings plus a reusable prompt bundle that can be sent to the local model plan
or provider of your choice.

Downstream s-m-r-t packages/apps can publish their own scoped
`smrt-knowledge.json` artifact. Discovery prefers local
`.smrt/smrt-knowledge.json`, then `dist/smrt-knowledge.json`, then source
manifest artifacts before falling back to raw manifest/doc scanning. The runtime
`manifest.json` stays focused on object registration; `smrt-knowledge.json` is
the agent/developer contract. Its schema-version-1 structural keys are additive,
and older artifacts without them remain readable. Sensitive fields are excluded
from both the curated artifact and raw-manifest fallback projection, including
legacy sensitivity flags under `_meta`.
Sensitive field names and their snake-case column names are also removed from
projected conflict columns. A sensitive custom tenant-field name is omitted
while its tenant scope and mode remain available.
New artifacts record `sensitiveFieldsExcluded: true`. For a legacy schema-v1
artifact without that marker, the reader cross-checks the owning raw manifest
and omits any field or structural identifier it cannot corroborate as safe.

## Cache Metadata

The deploy-static `tools/list` and `prompts/list` catalogs advertise a one-day
`private` cache lifetime. Workspace knowledge resources (`resources/list` and
`resources/read`) are also `private`, but use `ttlMs: 0`: they are rebuilt from
the current workspace on each request and have no transport-visible invalidation
signal that could make a positive freshness promise honest.

After using a model to update package docs or expertise, always run the
deterministic checker again:

```bash
pnpm knowledge:check --strict --format markdown
```

Use `--format json` when another script needs machine-readable output.

## Downstream Review Flow

1. Run the downstream app build or dev server so `.smrt/smrt-knowledge.json`
   exists.
2. Call `reflect-domain-knowledge` to confirm package and SDK coverage.
3. Call `build-domain-review-context` or `smrt-review` with changed files,
   `scope`, and optional `package`.
4. Send the returned prompt bundle to Codex, Claude, or another model.
5. Re-run `check-domain-knowledge` after edits.

Equivalent CLI commands are:

```bash
smrt knowledge:review-context --scope package --package content --format markdown
smrt knowledge:architecture-context "tenant-aware publishing workflow" --format json
```

## Agent Skills

The package ships harness-agnostic agent skills under `skills/`, the fixed
Agent Plugins discovery location.

Downstream agents should fetch the review procedure before starting a formal
s-m-r-t review:

```json
{
  "name": "get-agent-skill",
  "arguments": {
    "name": "smrt-code-review"
  }
}
```

The returned `skillMarkdown` is plain Markdown with YAML frontmatter (`name`
and `description`) and a harness-neutral body. Skill-aware harnesses can parse
the frontmatter; other MCP-capable harnesses can ignore it, call `smrt-review`
for deterministic context, inspect the actual diff, and produce a findings-first
review. Native MCP prompt/resource clients can also load the `smrt-code-review`
prompt or `smrt-dev-mcp://agent-skills/smrt-code-review` resource.

## Available Tools

The server exposes these MCP tools:

### `generate-smrt-class`

Generate a complete s-m-r-t class with `@smrt()` decorator, fields, and imports.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `className` | `string` | Yes | Class name (PascalCase) |
| `properties` | `object[]` | Yes | Property definitions (`name`, `type`, `required?`, `nullable?`, `description?`, `defaultValue?`) |
| `baseClass` | `'SmrtObject' \| 'SmrtCollection'` | No | `'SmrtObject'` (default) or `'SmrtCollection'` |
| `template` | `'basic' \| 'global-catalog' \| 'optional-catalog' \| 'tenant-project-object' \| 'tenant-event-log-object' \| 'cross-package-reference'` | No | Generation template (default: `basic`) |
| `tableName` | `string` | No | Explicit `@smrt({ tableName })` value |
| `conflictColumns` | `string[]` | No | Explicit upsert natural key columns |
| `tenantScoped` | `boolean \| object` | No | Add `@TenantScoped(...)`; object supports `mode`, `field`, and bypass/filter options |
| `includeTenantIdField` | `boolean` | No | Emit a matching `@tenantId()` field |
| `relationships` | `object[]` | No | Relationship definitions for `foreignKey`, `crossPackageRef`, `oneToMany`, or `manyToMany` |
| `includeCompanionSnippets` | `boolean` | No | Append package wiring notes |
| `includeApiConfig` | `boolean` | No | Include REST API config (default: true) |
| `includeMcpConfig` | `boolean` | No | Include MCP config (default: true) |
| `includeCliConfig` | `boolean` | No | Include CLI config (default: true) |

Supported property types: `text`, `integer`, `decimal`, `boolean`, `datetime`, `json`.

### `introspect-project`

Scan a project directory for s-m-r-t objects and return a manifest-equivalent
class/field/relationship report. Discovery prefers `.smrt/manifest.json`, then
`dist/manifest.json`, then `src/manifest/manifest.json`; when no artifact is
available it falls back to `@happyvertical/smrt-scanner`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `directory` | `string` | No | Project directory (default: cwd) |
| `manifestPath` | `string` | No | Explicit manifest artifact path |
| `detail` | `'summary' \| 'full'` | No | Default `summary`. `full` returns field, schema, and method detail |
| `maxChars` | `number` | No | Response character budget; overflow is reported under `truncated` |
| `cursor` | `string` | No | Resume after this `className` (alphabetical); pass a previous response's `nextCursor` |
| `limit` | `number` | No | Maximum objects per page, applied before the character budget |
| `includeFields` | `boolean` | No | Include field details (`detail: "full"` only) |
| `includeRelationships` | `boolean` | No | Analyze relationships (`detail: "full"` only) |
| `includeMethods` | `boolean` | No | Include public method details (`detail: "full"` only) |

### `review-smrt-project`

Run an advisory downstream ecosystem review. The tool scans package manifests
and source imports for missing HappyVertical dependencies, direct storage
bypasses, custom HTTP shells, custom object manifest generation, local
auth/tenancy/audit seams, and UI shell drift. It returns deterministic findings
and suggested follow-up issue titles; it does not modify files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `directory` | `string` | No | Project directory (default: cwd) |
| `rootDir` | `string` | No | Compatibility alias for `directory` |
| `includeSourceEvidence` | `boolean` | No | Include file/line evidence (default: true) |
| `maxFindings` | `number` | No | Limit findings returned |

### `reflect-knowledge`

Return package coverage, SDK package coverage, relationship-v2 counts, and
freshness status from the deterministic s-m-r-t + HappyVertical SDK knowledge
index.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |

### `reflect-domain-knowledge`

Return domain artifact coverage, missing exported artifacts, SDK package
coverage, relationship-v2 counts, and freshness status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |
| `scope` | `'project' \| 'local' \| 'package' \| 'sdk' \| 'installed'` | No | Knowledge source scope (default: `project`) |
| `package` | `string` | No | Package name or short name to focus |

### `check-knowledge-freshness`

Run the same deterministic freshness checks exposed by `pnpm knowledge:check`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |
| `changed` | `boolean` | No | Limit stale-pattern checks to changed files |
| `strict` | `boolean` | No | Treat stale-pattern findings as errors |

### `check-domain-knowledge`

Alias over the deterministic checker that emphasizes downstream
`smrt-knowledge.json` artifact freshness.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |
| `changed` | `boolean` | No | Limit stale-pattern checks to changed files |
| `strict` | `boolean` | No | Treat stale-pattern findings as errors |
| `scope` | `'project' \| 'local' \| 'package' \| 'sdk' \| 'installed'` | No | Knowledge source scope (default: `project`) |
| `package` | `string` | No | Package name or short name to focus |

### `build-review-context`

Select relevant s-m-r-t and HappyVertical SDK package expertise for changed files,
then return a model-ready prompt bundle.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |
| `changedFiles` | `string[]` | No | Files to route to package experts |
| `focus` | `string` | No | Review focus or concern |
| `documentation` | `string` | No | Additional docs or notes to include |
| `detail` | `'summary' \| 'full' \| 'complete'` | No | Default `summary`; `full` embeds package docs and matching modules; `complete` embeds all modules and full package records |

### `build-domain-review-context`

Domain-scoped alias for `build-review-context`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |
| `changedFiles` | `string[]` | No | Files to route to package experts |
| `focus` | `string` | No | Review focus or concern |
| `documentation` | `string` | No | Additional docs or notes to include |
| `scope` | `'project' \| 'local' \| 'package' \| 'sdk' \| 'installed'` | No | Knowledge source scope (default: `project`) |
| `package` | `string` | No | Package name or short name to focus |
| `detail` | `'summary' \| 'full' \| 'complete'` | No | Default `summary`; `full` embeds package docs and matching modules; `complete` embeds all modules and full package records |

### `smrt-review`

Return deterministic review findings, a prompt bundle, or both.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |
| `changedFiles` | `string[]` | No | Files to route to package experts |
| `focus` | `string` | No | Review focus or concern |
| `documentation` | `string` | No | Additional docs or notes to include |
| `mode` | `'findings' \| 'prompt-bundle' \| 'both'` | No | Response mode (default: `both`) |
| `detail` | `'summary' \| 'full' \| 'complete'` | No | Default `summary`; `full` embeds package docs and matching modules; `complete` embeds all modules and full package records |

### `build-architecture-context`

Select relevant s-m-r-t and SDK package expertise for an idea or documentation,
then return a model-ready architecture prompt bundle.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |
| `idea` | `string` | No | Product or implementation idea |
| `documentation` | `string` | No | Existing docs or requirements |
| `focus` | `string` | No | Architecture concern to prioritize |
| `detail` | `'summary' \| 'full' \| 'complete'` | No | Default `summary`; `full` embeds package docs and matching modules; `complete` embeds all modules and full package records |

### `build-package-specialist-context`

Build deterministic package-specific context for the Workbench, including the
package's authored docs, manifests, routes, tests, prompts, and SDK dependency
context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |
| `package` | `string` | Yes | Package name or short package query |
| `focus` | `string` | No | Package concern to prioritize |

### `build-domain-architecture-context`

Domain-scoped alias for `build-architecture-context`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |
| `idea` | `string` | No | Product or implementation idea |
| `documentation` | `string` | No | Existing docs or requirements |
| `focus` | `string` | No | Architecture concern to prioritize |
| `scope` | `'project' \| 'local' \| 'package' \| 'sdk' \| 'installed'` | No | Knowledge source scope (default: `project`) |
| `package` | `string` | No | Package name or short name to focus |
| `detail` | `'summary' \| 'full' \| 'complete'` | No | Default `summary`; `full` embeds package docs and matching modules; `complete` embeds all modules and full package records |

### `smrt-architecture`

Return package recommendations, SDK recommendations, an object-model sketch,
risks, questions, and the reusable architecture prompt bundle.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |
| `idea` | `string` | No | Product or implementation idea |
| `documentation` | `string` | No | Existing docs or requirements |
| `focus` | `string` | No | Architecture concern to prioritize |
| `detail` | `'summary' \| 'full' \| 'complete'` | No | Default `summary`; `full` embeds package docs and matching modules; `complete` embeds all modules and full package records |

### `list-agent-skills`

List bundled harness-agnostic agent skills.
No parameters.

### `get-agent-skill`

Return a bundled agent skill as Markdown, with optional referenced files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `'smrt-code-review'` | Yes | Skill name |
| `includeReferences` | `boolean` | No | Include referenced files (default: true) |

### `migration-status`

Live migration status from the `_smrt_schema_migrations` system table:
completed / running / failed / rolled-back counts (the tracker's real status
vocabulary) plus the latest completed and the failed migrations. Runtime
provenance (`runtime (live DB)`); read-only. Without a configured connection it
returns a successful static-only result.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dbUrl` | `string` | No | Optional dev database URL override (read-only diagnostics); prefer `SMRT_DEV_DB_URL` or `cli.database` config |
| `dbType` | `'sqlite' \| 'postgres' \| 'duckdb'` | No | Optional engine hint for `dbUrl` or the environment connection; inferred from the URL scheme when omitted |
| `limit` | `number` | No | Row budget for result lists (default 50, capped at 500) |

### `job-health`

Live job queue health from the `_smrt_jobs`, `_smrt_workers`, and
`_smrt_job_events` system tables: counts by status, stuck/failed jobs, worker
liveness. Job payloads and results are never read. Runtime provenance;
read-only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dbUrl` | `string` | No | Optional dev database URL override (read-only diagnostics); prefer `SMRT_DEV_DB_URL` or `cli.database` config |
| `dbType` | `'sqlite' \| 'postgres' \| 'duckdb'` | No | Optional engine hint for `dbUrl` or the environment connection; inferred from the URL scheme when omitted |
| `limit` | `number` | No | Row budget for result lists (default 50, capped at 500) |

### `schedule-health`

Live agent schedule health from the `_smrt_agent_schedules` system table:
due/overdue/errored counts, last/next run per schedule. The sensitive
`agentConfig`/`methodArgs` columns are never read. Runtime provenance;
read-only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dbUrl` | `string` | No | Optional dev database URL override (read-only diagnostics); prefer `SMRT_DEV_DB_URL` or `cli.database` config |
| `dbType` | `'sqlite' \| 'postgres' \| 'duckdb'` | No | Optional engine hint for `dbUrl` or the environment connection; inferred from the URL scheme when omitted |
| `limit` | `number` | No | Row budget for result lists (default 50, capped at 500) |

### `dispatch-health`

Live dispatch health from the `_smrt_dispatch` and
`_smrt_dispatch_subscriptions` system tables: stuck/pending messages by type
and status plus subscription topology. Dispatch payloads and metadata are never
read. Runtime provenance; read-only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dbUrl` | `string` | No | Optional dev database URL override (read-only diagnostics); prefer `SMRT_DEV_DB_URL` or `cli.database` config |
| `dbType` | `'sqlite' \| 'postgres' \| 'duckdb'` | No | Optional engine hint for `dbUrl` or the environment connection; inferred from the URL scheme when omitted |
| `limit` | `number` | No | Row budget for result lists (default 50, capped at 500) |

### `recent-changes`

Tail of the `_smrt_changes` append-only change feed with cursor semantics,
filterable by table and tenant. Runtime provenance; read-only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dbUrl` | `string` | No | Optional dev database URL override (read-only diagnostics); prefer `SMRT_DEV_DB_URL` or `cli.database` config |
| `dbType` | `'sqlite' \| 'postgres' \| 'duckdb'` | No | Optional engine hint for `dbUrl` or the environment connection; inferred from the URL scheme when omitted |
| `since` | `number` | No | Cursor to read after (default 0) |
| `tables` | `string[]` | No | Restrict to these physical table names |
| `tenantId` | `string` | No | Tenant narrowing filter |
| `limit` | `number` | No | Page size (default 200, capped at 500) |

### `registry-drift`

Registry drift report. `_smrt_registry` is retired (system schema 1.10.1) and
is never queried: the tool reports the retirement and whether a legacy empty
table remains, and never fabricates drift. Declared objects come from the
static manifest tools. Read-only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dbUrl` | `string` | No | Optional dev database URL override (read-only diagnostics); prefer `SMRT_DEV_DB_URL` or `cli.database` config |
| `dbType` | `'sqlite' \| 'postgres' \| 'duckdb'` | No | Optional engine hint for `dbUrl` or the environment connection; inferred from the URL scheme when omitted |

### `runtime-registry`

Sanitized snapshot of the booted `ObjectRegistry`: objects, packages, tables,
fields, methods, tenancy, and inheritance, projected through a plain-JSON DTO.
The boot registers the project's `.smrt/manifest.json` (or `dist/manifest.json`)
and every installed s-m-r-t package manifest; no project code is imported. Booted
provenance (`booted (registry)`); read-only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectPath` | `string` | No | Project root to boot manifests from (default: the server working directory; ignored by the HTTP host, which boots once) |
| `objects` | `string[]` | No | Restrict field/method detail to these simple or qualified object names |
| `detail` | `boolean` | No | Include field and method detail for every object (default: only when `objects` is given) |
| `cursor` | `string` | No | Resume after this qualified object name; pass a previous response's `page.nextCursor` |
| `limit` | `number` | No | Objects per page (default 50, capped at 500) |

### `runtime-object`

One booted object: sanitized fields, methods, tenancy, inheritance, and the
DDL the registry would generate for it. Booted provenance; read-only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectPath` | `string` | No | Project root to boot manifests from (default: the server working directory; ignored by the HTTP host, which boots once) |
| `name` | `string` | Yes | Simple or qualified object name |
| `engine` | `'sqlite' \| 'postgres' \| 'duckdb'` | No | Engine for the DDL preview (default: registry default) |

### `runtime-schema-diff`

Booted registry schemas versus the live dev database, using the same comparer
as `db:diff`/`db:migrate`. Introspection only: drops and relaxations are never
proposed and nothing is executed. Runtime provenance; read-only. Without a
configured connection it returns a successful static-only result.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectPath` | `string` | No | Project root to boot manifests from (default: the server working directory; ignored by the HTTP host, which boots once) |
| `dbUrl` | `string` | No | Optional dev database URL override (read-only diagnostics); prefer `SMRT_DEV_DB_URL` or `cli.database` config |
| `dbType` | `'sqlite' \| 'postgres' \| 'duckdb'` | No | Optional engine hint for `dbUrl` or the environment connection; inferred from the URL scheme when omitted |

## Runtime Diagnostics (Optional Live DB)

The six runtime-diagnostics tools above (`migration-status`, `job-health`,
`schedule-health`, `dispatch-health`, `recent-changes`, `registry-drift`) share
an **optional, read-only** dev-database connection so a development agent can
see runtime truth — not just what static artifacts declare. They complement the
static knowledge tools (#1819); together the two surfaces give the full
picture.

**Configuration.** Connection resolution, per call: an explicit `dbUrl`
argument, then the `SMRT_DEV_DB_URL` environment variable, then the project's
smrt config `cli.database` (`database.type` / `database.url`). An optional
`dbType` argument (`sqlite`, `postgres`, `duckdb`) overrides engine inference
for `dbUrl` or the environment connection; unknown values fail with a safe
diagnostic instead of opening the wrong adapter. No configuration
anywhere → every runtime tool returns a successful static-only result
(`provenance: 'static'`, `connected: false`) and the server starts and serves
all static tools unaffected.

Accepted URL forms: `file:///abs/dev.db`, `sqlite:///abs/dev.db`
(`sqlite:` is normalised to a `file:` URL; a relative `sqlite:` path resolves
against the server's working directory), a bare path, `postgres://…`, or
`duckdb:…`. `:memory:` is treated as not configured.

Older dev databases whose `_smrt_*` tables predate a column are still
answered: each reader selects only the columns that exist and reports the rest
in a `schema_behind` diagnostic (and `schemaBehind` on the data) rather than
failing the category. A read that does fail carries the redacted driver
message as its cause.

**Provenance labeling.** Live results carry `provenance: 'runtime (live DB)'`;
static-only results carry `provenance: 'static'`. Never conflate the two: the
manifest reports what the code declares, runtime tools report what the running
system is doing.

**Read-only, dev-only.** Every runtime statement is a bounded `SELECT` with an
explicit safe column projection. Sensitive columns (job payloads/results,
schedule `agentConfig`/`methodArgs`, dispatch `payload`/`metadata`) are never
selected. This is a dev/localhost diagnostic surface, not a data plane — it is
not `smrt-app-mcp` and never writes.

**Connection strings are never logged.** Surfaced URLs are redacted
(passwords and token query params masked); driver errors pass through a
redacting normalizer before they can appear in a diagnostic.

## Runtime Dev-Plane Host (HTTP, Level 2)

`smrt-dev-mcp --http [--port N] [--project DIR]` boots the confined runtime
once and serves a **positive, read-only** catalog over the stateless
Streamable HTTP transport (no SSE, no `Mcp-Session-Id`, no sticky routing):
`runtime-registry`, `runtime-object`, `runtime-schema-diff`, and the six
live-DB diagnostics above. The static stdio catalog is not mounted, and
generated CRUD, custom actions, `do()`, and tool-backed `is()` are never
exposed.

- Binds loopback only; the SDK's localhost Host and Origin validation runs on
  every request.
- Every request needs `Authorization: Bearer <token>`. Set
  `SMRT_DEV_MCP_TOKEN`, or let the process mint one and print it once to
  stderr. A supplied token is never echoed.
- No authenticated principal exists on this plane, so scope is fail-closed
  global-only exactly as for the stdio diagnostics.
- Per-request `projectPath` arguments are ignored: the booted project is fixed
  at start. Restart the process to observe a rebuilt manifest.

```bash
SMRT_DEV_MCP_TOKEN=dev-secret smrt-dev-mcp --http --port 3939 --project .
# → [smrt-dev-mcp] runtime dev-plane listening at http://127.0.0.1:3939/mcp
```

## MCP Resources And Prompts

Resources:

- `smrt://knowledge/project` — composed project knowledge index as JSON.
- `smrt://knowledge/package/{name}` — package-scoped knowledge as JSON.
- `smrt-dev-mcp://agent-skills/smrt-code-review` — portable review skill.

Prompts:

- `domain-code-review` — returns the review prompt bundle.
- `domain-architecture` — returns the architecture prompt bundle.
- `smrt-code-review` — returns the harness-agnostic review procedure.

## MCP Tier Context

- **Tier 1** (Runtime): auto-generated from `@smrt()` objects -- live data operations
- **Tier 2** (Development): this package -- code generation and project analysis
- **Tier 3** (Docs): framework documentation access; `smrt-docs-mcp` is no longer launched from this monorepo unless an external package/repo is installed and configured explicitly

## Dependencies

- `@modelcontextprotocol/server` -- MCP server protocol
- `@happyvertical/smrt-core` -- manifest and object registry
- `@happyvertical/smrt-types` -- shared domain knowledge contract

## License

MIT
