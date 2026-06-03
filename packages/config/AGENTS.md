# @happyvertical/smrt-config

Configuration management with cosmiconfig, secret sanitization, and SSG export.

## How It Works

1. **cosmiconfig loader** searches for `smrt.config.{js,ts,json}` (via `loadConfig()`)
2. **Priority**: runtime (highest) > file config > env vars > defaults
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

## Key Files

- `src/loader.ts` — cosmiconfig integration and file discovery
- `src/merge.ts` — deep merge logic, runtime config store
- `src/export.ts` — sanitization and export formatting (JSON/JS)
- `src/types.ts` — full config schema (~800 lines)

## Gotchas

- **clearCache() is global**: affects all modules sharing the config instance
- **SSG export defaults to no secrets**: must explicitly set `includeSecrets: true` to include them
- **Deep merge**: later values override earlier ones at each key level
