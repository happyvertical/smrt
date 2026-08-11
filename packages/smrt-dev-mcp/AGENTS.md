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

`pnpm knowledge:check --strict --format markdown` compares this catalog and the
README parameter tables to the exported `TOOLS` definitions. Add or change a
tool schema and its authored documentation in the same commit.

## Knowledge Discovery (#2143)

Discovery reads the workspace globs instead of assuming `<root>/packages`:
`pnpm-workspace.yaml` `packages:` (literals, `dir/*`, `**`, `!` negations), then
`package.json#workspaces`, then a `packages/*` fallback. `findProjectRoot` looks
for a workspace declaration only — requiring a literal `packages/` directory is
what mis-rooted every `apps/*` product. The workspace root is indexed whenever it
has a `package.json`, which is how single-package repos resolve; it is scanned
with the member package directories excluded so it can own objects without
absorbing theirs.

Workspace globs are a filesystem trust boundary. Absolute paths and `..`
segments are rejected, and every matched directory is realpath-confined to the
workspace root before its manifest is read. All positive globs share a 10,000
directory-entry traversal budget; exceeding it is a fatal diagnostic that
returns no partially discovered package set. This cardinality limit preserves
valid deeply nested `**` workspaces without allowing repeated globstars to
amplify into unbounded filesystem work. Discovery also stops before package
reads when more than 512 packages match, revalidates confinement immediately
before reading each package, and runs at most eight scanner fallbacks at once.

### Consumer apps (#2275)

An app that installs the published packages authors none of them, so workspace
discovery alone sees nothing. Every installed `@happyvertical/smrt-*` package,
plus the known SDK packages, is resolved from the project's and each workspace
package's `node_modules/@happyvertical` scope directory and marked
`isInstalledDependency`. This is an enumeration, not a walk: pnpm materializes
a store whose entries link back out to their siblings, so a descent reads the
same package once per path that reaches it. Real paths deduplicate the result;
each package is still read through its `node_modules` path, because a realpath
escapes the root wherever an ancestor is a symlink. A workspace package linked
into a sibling's `node_modules` is authored source and is never marked
installed.

- `--scope installed` reports exactly those packages. `local` and `package`
  exclude them; `project` includes them; the index also lists them separately
  as `installedPackages` (`schemaVersion: 3`). It is a reporting scope:
  `dev:knowledge-check` has no authored packages to gate under it.
- Each package carries `agentDocSha256`, the hash of its shipped `AGENTS.md`.
  That is the drift signal a consumer diffs against a recorded baseline — a
  version bump is not, because most releases do not touch a documented surface.
- The freshness gate skips installed packages entirely: indexed, never checked.
  A consumer cannot add an `AGENTS.md` to a dependency, and a published
  package's artifact hashes cannot match its republished sources.
- Coverage and the `no-smrt-objects-discovered` guard count authored packages
  only. Dependencies ship their own objects, so counting them would make that
  guard unreachable in exactly the projects most likely to have broken
  discovery. A project whose own packages contribute nothing while its
  dependencies do gets the `no-authored-smrt-objects` warning instead.

Per package, objects resolve in this order, and the winner is recorded in
`objectSource` with a reason:

1. `domain-artifact` — `.smrt/`, `dist/`, or `src/manifest/smrt-knowledge.json`
2. `manifest` — package-local manifest, after ownership validation
3. `scanner` — `OxcScanner` + `ManifestAdapter` over the package's sources
4. `none` — with a machine-readable reason

The index exposes `coverage` and `diagnostics` (added in `schemaVersion: 2`). Zero
discovered objects is an **error-grade** diagnostic that names the roots and
artifact paths checked plus the fix, and it propagates into
`smrt-architecture`/`smrt-review`/`reflect-*` results and prompt bundles.

A workspace-root package has an empty `relativeDirectory`, so package paths are
built with `packageRelativePath`/`packageDocPaths` rather than interpolation —
otherwise emitted docs read `/AGENTS.md` and changed-file matching compares
against a leading `/` and selects nothing. The root owns any changed path no
member package owns, mirroring the member-excluded scan.

## Agent Skills

Bundled skills live under `skills/`, the Agent Plugins fixed discovery
location. They are plain Markdown procedures
with YAML frontmatter (`name` and `description`) and harness-neutral body text.
Skill-aware harnesses can parse the frontmatter; other harnesses can ignore it.

- `skills/smrt-code-review/SKILL.md` — downstream SMRT code review workflow.
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
- `plugin.json` / `mcp.json` — Agent Plugins 1.0.0 portable root manifests
- `skills/smrt-code-review/SKILL.md` — downstream SMRT review procedure
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
- **Portable plugin boundary**: `mcp.json` launches only `./dist/index.js` from
  the plugin root. Paths must remain contained after resolution. Clients, not
  the package, provide the reserved `PLUGIN_ROOT` and `PLUGIN_DATA` environment
  variables and manage OAuth or all other credentials; do not add secret-bearing
  environment variables or headers to portable config.
- **Working Draft compatibility**: Agent Plugins 1.0.0 remains a Working Draft.
  Keep `plugin.json` and `mcp.json` pinned to the canonical 1.0.0 schema IDs,
  validate against the packaged `schemas/agent-plugins-1.0.0/` snapshots
  offline, and do not add streamable HTTP until #2147 provides the endpoint.
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
  detect. `summarizeRelationshipsV2` therefore collapses a shared
  `className::tableName` **only across a dependency edge** (a package can only
  restate its own dependencies' objects) and reports
  `duplicate-object-identity`. Two unrelated packages that happen to share a
  class and table name — `Account::accounts` exists in both smrt-messages and
  smrt-ledgers — are distinct objects and both keep contributing.
  - Grouping is by **connected component**, not a greedy pairwise match: two
    independent consumers restating one shared dependency have no edge to each
    other, so a greedy pass would keep both and double-count.
  - The surviving copy is the one the others **depend on**, since ownership
    follows the dependency direction. Provenance is not a sufficient signal —
    preferring a `scanner` copy kept `smrt-support`'s compatibility subtype over
    the canonical `smrt-projects` model and changed the facts.
- **Budgets are enforced at the transport boundary**: `KnowledgePackage` carries
  the full `agentDoc` and domain manifest, so the MCP handlers project a compact
  package record unless `detail: 'full'`. Library callers (the CLI) still receive
  the full objects.
- **Private packages skip packaging checks**: the `files` allowlist governs npm
  publication, so `private: true` packages are exempt; authored docs are still
  required. A workspace root is exempt from both — but **only when member
  packages exist**. In a single-package repo the root is the published package,
  so exempting every root would make the freshness gate a no-op for exactly the
  layout #2143 added support for.
- **Nested workspace members own no canonical docs**: instruction chains are
  additive, so a package nested inside another workspace package (
  `packages/smrt-playground/host`) must not carry `AGENTS.md`/`CLAUDE.md` — an
  agent would load the parent's and its own. Those two checks are skipped for it
  and a `nested-agents-md` error fires if one reappears; the expertise belongs in
  the parent's linked `agents/<module>.md`.
- **`maxChars` budgets the objects payload, not the whole response**: project
  metadata and diagnostics are always returned in full, because a diagnostic is
  how discovery reports that it found nothing (#2143). Budgeting it away would
  hide the failure the caller needs to see.
- **Coverage and diagnostics are computed before scope filtering**: they answer
  "did discovery work", which is a whole-workspace property. Deriving them from
  the scoped subset made `scope: 'sdk'` report a false discovery failure.
