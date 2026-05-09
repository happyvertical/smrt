# smrt-prompts

SMRT prompt registry and tenant-aware prompt override package. Code defines defaults; config layers and DB-stored overrides personalize at app and tenant levels.

## Core pieces

- `definePrompt()` registers code defaults in a global process registry (`globalThis.__smrtPromptRegistry`)
- `resolvePrompt()` merges code defaults, file/config overrides (via `@happyvertical/smrt-config`), stored app-level overrides, stored tenant-level overrides, and a runtime override
- `PromptOverride` (`_smrt_prompt_overrides` table) stores partial app-level and tenant-level overrides with write-time validation
- `PromptOverrideCollection` exposes the standard SmrtCollection CRUD surface

## Resolution layers (priority low → high)

1. Code default — registered via `definePrompt({ key, template, ai })`
2. File/config override — `getPackageConfig<PromptPackageConfig>('prompts', defaults)`
3. App-level stored override — `PromptOverride` row with `tenantId = null`
4. Tenant-level stored override — `PromptOverride` row with current tenant
5. Runtime override — passed to `resolvePrompt({ overrides })`

Each layer can override any subset of fields (template, profile, model, params). Inheritance is field-by-field.

## Conventions

- **Namespace prompt keys** by package or domain: `projects.issue.incorporateFeedback`, `content.summarize.headline`
- **Stored overrides use nullable fields** so inheritance stays field-by-field — null means "use the lower layer"
- **Provider selection is indirect** in v1: prompts select named profiles, and profiles resolve to provider/model in `smrt-config`
- **`editable` flags are enforced on `PromptOverride.save()`** — definitions can lock specific fields against tenant override

## Caching

`resolvePrompt()` results are cached per `(key, tenantId)` with a TTL. The cache is invalidated on `PromptOverride.save()` and `.delete()`. Use `clearPromptCache()` for manual invalidation in tests.

## Related

- `@happyvertical/smrt-languages` — parallel package for language strings (uses the same architecture pattern)
- `@happyvertical/smrt-features` — parallel package for feature flags
