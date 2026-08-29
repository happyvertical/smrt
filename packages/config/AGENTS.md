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
| `getApplicationRuntimePreset(profile)` | Inspect a profile's safe provider defaults |

## Key Files

- `src/loader.ts` — cosmiconfig integration and file discovery
- `src/merge.ts` — deep merge logic, runtime config store
- `src/export.ts` — sanitization and export formatting (JSON/JS)
- `src/runtime-profile.ts` — application runtime presets, validation, capabilities, and diagnostics
- `src/types.ts` — full config schema (~800 lines)

## Gotchas

- **clearCache() is global**: affects all modules sharing the config instance
- **SSG export defaults to no secrets**: must explicitly set `includeSecrets: true` to include them
- **Deep merge**: later values override earlier ones at each key level
- **Profiles do not alter application policy**: domain objects, generated REST/CLI/MCP/WebMCP surfaces, action effects, approval policy, authorization records, and job invocation stay identical across profiles.
- **Runtime snapshots contain selectors, never credentials**: provider-specific URLs, tokens, paths, and secret values belong in the implementing provider's configuration. Unknown runtime fields fail closed.
