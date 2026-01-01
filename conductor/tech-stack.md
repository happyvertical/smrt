# Tech Stack - SMRT Framework

## Core Technologies
- **Language**: TypeScript (Node.js 24+)
- **Package Manager**: pnpm (9.0+)
- **Monorepo Management**: Turbo

## Development Tools
- **Build System**: Vite, vite-plugin-dts
- **Linting & Formatting**: Biome (2.2.4)
- **Testing**: Vitest, Playwright

## Framework Infrastructure
- **ORM & Persistence**: Custom TypeScript-first ORM with support for SQL (SQLite, PostgreSQL, DuckDB) via `@have/sql`.
- **AI Integration**: Multi-provider client (OpenAI, Anthropic, Google, AWS) via `@have/ai`.
- **Interfaces**: Automated generation for CLI, REST API (Express), and MCP servers.
- **Workflow Tools**: Lefthook (git hooks), Changesets (versioning), Commitlint.
