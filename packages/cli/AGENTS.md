# @happyvertical/smrt-cli

Developer CLI with lazy-loaded commands, manifest discovery, and class introspection.

## Commands

```
smrt introspect              # Discover SMRT objects in project
smrt doctor                  # Umbrella diagnostics; can verify a generation snapshot
smrt db:status               # Pending schema changes + failed migration classification
smrt db:migrate              # Apply migrations
smrt db:migrate --force-migration <exact-id> [--force-migration <exact-id>...] # Force exact generated migrations in one atomic batch
smrt db:migrate-uuid         # Convert schema-declared UUID text columns after data remap
smrt db:diff                 # Show schema differences without generating migration files
smrt db:rollback             # Rollback migrations
smrt docs:agents             # Generate .agents/smrt-framework.md
smrt docs:claude             # Deprecated alias writing .claude/smrt-framework.md
smrt dev:knowledge-*         # Deterministic agent knowledge index/check/diff
smrt dev:knowledge-index --scope installed # Installed @happyvertical/* deps, versions, AGENTS.md hashes
smrt knowledge:review-context --scope package --package <name>
smrt knowledge:architecture-context --scope project|local|package|sdk|installed
smrt dev:knowledge-check --format markdown|json
smrt generate-mcp            # Generate MCP server (aliases: generate-mcp-server, mcp)
smrt generate-types          # Generate TypeScript declarations (alias: generate-declarations)
smrt generate-routes         # Generate SvelteKit API routes (aliases: routes, generate:routes)
smrt config:export           # Export agent config for SSG
smrt init                    # Init new project
smrt gnode                   # Scaffold gnode site
smrt dispatch:*              # Dispatch management (list/process/retry/cleanup)
```

File-backed SQL/TypeScript migration generation is not supported. SMRT schema
migrations are manifest-driven through registered objects and project manifests.

`smrt test` is **deprecated** — use vitest plugin directly.

## Architecture

- **Lazy command loading**: commands loaded on-demand via dynamic import (~100ms overhead on first use)
- **Manifest discovery**: auto-finds `.smrt/manifest.json` + scans `node_modules/@happyvertical/smrt-*`
- **Aggregate manifest identity**: preload and schema discovery resolve package ownership per entry (`definition.packageName` before the container), so dependency objects retain their qualified registrations
- **Class loading order**: config.entryPoint → package.json exports['.'] → package.json main → `./dist/index.js`
- **Object method exposure**: custom methods on SMRT objects auto-become CLI commands

## Key Files

- `src/cli-generator.ts` — core dispatcher, lazy command loading, class loading
- `src/commands/` — individual command implementations
- `src/loaders/` — class-loader, local-loader, npm-loader, git-loader, template-loader
- `src/discovery/manifest-discovery.ts` — manifest auto-discovery
- `src/commands/docs-claude.ts` — downstream AGENTS.md generation plus Claude compatibility alias

## Gotchas

- **Test mode detection**: checks `NODE_ENV=test`, `VITEST=true`, `global.it`/`describe` — could conflict with other test runners
- **External package load failures silenced**: one package failing doesn't prevent others from loading
- **Generation command names are hyphenated**: `generate-mcp` and `generate-types` have
  no colon alias. Only `generate-routes` and `generate-register` declare one, so
  `smrt generate:mcp` is an unknown command (#2279).
- **Subcommand `--version` beats the global flag**: `parseCliArgs` in
  `@happyvertical/utils` dispatches to the built-in `version` command for a
  `--version` token anywhere in argv. `parseCliCommandArgs` rescopes that token to
  the named subcommand (`smrt generate-mcp --version 0.1.0`) and only leaves it
  global when it appears before or without a subcommand (#2279). `--help` is
  deliberately untouched.
- **Schema history nuance**: `db:status` / `db:history` should distinguish active live drift from superseded failed generated schema repairs instead of treating all failed rows as current blockers
