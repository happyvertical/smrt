# @happyvertical/smrt-cli

Developer CLI for the SMRT framework. Provides introspection, testing, schema management, code generation, and project utilities.

## Architecture

```
src/
  index.ts              # Entry point (shebang, main runner)
  cli-generator.ts      # Core command dispatcher with lazy-loading
  commands/             # 15+ command modules
    config-export.ts    # Export configuration
    db-*.ts             # Database commands (diff, generate, rollback, status, history)
    dispatch.ts         # Method dispatch for custom commands
    docs-claude.ts      # Claude documentation generation
    export.ts           # Data export
    generate.ts         # Code generation (MCP)
    git.ts              # Git merge driver integration
    gnode.ts            # Gnode scaffolding
    init.ts             # Project initialization
    utilities.ts        # Utility commands
  loaders/              # Manifest discovery
    class-loader.ts     # Load SMRT classes
    local-loader.ts     # Load local manifests
    npm-loader.ts       # Load npm manifests
    git-loader.ts       # Git integration
    template-loader.ts  # Template loading
  discovery/            # Manifest discovery utilities
  utils/                # Generator utilities
```

## Key Commands

| Command | Purpose |
|---------|---------|
| `smrt introspect` | Discover all SMRT objects in project |
| `smrt test` | Run tests with manifest generation (deprecated — use vitest plugin) |
| `smrt db:status` | Check pending schema changes |
| `smrt db:migrate` | Apply database migrations |
| `smrt db:diff --generate` | Generate migration from changes |
| `smrt db:rollback` | Rollback migrations |
| `smrt docs:claude` | Generate `.claude/smrt-framework.md` from installed packages |
| `smrt generate:mcp` | Generate MCP server from SMRT objects |
| `smrt init` | Initialize a new SMRT project |
| `smrt gnode` | Scaffold a new gnode |

## Key Exports

- `CLIGenerator` — Core command dispatcher
- `main` — CLI entry point function

## Patterns

- Commands are lazy-loaded to minimize startup time and avoid pulling in heavy dependencies (e.g., `tar`)
- Auto-discovers SMRT manifests in both local project and `node_modules`
- Custom methods on SMRT objects are automatically exposed as CLI commands
- Git merge driver provides JSON-aware conflict resolution

## Testing

```bash
npx vitest run --project cli
```

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-config`, `@happyvertical/smrt-types`
- `@happyvertical/ai`, `@happyvertical/files`, `@happyvertical/sql`, `@happyvertical/utils`, `@happyvertical/logger`
- `fast-glob`, `tar`
