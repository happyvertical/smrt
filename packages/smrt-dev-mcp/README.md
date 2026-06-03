# @happyvertical/smrt-dev-mcp

Development MCP server for the SMRT framework providing code generation,
project introspection, deterministic ecosystem knowledge, and portable review
or architecture prompt bundles.

## Installation

```bash
pnpm install @happyvertical/smrt-dev-mcp
```

## Usage

Add to your `.mcp.json`, Codex MCP config, or Claude Desktop config:

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

Set `DEBUG=true` in the environment to enable diagnostic logging.

## Knowledge Boundary

`smrt-dev-mcp` is model-agnostic. Its review and architecture tools do not call
Codex, Claude, or any other model provider directly. They return deterministic
findings plus a reusable prompt bundle that can be sent to the local model plan
or provider of your choice.

After using a model to update package docs or expertise, always run the
deterministic checker again:

```bash
pnpm knowledge:check --strict --format markdown
```

Use `--format json` when another script needs machine-readable output.

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
| `properties` | `array` | Yes | Property definitions (`name`, `type`, `required?`, `description?`) |
| `baseClass` | `string` | No | `'SmrtObject'` (default) or `'SmrtCollection'` |
| `includeApiConfig` | `boolean` | No | Include REST API config (default: true) |
| `includeMcpConfig` | `boolean` | No | Include MCP config (default: true) |
| `includeCliConfig` | `boolean` | No | Include CLI config (default: true) |

Supported property types: `text`, `integer`, `decimal`, `boolean`, `datetime`, `json`.

### `introspect-project`

Scan a project directory for SMRT objects and return a class/field/relationship report.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `directory` | `string` | No | Project directory (default: cwd) |
| `includeFields` | `boolean` | No | Include field details |
| `includeRelationships` | `boolean` | No | Analyze relationships |

### `reflect-knowledge`

Return package coverage, SDK package coverage, relationship-v2 counts, and
freshness status from the deterministic SMRT + HappyVertical SDK knowledge
index.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |

### `check-knowledge-freshness`

Run the same deterministic freshness checks exposed by `pnpm knowledge:check`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |
| `changed` | `boolean` | No | Limit stale-pattern checks to changed files |
| `strict` | `boolean` | No | Treat stale-pattern findings as errors |

### `build-review-context`

Select relevant SMRT and HappyVertical SDK package expertise for changed files,
then return a model-ready prompt bundle.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rootDir` | `string` | No | Project root directory (default: cwd) |
| `changedFiles` | `string[]` | No | Files to route to package experts |
| `focus` | `string` | No | Review focus or concern |
| `documentation` | `string` | No | Additional docs or notes to include |

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

## MCP Tier Context

- **Tier 1** (Runtime): auto-generated from `@smrt()` objects -- live data operations
- **Tier 2** (Development): this package -- code generation and project analysis
- **Tier 3** (Docs): `smrt-docs-mcp` -- framework documentation access

## Dependencies

- `@modelcontextprotocol/sdk` -- MCP server protocol
- `@happyvertical/smrt-core` -- manifest and object registry

## License

MIT
