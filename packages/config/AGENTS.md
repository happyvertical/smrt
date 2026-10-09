# @happyvertical/smrt-config

Configuration management with cosmiconfig, secret sanitization, and SSG export.

## How It Works

1. **cosmiconfig loader** searches for `smrt.config.{js,ts,json}` (via `loadConfig()`)
2. **Priority**: runtime (highest) > file config > defaults
3. **globalThis caching**: `globalThis.__smrtConfigCache` — all modules share one config instance

## Key Functions

| Function | Purpose |
|----------|---------|
| `loadConfig()` | Async load from file (cosmiconfig) |
| `getConfig()` | Get full merged config |
| `getModuleConfig(name)` | Module-scoped config section |
| `getPackageConfig(name)` | Package-scoped config section |
| `setConfig(overrides)` | Runtime overrides (highest priority) |
| `clearCache()` | Reset cached config — affects all modules |
| `exportConfig({ includeSecrets })` | SSG-safe export (defaults to no secrets) |
| `sanitizeConfig(config)` | Strips keys matching: apiKey, password, secret, token, credential, private, auth, key |
| `resolveApplicationRuntime(config)` | Resolve and validate a local, self-hosted, or cloud infrastructure profile |
| `resolveConfiguredApplicationRuntime()` | Resolve loaded file config plus highest-priority `setConfig()` runtime overrides |
| `resolveEffectiveApplicationRuntime(config)` | The `smrt app` / SvelteKit runtime rule: no `runtime` block in either layer → `local`; a present non-block value (`null`/`false`/`0`/`''`) fails closed |
| `resolveConfiguredAIProvider()` / `tryResolveAIProviderConfig()` | One AI provider resolver (`src/ai.ts`): explicit > `ai` block > `SMRT_AI_*`/`HAVE_AI_*` env > selected provider's key var > auto-detect; see README |
| `getApplicationRuntimePreset(profile)` | Inspect a profile's safe provider defaults |
| `resolveCliDatabaseConfig(env?)` | CLI database precedence shared by `smrt` and `smrt-dev-mcp`: declared `packages.cli.database.url` > `DATABASE_URL` (engine: config type > `DATABASE_TYPE` > scheme); read-only (`src/database-environment.ts`) |

## Key Files

- `src/index.ts` — Node entry: `src/shared.ts` plus `loadConfig()`; `src/browser.ts` — `exports['.'].browser` entry, same surface with a `loadConfig()` that rejects (model roots bundle for browsers, #3625)
- `src/shared.ts` — the config API (get/set/resolve/clear); must stay free of `loader.ts` (cosmiconfig, jiti, node:fs). Loader state is in `src/loader-state.ts`
- `src/loader.ts` — cosmiconfig integration and file discovery (Node entry only)
- `src/merge.ts` — deep merge logic, runtime config store
- `src/export.ts` — sanitization and export formatting (JSON/JS)
- `src/runtime-profile.ts` — application runtime presets, validation, capabilities, and diagnostics
- `src/types.ts` — full config schema (~800 lines)

## Gotchas

- **Keep `shared.ts` browser-safe**: new API goes in `shared.ts` (both entries export it); only Node I/O belongs in `index.ts`/`loader.ts`. `src/browser.test.ts` checks the two entries export the same names.
- **AI credentials are bound to their source's provider**: a lower-priority key/baseUrl is dropped when another provider wins; redacted base URLs show only the origin. **AI keys come from the environment**: the `ai` block names a variable (`apiKeyEnv`); resolver errors/`toJSON()` never contain keys or URL credentials. Core and the chat dev routes use this resolver; agents share its provider key-name map (`getDefaultAIKeyEnvName`) and keep per-tenant secret lookup; do not add new provider-env parsing elsewhere.
- **clearCache() is global**: affects all modules sharing the config instance
- **SSG export defaults to no secrets**: must explicitly set `includeSecrets: true` to include them
- **Deep merge**: later values override earlier ones at each key level
- **Profiles do not alter application policy**: domain objects, generated REST/CLI/MCP/WebMCP surfaces, action effects, approval policy, authorization records, and job invocation stay identical across profiles.
- **Runtime snapshots contain selectors, never credentials**: provider-specific URLs, tokens, paths, and secret values belong in the implementing provider's configuration. Unknown runtime fields fail closed.
