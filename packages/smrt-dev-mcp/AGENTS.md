# @happyvertical/smrt-dev-mcp

Tier 2 MCP server for development — code generation, project introspection,
deterministic SMRT ecosystem knowledge, and portable agent workflows.

## Tools

| Tool | Purpose |
|------|---------|
| `generate-smrt-class` | Generates `@smrt()` class with fields, decorator config, imports |
| `introspect-project` | Scans project directory for SMRT objects; compact summary by default, `detail: 'full'` for field/schema/method detail |
| `review-smrt-project` | Advisory downstream ecosystem alignment review for dependencies, storage, app shell, auth/tenancy, and manifest generation |
| `reflect-knowledge` | Reports deterministic SMRT + HappyVertical SDK knowledge coverage and freshness |
| `reflect-domain-knowledge` | Reports downstream/domain artifact coverage and freshness |
| `check-knowledge-freshness` | Runs deterministic agent-doc and stale-reference checks |
| `check-domain-knowledge` | Alias for deterministic domain artifact freshness checks |
| `build-review-context` | Builds model-ready SMRT review context and package expert routing |
| `build-domain-review-context` | Domain-scoped review context builder with `scope`/`package` filters |
| `smrt-review` | Returns deterministic review findings and a reusable review prompt bundle |
| `build-architecture-context` | Builds architecture planning context from an idea or docs |
| `build-domain-architecture-context` | Domain-scoped architecture context builder with `scope`/`package` filters |
| `smrt-architecture` | Recommends SMRT/SDK packages, object-model sketch, risks, and questions |
| `list-agent-skills` | Lists bundled harness-agnostic agent skills |
| `get-agent-skill` | Returns a bundled agent skill as Markdown plus optional references |

## Knowledge Discovery (#2143)

Discovery reads the workspace globs instead of assuming `<root>/packages`:
`pnpm-workspace.yaml` `packages:` (literals, `dir/*`, `**`, `!` negations), then
`package.json#workspaces`, then a `packages/*` fallback. `findProjectRoot` looks
for a workspace declaration only — requiring a literal `packages/` directory is
what mis-rooted every `apps/*` product. The workspace root is indexed whenever it
has a `package.json`, which is how single-package repos resolve.

Per package, objects resolve in this order, and the winner is recorded in
`objectSource` with a reason:

1. `domain-artifact` — `.smrt/`, `dist/`, or `src/manifest/smrt-knowledge.json`
2. `manifest` — package-local manifest, after ownership validation
3. `scanner` — `OxcScanner` + `ManifestAdapter` over the package's sources
4. `none` — with a machine-readable reason

The index exposes `coverage` and `diagnostics` (`schemaVersion: 2`). Zero
discovered objects is an **error-grade** diagnostic that names the roots and
artifact paths checked plus the fix, and it propagates into
`smrt-architecture`/`smrt-review`/`reflect-*` results and prompt bundles.

## Agent Skills

Bundled skills live under `agent-skills/`. They are plain Markdown procedures
with YAML frontmatter (`name` and `description`) and harness-neutral body text.
Skill-aware harnesses can parse the frontmatter; other harnesses can ignore it.

- `agent-skills/smrt-code-review/SKILL.md` — downstream SMRT code review workflow.
  Agents should fetch it with `get-agent-skill`, then call `smrt-review` for
  deterministic context, inspect the actual diff, and produce a findings-first
  review.

## Usage

```jsonc
// .mcp.json or Claude Desktop config
{ "mcpServers": { "smrt-dev-mcp": { "command": "npx", "args": ["-y", "@happyvertical/smrt-dev-mcp"] } } }
```

For global MCP client config, do not use `pnpm exec smrt-dev-mcp` unless the MCP
server is always launched from a repo that installs the package. Prefer an
absolute `node /path/to/node_modules/@happyvertical/smrt-dev-mcp/dist/index.js`
launcher or a small wrapper script with an absolute Node path.

## MCP Tier Context

- **Tier 1** (Runtime): auto-generated from `@smrt()` objects — live data operations
- **Tier 2** (Development): this package — code generation and project analysis
- **Tier 3** (Docs): framework documentation access; `smrt-docs-mcp` is no longer launched from this monorepo unless an external package/repo is installed and configured explicitly

## Key Files

- `src/index.ts` — MCP server setup, tool registration
- `src/knowledge/index.ts` — deterministic SMRT, SDK, and downstream domain knowledge discovery; workspace-glob expansion, provenance, coverage, and diagnostics
- `src/agent-skills.ts` — bundled skill registry and file loader
- `agent-skills/smrt-code-review/SKILL.md` — downstream SMRT review procedure
- `src/tools/generate-smrt-class.ts` — class generation logic and package-ready templates
- `src/tools/introspect-project.ts` — manifest-first project scanning, falling back to `@happyvertical/smrt-scanner`
- `src/tools/review-smrt-project.ts` — advisory ecosystem-alignment checks for downstream projects

## Gotchas

- **Read-only**: never writes files or executes generated code
- **Model-agnostic**: review and architecture tools return deterministic
  findings/context and prompt bundles; they do not call model providers
- **Domain artifacts first**: discovery must prefer `.smrt/smrt-knowledge.json`,
  then `dist/smrt-knowledge.json`, then source artifacts before raw manifest
  fallback
- **Skill loading**: bundled skills must be included in `package.json` `files`
  because runtime reads them from the installed package directory
- **Field type mapping**: `text`, `integer`, `decimal`, `boolean`, `datetime`, `json` — maps to SMRT field helpers (but prefer TypeScript defaults per framework convention)
- **Never call `ManifestGenerator` from a tool path**: `generateSchemas` and
  friends write progress lines to **stdout** through the SDK logger, which is the
  MCP server's JSON-RPC channel. Suppressing `console.log` is not enough. The
  knowledge scanner fallback therefore skips schema enrichment, so
  scanner-provenance packages carry no `columnType` and contribute 0 to the
  `uuidColumns` fact — `objectSource` makes that visible.
- **Aggregate manifests poison relationship facts**: a runtime
  `.smrt/manifest.json` frequently registers a package's dependencies too.
  Objects whose `packageName`/`qualifiedName` disagree with the owning package are
  rejected with a diagnostic. A *consuming* package's artifact can also
  re-qualify its dependency's objects under its own name, which prefixes cannot
  detect, so `summarizeRelationshipsV2` counts each `className::tableName` once
  and reports `duplicate-object-identity`.
- **Budgets are enforced at the transport boundary**: `KnowledgePackage` carries
  the full `agentDoc` and domain manifest, so the MCP handlers project a compact
  package record unless `detail: 'full'`. Library callers (the CLI) still receive
  the full objects.
- **Private packages skip packaging checks**: the `files` allowlist governs npm
  publication, so `private: true` packages are exempt; authored docs are still
  required. The workspace root is exempt from both.
