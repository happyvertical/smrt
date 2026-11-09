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

## Compose deployment contract (`./deployment`, #4789)

`@happyvertical/smrt-config/deployment` is a separate entry, not part of the
root export: the `x-happyvertical` contract (version 1) that makes a Compose
file an application's deployment declaration. Guide:
`docs/content/deployment-compose.md`.

- `schemas/x-happyvertical.v1.schema.json` is the published JSON Schema
  (`exports['./schemas/*']`, shipped through `files`). Other repositories
  vendor it: keep it free of regex lookarounds (RE2 consumers) and clean under
  Ajv strict mode. `src/deployment/schema.test.ts` holds its version, presets,
  roles and bindings equal to the constants in `compose-contract.ts` and proves
  every annotation shape error is refused by both.
- `src/deployment/compose-contract.ts`: `validateComposeDeployment()` (stages
  `declare` and `deploy`), the resolved declaration, and the plain-text
  report. Pure and browser-safe: the caller parses YAML. Every rule has an
  issue code and a test in `compose-contract.test.ts`; messages are for
  non-experts and always carry a `fix`. The document is untrusted: the
  validator must never throw (format values with `describe()`, never
  `String()`/`JSON.stringify()`), fails closed on spellings it cannot tell
  apart, refuses a `<<` key anywhere (the caller parsed without merge keys),
  and refuses `$` in what a platform would run or mount (`command`,
  `entrypoint`, `migrate.command`, `health`, volume targets), because Compose
  interpolates the whole file; `name` and a declare-stage `image` are carried
  only when literal. The schema carries the same `$` patterns.
- `entrypoint`/`command` keep Compose meaning in the declaration: absent
  `entrypoint` = the image's runs; `[]` = discarded.
- `src/deployment/chart-values.ts`: `renderSmrtAppChartValues()` renders a
  `deploy`-stage declaration plus environment-owned inputs into `smrt-app`
  chart values. It invents no defaults for Secrets, resources or ingress,
  validates the inputs (hand-written JSON), renders `target` only (`current`
  is passed through, never synthesized), and requires an explicit
  `entrypoint` because the chart's `command` replaces the image's.
- `charts/smrt-app/fixtures/starter.json` is generated from
  `packages/template-sveltekit/template/compose.yaml` by
  `scripts/compose-contract-fixture.mjs --write`; `scripts/compose-contract.test.mjs`
  fails on drift. Change the contract, the template annotations and the
  fixture together.
- Version 1 changes by addition only (new binding kind, preset or optional
  field). Changing the meaning of a field is a new `v2` schema file and a new
  version constant, never an edit to v1.
- Environment values are deliberately not part of the declaration.

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
