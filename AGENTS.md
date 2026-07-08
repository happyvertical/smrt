# SMRT Framework

TypeScript framework for vertical AI agents. Define business logic as TypeScript classes with `@smrt()` — get REST APIs, CLI tools, MCP servers, and AI operations (`is()`/`do()`) automatically.

## Monorepo Packages

All `@happyvertical/smrt-*` packages are version-locked via changesets. pnpm workspace.

### Foundation
| Package | Purpose |
|---------|---------|
| core | ORM (SmrtObject/SmrtCollection), `@smrt()` decorator, code generators (REST/CLI/MCP), DispatchBus, STI |
| config | cosmiconfig loader, secret sanitization, SSG export |
| cli | Developer CLI: `smrt db:*`, `smrt docs:agents`, `smrt dev:knowledge-*`, introspection, code generation |
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
| profiles | Identity: multi-auth (Nostr/OIDC/API keys/magic links), relationships, audit logging, owned asset joins via `profile_assets` |

### Content & Media
| Package | Purpose |
|---------|---------|
| content | STI content types (Article/Document/Mirror), thumbnails (3 strategies), content-owned asset joins via `content_assets`, versioned snapshots with citation-time reference pinning for drift detection |
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
| products | Product catalog — reference template for triple-consumption (npm/federation/standalone) with owned asset joins via `product_assets` |
| ads | Ad delivery: priority waterfall, weighted A/B variations, immutable event tracking |
| affiliates | Revenue sharing: multi-type partners, multi-tier commissions, payout processing |
| ledgers | Double-entry accounting, balance enforcement (EPSILON=0.01), journal lifecycle |
| analytics | GA4/Plausible: properties, data streams, server-side events, AI-powered reports |
| reports | Materialized aggregate read models: report decorators, portable aggregate specs, rebuild refresh |
| subscriptions | Tenant subscription plans, feature grants, usage thresholds, and entitlement resolution |

### Domain
| Package | Purpose |
|---------|---------|
| events | Infinite-nesting event hierarchy, series, participant roles/placements, owned asset joins via `event_assets` |
| places | Hierarchical places, geocoding via `lookupOrCreate()`, Haversine proximity search, owned asset joins via `place_assets` |
| facts | Knowledge base: semantic dedup (3-zone reconciliation), evolution chains, confidence |
| sites | Site lifecycle management, agent bindings with priority ordering |
| properties | Digital properties with hierarchical zones for content/ad placement |
| tags | Hierarchical tagging: context-scoped slugs, multi-language aliases |
| social | Social media OAuth (YouTube/Threads/X/Bluesky), post scheduling |
| secrets | Envelope encryption (AMK→TDEK→secret), key rotation, audit logging |

### Mobile
| Package | Purpose |
|---------|---------|
| smrt-mobile | KMP shared mobile foundation (offline packs + durable SQLDelight write-queue, evidence, i18n, shell state, PKCE auth/session, Ktor client, platform seams incl. barcode/speech/on-device-LLM) — first non-TS package, Gradle behind a package.json wrapper (ADR 0001) |
| smrt-android | Android Compose foundation: MobileTheme design tokens, bottom-tab shell bound to MobileShellState, native adapters (ML Kit barcode, speech, Gemini Nano, device capabilities, SQLDelight driver, Keystore auth storage) — consumes smrt-mobile via Gradle composite build |
| smrt-ios | SwiftUI foundation: MobileTheme design tokens, tab shell bound to MobileShellState, native adapters (VisionKit barcode, Speech, Foundation Models on-device LLM, device capabilities, SQLDelight native driver, Keychain auth storage, ASWebAuthenticationSession launcher) — consumes the exported SmrtMobile KMP framework via XcodeGen |
| smrt-mobile-contract | TS codegen: SMRT manifest + allowlist → Kotlin/Swift mobile DTOs + smrt-mobile's generated framework contract |

### Tooling
| Package | Purpose |
|---------|---------|
| smrt-web | Browser client data runtime (web twin of smrt-mobile): manifest-generated collections over the generated REST surface with SWR reads, request dedup, optimistic mutations; wraps the client-data engine (TanStack DB) behind SMRT-owned types so it never leaks |
| smrt-svelte | Svelte 5: Provider, browser AI (STT/TTS/LLM) with warm cache, theme system |
| smrt-dev-mcp | Tier 2 dev MCP: code generation, project introspection, deterministic knowledge reflection, review/architecture context bundles, bundled agent skills |
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
- **Same-package FKs**: use `@foreignKey(Target)` so relationships, schema, includes, and `loadRelated()` are registered.
- **Cross-package FKs**: use `@crossPackageRef('@happyvertical/smrt-package:Class')`; it registers runtime relationships without emitting circular DDL constraints.
- **System tables**: prefixed `_smrt_` (jobs, dispatch, schedules, migrations)
- **Conflict columns**: set `conflictColumns` in `@smrt()` for junction/upsert tables
- **Junction collections**: extend `SmrtJunction`; use `byLeft()` / `byRight()` and options-object `attach()` / `detach()`.
- **Hierarchies**: extend `SmrtHierarchical` only for true `parentId` trees; use package-specific names for chains/DAGs like fact evolution or asset derivation.
- **Polymorphic links**: extend `SmrtPolymorphicAssociation` for generic/provenance links that target `(metaType, metaId, role)`.
- **Asset ownership joins**: base/domain-owned asset relationships belong on noun join tables like `content_assets`, `profile_assets`, `event_assets`, `place_assets`, and `product_assets`; use `asset_associations` only for generic/provenance links
- **STI discriminator**: qualified names — `@happyvertical/smrt-content:Article`
- **UUID storage**: `id` and declared FK columns are native `uuid` on PostgreSQL/DuckDB and `TEXT` on SQLite.
- **Tenant relationship loads**: `loadRelated()` / `loadRelatedMany()` enforce tenant isolation unless `{ allowCrossTenant: true }` is explicit.
- **Tenant scoping**: most domain models use `@TenantScoped({ mode: 'optional' })` + nullable tenantId
- **JSON fields**: store as string, provide `getX()`/`setX()` helpers with graceful parse error handling
- **No private reach-ins**: do not cast into underscored internals like `_db`, `_tableName`, or registry-private state from outside the owning class. If a public API is missing, add one upstream instead of reaching through a private implementation detail.
- **Changesets**: auto-generated on merge to main. Don't run `npx changeset` manually

## SDK Dependencies

From [@happyvertical/sdk](https://github.com/happyvertical/sdk): `@happyvertical/ai`, `@happyvertical/sql`, `@happyvertical/files`, `@happyvertical/utils`, `@happyvertical/cache`, `@happyvertical/documents`, `@happyvertical/email`, `@happyvertical/encryption`, `@happyvertical/geo`, `@happyvertical/images`, `@happyvertical/jobs`, `@happyvertical/json`, `@happyvertical/logger`, `@happyvertical/messages`, `@happyvertical/ocr`, `@happyvertical/pdf`, `@happyvertical/projects`, `@happyvertical/repos`, `@happyvertical/secrets`, and `@happyvertical/spider`.

## Downstream Doc Generation

`smrt docs:agents` generates `.agents/smrt-framework.md` for consumer projects by concatenating installed package `AGENTS.md` files with version tables. `smrt docs:claude` remains a deprecated compatibility alias that writes `.claude/smrt-framework.md`. Code: `packages/cli/src/commands/docs-claude.ts`.

## Agent Knowledge

- `AGENTS.md` is canonical for root and package expert docs.
- `CLAUDE.md` files are one-line Claude Code shims containing only `@AGENTS.md`.
- Harnesses that do not resolve Claude Code `@AGENTS.md` shims should read
  `AGENTS.md` directly.
- `smrt dev:knowledge-index` prints the deterministic SMRT + HappyVertical SDK knowledge graph.
- `smrt dev:knowledge-check` validates agent-doc freshness, stale references, package docs, package `files` entries, and relationship-aware manifest facts. Use `--format markdown` for human hook output and `--format json` for scripts.
- Downstream apps/packages generate `.smrt/smrt-knowledge.json` for local
  development and `dist/smrt-knowledge.json` for published package artifacts.
  `manifest.json` remains runtime-focused; `smrt-knowledge.json` is the
  agent/developer contract.
- `smrt knowledge:review-context` and `smrt knowledge:architecture-context`
  build domain-scoped prompt bundles. Use `--scope project|local|package|sdk`
  and `--package <name>` to narrow context.
- Lefthook runs deterministic knowledge freshness locally: changed-file strict checks on pre-commit and full strict checks on pre-push. CI runs the full strict check as a blocking PR gate (the `Knowledge Freshness` job, sweep S5 #1376). Model-assisted audits are never required in hooks or CI.
- `smrt-dev-mcp` exposes the same knowledge through `reflect-knowledge`, `reflect-domain-knowledge`, `check-knowledge-freshness`, `check-domain-knowledge`, `build-review-context`, `build-domain-review-context`, `smrt-review`, `build-architecture-context`, `build-domain-architecture-context`, and `smrt-architecture`.
- `smrt-dev-mcp` also ships harness-agnostic skills. Downstream agents can call `get-agent-skill` with `name: "smrt-code-review"` to fetch the portable review procedure before using `smrt-review` on a project diff.

## Gotchas

- **Vitest plugin required**: without `smrtVitestPlugin()` in vitest.config.ts → "No field metadata" errors
- **Vite decorators**: under Vite 8 set `oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } }` in `vite.config.ts` (see `packages/template-sveltekit/template/vite.config.ts`) — the oxc transform ignores the pre-Vite-8 `esbuild.tsconfigRaw` / tsconfig `experimentalDecorators` through SvelteKit's `extends` chain, so that recipe throws `SyntaxError: Invalid or unexpected token` on the first SSR request. Consumers pinned on vite<8 still need the legacy `esbuild.tsconfigRaw` form.
- **Manifest is build-time**: generated once at vitest startup — restart after adding new `@smrt()` classes
- **ObjectRegistry on globalThis**: singleton via `globalThis.__smrtRegistry*` — survives HMR
- **No runtime schema creation**: application tables must be prepared explicitly via migrations/tooling; runtime only verifies and fails clearly
- **Svelte typechecking**: packages with `/svelte` subpaths must run `svelte-check` in `typecheck` after `tsc`; `tsc` alone treats `.svelte` imports as ambient `Component<any>`.
- **TypeScript & Svelte 5 Performance**: Avoid using inline intersected generic types (like `Asset & { id: string }`) in component `$props()`. It causes infinite-loop-like recursion during type evaluation. Export an explicit interface (e.g., `interface PersistedAsset extends Asset { id: string }`) instead.
- **Editing `packages/core/src/scanner/*` or `src/schema/generator.ts` requires a rebuild**: the vite-plugin loads these modules from `dist/` deterministically (sniffing `.ts`/`.js` via `import.meta.url` was non-deterministic under tsx and repeatedly broke publishes — see #1139). Run `pnpm build` in core, or keep `pnpm dev` / `pnpm build:watch` running, otherwise consumers won't see your scanner/generator edits reflected in their manifests.
