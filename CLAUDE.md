# SMRT Framework

TypeScript framework for vertical AI agents. Define business logic as TypeScript classes with `@smrt()` — get REST APIs, CLI tools, MCP servers, and AI operations (`is()`/`do()`) automatically.

## Monorepo Packages

All `@happyvertical/smrt-*` packages are version-locked via changesets. pnpm workspace.

### Foundation
| Package | Purpose |
|---------|---------|
| core | ORM (SmrtObject/SmrtCollection), `@smrt()` decorator, code generators (REST/CLI/MCP), DispatchBus, STI |
| config | cosmiconfig loader, secret sanitization, SSG export |
| cli | Developer CLI: `smrt db:*`, `smrt docs:claude`, introspection, code generation |
| types | Shared TypeScript types/enums — zero runtime code |
| vitest | Test plugin: auto-manifest generation, cross-package class loading, DB isolation |
| scanner | oxc-parser AST scanner for class/field metadata extraction |
| tenancy | Multi-tenancy: AsyncLocalStorage context, auto-filtering interceptors, adapters |

### Agents & Runtime
| Package | Purpose |
|---------|---------|
| agents | Agent lifecycle, DispatchBus inter-agent messaging, interests-based discovery, scheduling |
| jobs | Background execution: TaskRunner, ScheduleRunner, fluent JobBuilder, `withBackgroundJobs()` |
| users | Auth/RBAC: 4-level permission cascade, hierarchical tenants, sessions, SvelteKit hooks |
| profiles | Identity: multi-auth (Nostr/OIDC/API keys/magic links), relationships, audit logging |

### Content & Media
| Package | Purpose |
|---------|---------|
| content | STI content types (Article/Document/Mirror), thumbnails (3 strategies), content-owned asset joins via `content_assets` |
| messages | Multi-channel messaging: Email/Twitter/Slack as STI hierarchy, credential encryption |
| chat | Chat rooms (public/private/DM/agent), threads, agent sessions with tool whitelisting |
| assets | Provider-agnostic asset management, versioning, generic/provenance `AssetAssociation` links |
| images | Image ops: AI categorization, editing, cross-package STI extending Asset |
| video | Video production: Character/Performer/Scene, ComfyUI workflows, frame-based durations |
| voice | TTS voice profiles, cloning from samples, word timings for lip-sync |

### Business
| Package | Purpose |
|---------|---------|
| commerce | Customer/Vendor, Contract (5 STI types), Invoice with ledger integration, Fulfillment |
| products | Product catalog — reference template for triple-consumption (npm/federation/standalone) |
| ads | Ad delivery: priority waterfall, weighted A/B variations, immutable event tracking |
| affiliates | Revenue sharing: multi-type partners, multi-tier commissions, payout processing |
| ledgers | Double-entry accounting, balance enforcement (EPSILON=0.01), journal lifecycle |
| analytics | GA4/Plausible: properties, data streams, server-side events, AI-powered reports |

### Domain
| Package | Purpose |
|---------|---------|
| events | Infinite-nesting event hierarchy, series, participant roles/placements |
| places | Hierarchical places, geocoding via `lookupOrCreate()`, Haversine proximity search |
| facts | Knowledge base: semantic dedup (3-zone reconciliation), evolution chains, confidence |
| sites | Site lifecycle management, agent bindings with priority ordering |
| properties | Digital properties with hierarchical zones for content/ad placement |
| tags | Hierarchical tagging: context-scoped slugs, multi-language aliases |
| social | Social media OAuth (YouTube/Threads/X/Bluesky), post scheduling |
| secrets | Envelope encryption (AMK→TDEK→secret), key rotation, audit logging |

### Tooling
| Package | Purpose |
|---------|---------|
| smrt-svelte | Svelte 5: Provider, browser AI (STT/TTS/LLM) with warm cache, theme system |
| smrt-dev-mcp | Tier 2 dev MCP: `generate-smrt-class`, `introspect-project` |
| gnode | Federation library — stubs only, not implemented |
| template-sveltekit | Base SvelteKit scaffold with SMRT integration |
| template-site-static-json | Community news site scaffold with Praeco/Caelus |

## Commands

```bash
pnpm install && npm run build   # Setup (~8s first build, ~80ms cached via turborepo)
npm run dev                     # Watch mode
npm test                        # Vitest — smrtVitestPlugin() required in config
npm run typecheck               # TypeScript checking
npm run lint                    # Biome
npm run format                  # Biome
```

## Conventions

- **0 vs 0.0**: `count: number = 0` → INTEGER. `price: number = 0.0` → DECIMAL
- **Never override toJSON()** — use `transformJSON()` (toJSON handles STI + meta fields)
- **Cross-package FKs**: plain string IDs, not `@foreignKey()` (avoids circular deps)
- **System tables**: prefixed `_smrt_` (jobs, dispatch, schedules, migrations)
- **Conflict columns**: set `conflictColumns` in `@smrt()` for junction/upsert tables
- **Asset ownership joins**: base/domain-owned asset relationships belong on noun join tables like `content_assets`; use `asset_associations` only for generic/provenance links
- **STI discriminator**: qualified names — `@happyvertical/smrt-content:Article`
- **Tenant scoping**: most domain models use `@TenantScoped({ mode: 'optional' })` + nullable tenantId
- **JSON fields**: store as string, provide `getX()`/`setX()` helpers with graceful parse error handling
- **Changesets**: auto-generated on merge to main. Don't run `npx changeset` manually

## SDK Dependencies

From [@happyvertical/sdk](https://github.com/happyvertical/sdk): `@happyvertical/ai` (AI client), `@happyvertical/sql` (DB ops), `@happyvertical/files` (filesystem), `@happyvertical/utils` (utilities).

## Downstream Doc Generation

`smrt docs:claude` generates `.claude/smrt-framework.md` for consumer projects by concatenating installed package CLAUDE.md files with version tables. Code: `packages/cli/src/commands/docs-claude.ts`.

## Gotchas

- **Vitest plugin required**: without `smrtVitestPlugin()` in vitest.config.ts → "No field metadata" errors
- **Vite decorators**: needs `esbuild.tsconfigRaw` with `experimentalDecorators: true, emitDecoratorMetadata: true`
- **Manifest is build-time**: generated once at vitest startup — restart after adding new `@smrt()` classes
- **ObjectRegistry on globalThis**: singleton via `globalThis.__smrtRegistry*` — survives HMR
- **Lazy table creation**: tables created on first DB op, not on `initialize()` — safe for SSR
- **TypeScript & Svelte 5 Performance**: Avoid using inline intersected generic types (like `Asset & { id: string }`) in component `$props()`. It causes infinite-loop-like recursion during type evaluation. Export an explicit interface (e.g., `interface PersistedAsset extends Asset { id: string }`) instead.
- **Editing `packages/core/src/scanner/*` or `src/schema/generator.ts` requires a rebuild**: the vite-plugin loads these modules from `dist/` deterministically (sniffing `.ts`/`.js` via `import.meta.url` was non-deterministic under tsx and repeatedly broke publishes — see #1139). Run `pnpm build` in core, or keep `pnpm dev` / `pnpm build:watch` running, otherwise consumers won't see your scanner/generator edits reflected in their manifests.
