# @happyvertical/smrt-dev-mcp

Development MCP server for the SMRT framework providing code generation,
project introspection, deterministic ecosystem knowledge, and portable review
or architecture prompt bundles.

## Installation

```bash
pnpm install @happyvertical/smrt-dev-mcp
```

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

## Knowledge Boundary

`smrt-dev-mcp` is model-agnostic. Its review and architecture tools do not call
Codex, Claude, or any other model provider directly. They return deterministic
findings plus a reusable prompt bundle that can be sent to the local model plan
or provider of your choice.

Downstream SMRT packages/apps can publish their own scoped
`smrt-knowledge.json` artifact. Discovery prefers local
`.smrt/smrt-knowledge.json`, then `dist/smrt-knowledge.json`, then source
manifest artifacts before falling back to raw manifest/doc scanning. The runtime
`manifest.json` stays focused on object registration; `smrt-knowledge.json` is
the agent/developer contract.

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

The package ships harness-agnostic agent skills under `agent-skills/`.

Downstream agents should fetch the review procedure before starting a formal
SMRT review:

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

Generate a complete SMRT class with `@smrt()` decorator, fields, and imports.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `className` | `string` | Yes | Class name (PascalCase) |
| `properties` | `array` | Yes | Property definitions (`name`, `type`, `required?`, `nullable?`, `description?`, `defaultValue?`) |
| `baseClass` | `string` | No | `'SmrtObject'` (default) or `'SmrtCollection'` |
| `template` | `string` | No | `basic`, `global-catalog`, `optional-catalog`, `tenant-project-object`, `tenant-event-log-object`, or `cross-package-reference` |
| `tableName` | `string` | No | Explicit `@smrt({ tableName })` value |
| `conflictColumns` | `string[]` | No | Explicit upsert natural key columns |
| `tenantScoped` | `boolean/object` | No | Add `@TenantScoped(...)`; object supports `mode`, `field`, and bypass/filter options |
| `includeTenantIdField` | `boolean` | No | Emit a matching `@tenantId()` field |
| `relationships` | `array` | No | Relationship definitions for `foreignKey`, `crossPackageRef`, `oneToMany`, or `manyToMany` |
| `includeCompanionSnippets` | `boolean` | No | Append package wiring notes |
| `includeApiConfig` | `boolean` | No | Include REST API config (default: true) |
| `includeMcpConfig` | `boolean` | No | Include MCP config (default: true) |
| `includeCliConfig` | `boolean` | No | Include CLI config (default: true) |

Supported property types: `text`, `integer`, `decimal`, `boolean`, `datetime`, `json`.

### `introspect-project`

Scan a project directory for SMRT objects and return a manifest-equivalent
class/field/relationship report. Discovery prefers `.smrt/manifest.json`, then
`dist/manifest.json`, then `src/manifest/manifest.json`; when no artifact is
available it falls back to `@happyvertical/smrt-scanner`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `directory` | `string` | No | Project directory (default: cwd) |
| `manifestPath` | `string` | No | Explicit manifest artifact path |
| `includeFields` | `boolean` | No | Include field details |
| `includeRelationships` | `boolean` | No | Analyze relationships |
| `includeMethods` | `boolean` | No | Include public method details |

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
freshness status from the deterministic SMRT + HappyVertical SDK knowledge
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
| `scope` | `string` | No | `project`, `local`, `package`, or `sdk` |
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
| `scope` | `string` | No | `project`, `local`, `package`, or `sdk` |
| `package` | `string` | No | Package name or short name to focus |

### `build-review-context`

Select relevant SMRT and HappyVertical SDK package expertise for changed files,
then return a model-ready prompt bundle.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |
| `changedFiles` | `string[]` | No | Files to route to package experts |
| `focus` | `string` | No | Review focus or concern |
| `documentation` | `string` | No | Additional docs or notes to include |

### `build-domain-review-context`

Domain-scoped alias for `build-review-context`. Accepts the same fields plus
`scope` and `package`.

### `smrt-review`

Return deterministic review findings, a prompt bundle, or both.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |
| `changedFiles` | `string[]` | No | Files to route to package experts |
| `focus` | `string` | No | Review focus or concern |
| `documentation` | `string` | No | Additional docs or notes to include |
| `mode` | `string` | No | `findings`, `prompt-bundle`, or `both` |

### `build-architecture-context`

Select relevant SMRT and SDK package expertise for an idea or documentation,
then return a model-ready architecture prompt bundle.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |
| `idea` | `string` | No | Product or implementation idea |
| `documentation` | `string` | No | Existing docs or requirements |
| `focus` | `string` | No | Architecture concern to prioritize |

### `build-domain-architecture-context`

Domain-scoped alias for `build-architecture-context`. Accepts the same fields
plus `scope` and `package`.

### `smrt-architecture`

Return package recommendations, SDK recommendations, an object-model sketch,
risks, questions, and the reusable architecture prompt bundle.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |
| `idea` | `string` | No | Product or implementation idea |
| `documentation` | `string` | No | Existing docs or requirements |
| `focus` | `string` | No | Architecture concern to prioritize |

### `list-agent-skills`

List bundled harness-agnostic agent skills.
No parameters.

### `get-agent-skill`

Return a bundled agent skill as Markdown, with optional referenced files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | Yes | Skill name. Currently `smrt-code-review` |
| `includeReferences` | `boolean` | No | Include referenced files (default: true) |

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

- `@modelcontextprotocol/sdk` -- MCP server protocol
- `@happyvertical/smrt-core` -- manifest and object registry
- `@happyvertical/smrt-types` -- shared domain knowledge contract

## License

MIT
