# SMRT Framework

<p align="center">
  <img src="./smrt-homer.png" alt="SMRT Framework" width="400" />
</p>

**A TypeScript framework for building vertical AI agents with automatic code generation, database persistence, and AI-powered operations.**

Define business logic as TypeScript classes with `@smrt()` -- get REST APIs, CLI tools, MCP servers, and AI operations (`is()`/`do()`) automatically.

## Quick Start

```bash
pnpm add @happyvertical/smrt-core
```

```typescript
import { SmrtObject, SmrtCollection, smrt, foreignKey } from '@happyvertical/smrt-core';

@smrt({
  api: true,   // Auto-generate REST API
  mcp: true,   // Auto-generate MCP tools for AI
  cli: true    // Auto-generate CLI commands
})
class Product extends SmrtObject {
  name: string = '';
  description: string = '';
  price: number = 0.0;      // DECIMAL (has decimal point)
  quantity: number = 0;      // INTEGER (no decimal point)
  active: boolean = true;
  tags: string[] = [];
  launchedAt: Date = new Date();
  categoryId = foreignKey(Category);

  async analyze() {
    return await this.do('Analyze this product and suggest improvements');
  }

  async isQuality() {
    return await this.is('Product has high quality description and competitive pricing');
  }
}

class ProductCollection extends SmrtCollection<Product> {
  static readonly _itemClass = Product;
}

const products = await ProductCollection.create({
  persistence: { type: 'sql', url: 'products.db' },
  ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
});

const product = await products.create({ name: 'Smart Widget', price: 29.99, quantity: 100 });
await product.save();

const isValid = await product.isQuality();
const analysis = await product.analyze();
```

## Features

- **AI-First Design**: Built-in `do()` and `is()` methods for intelligent operations
- **Automatic ORM**: Database schema generation from TypeScript classes
- **Code Generation**: Auto-generate CLIs, REST APIs, and MCP servers from `@smrt()` classes
- **Single Table Inheritance**: Multi-level STI with `_meta_data` JSONB for child fields
- **Type-Safe**: Full TypeScript support across all interfaces
- **0 vs 0.0 Heuristic**: `number = 0` becomes INTEGER, `number = 0.0` becomes DECIMAL

## Packages

All packages are published under `@happyvertical/smrt-*`. 39 packages total.

### Foundation

| Package | Description |
|---------|-------------|
| `smrt-core` | ORM (SmrtObject/SmrtCollection), `@smrt()` decorator, code generators (REST/CLI/MCP), DispatchBus, STI |
| `smrt-config` | cosmiconfig loader, secret sanitization, SSG export |
| `smrt-cli` | Developer CLI: `smrt db:*`, `smrt docs:agents`, `smrt dev:knowledge-*`, introspection, code generation |
| `smrt-types` | Shared TypeScript types/enums (zero runtime code except enums) |
| `smrt-vitest` | Vitest plugin: auto-manifest generation, cross-package class loading, DB isolation |
| `smrt-scanner` | OXC-based AST scanner for class/field metadata extraction |
| `smrt-tenancy` | Multi-tenancy: AsyncLocalStorage context, auto-filtering interceptors, adapters |

### Agents & Runtime

| Package | Description |
|---------|-------------|
| `smrt-agents` | Agent lifecycle, DispatchBus inter-agent messaging, interests-based discovery, scheduling |
| `smrt-jobs` | Background execution: TaskRunner, ScheduleRunner, fluent JobBuilder, `withBackgroundJobs()` |
| `smrt-users` | Auth/RBAC: 4-level permission cascade, hierarchical tenants, sessions, SvelteKit hooks |
| `smrt-profiles` | Identity: multi-auth (Nostr/OIDC/API keys/magic links), relationships, audit logging |

### Content & Media

| Package | Description |
|---------|-------------|
| `smrt-content` | STI content types (Article/Document/Mirror), thumbnails, asset associations |
| `smrt-messages` | Multi-channel messaging: Email/Slack/Twitter as STI hierarchy, credential encryption |
| `smrt-chat` | Chat rooms (public/private/DM/agent), threads, agent sessions with tool whitelisting |
| `smrt-assets` | Provider-agnostic asset management, versioning, polymorphic associations |
| `smrt-images` | Image ops: AI categorization, editing, cross-package STI extending Asset |
| `smrt-video` | Video production: Character/Performer/Scene, ComfyUI workflows, frame-based durations |
| `smrt-voice` | TTS voice profiles, cloning from samples, word timings for lip-sync |

### Business

| Package | Description |
|---------|-------------|
| `smrt-commerce` | Customer/Vendor, Contract (5 STI types), Invoice with ledger integration, Fulfillment |
| `smrt-products` | Product catalog -- reference template for triple-consumption (npm/federation/standalone) |
| `smrt-ads` | Ad delivery: priority waterfall, weighted A/B variations, immutable event tracking |
| `smrt-affiliates` | Revenue sharing: multi-type partners, multi-tier commissions, payout processing |
| `smrt-ledgers` | Double-entry accounting, balance enforcement (EPSILON=0.01), journal lifecycle |
| `smrt-analytics` | GA4/Plausible: properties, data streams, server-side events, AI-powered reports |
| `smrt-subscriptions` | Tenant subscription plans, feature grants, usage thresholds, and entitlement resolution |

### Domain

| Package | Description |
|---------|-------------|
| `smrt-events` | Infinite-nesting event hierarchy, series, participant roles/placements |
| `smrt-places` | Hierarchical places, geocoding via `lookupOrCreate()`, Haversine proximity search |
| `smrt-facts` | Knowledge base: semantic dedup, evolution chains, confidence scoring |
| `smrt-sites` | Site lifecycle management, agent bindings with priority ordering |
| `smrt-properties` | Digital properties with hierarchical zones for content/ad placement |
| `smrt-tags` | Hierarchical tagging: context-scoped slugs, multi-language aliases |
| `smrt-social` | Social media OAuth (YouTube/Threads/X/Bluesky), post scheduling |
| `smrt-secrets` | Envelope encryption (AMK/TDEK/secret), key rotation, audit logging |
| `smrt-projects` | Provider-agnostic project management (Issues, PRs, Repositories) |

### Tooling

| Package | Description |
|---------|-------------|
| `smrt-svelte` | Svelte 5: components, browser AI (STT/TTS/LLM) with warm cache, theme system |
| `smrt-dev-mcp` | Dev MCP server: code generation, project introspection, knowledge reflection, review/architecture context, and bundled agent skills |
| `smrt-gnode` | Federation library (stubs only, not implemented) |
| `smrt-template-sveltekit` | Base SvelteKit scaffold with SMRT integration |
| `smrt-template-site-static-json` | Community news site scaffold with Praeco/Caelus |

### SDK Dependencies (`@happyvertical/*`)

External dependencies from the [HappyVertical SDK](https://github.com/happyvertical/sdk):

- `@happyvertical/ai` -- Multi-provider AI client
- `@happyvertical/sql` -- Database operations (SQLite, Postgres, DuckDB)
- `@happyvertical/files` -- File system operations
- `@happyvertical/utils` -- Shared utility functions
- `@happyvertical/logger` -- Logging infrastructure

## Development

```bash
pnpm install && npm run build   # Setup (~8s first build, ~80ms cached via turborepo)
npm run dev                     # Watch mode
npm test                        # Vitest (smrtVitestPlugin() required in config)
npm run typecheck               # TypeScript checking
npm run lint                    # Biome
npm run format                  # Biome
```

### Local SDK Development

```bash
./setup-local-dev.sh            # Link local SDK packages for development
./restore-published-deps.sh     # Restore published SDK packages from registry
```

Requires: `git clone git@github.com:happyvertical/sdk.git ../sdk` (or set `SDK_PATH`).

### Git Hooks

Uses [Lefthook](https://lefthook.dev/) for local deterministic checks:

- pre-commit formats staged JS/TS/Svelte files, rejects known forbidden artifacts, validates staged workflow YAML, and runs `pnpm knowledge:check --changed --strict --format markdown`.
- pre-push runs full knowledge freshness, full Biome CI formatting, and workflow validation.
- model-assisted knowledge audits are local/manual: use `smrt-dev-mcp` prompt bundles or bundled skills with Codex, Claude, or another model, then re-run `pnpm knowledge:check --strict --format markdown`.
- commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <subject>
```

Valid types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

## Requirements

- Node.js 24+
- pnpm 9.0+
- TypeScript 5.7+

## Documentation

- [UI Surfaces](./docs/ui-surfaces.md) -- when to use `./svelte`, `./playground`, and optional `./routes`
- [Architecture Guide](./AGENTS.md) -- Development guide and patterns
- [Core Framework Docs](./packages/core/AGENTS.md) -- Detailed framework documentation
- [API Reference](./packages/core/README.md) -- Complete API reference

## UI Surface Conventions

SMRT packages can expose UI at three levels:

- `./svelte` for reusable components
- `./playground` for preview metadata consumed by `smrt playground`
- package-local page shells under `src/svelte/routes` and `src/routes` when needed for package dev

For this release, the public UI package standard is `./svelte` plus `./playground`. We are not standardizing a public `./routes` export until downstream apps demonstrate a clear need for reusable package-owned page contracts.

## Related Projects

- [HappyVertical SDK](https://github.com/happyvertical/sdk) -- Infrastructure packages
- [create-gnode](https://github.com/happyvertical/create-gnode) -- Generate local knowledge bases
- [praeco](https://github.com/happyvertical/praeco) -- Local news agent

## License

MIT -- see [LICENSE](./LICENSE) file for details.
