# @happyvertical/smrt-config

Centralized configuration management for the s-m-r-t framework. Uses [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) to load `smrt.config.{js,ts,json}` files, with secret sanitization and SSG-safe export.

## Installation

```bash
pnpm add @happyvertical/smrt-config
```

## Usage

### Create a config file

```javascript
// smrt.config.js
export default {
  runtime: {
    profile: 'local',
  },

  smrt: {
    cacheDir: '.cache',
    logLevel: 'info',
  },

  packages: {
    ai: {
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-20250514',
      apiKeys: {
        anthropic: process.env.ANTHROPIC_API_KEY,
      },
    },
  },

  modules: {
    'town-scraper': {
      cronSchedule: '0 0 * * *',
      maxPages: 100,
    },
  },
};
```

### Application runtime profiles

`runtime.profile` selects a validated infrastructure composition without
forking application objects or workflows. Validation happens before startup;
unsupported combinations throw `RuntimeProfileValidationError` with a recovery
action.

```typescript
// smrt.config.ts
import { defineConfig } from '@happyvertical/smrt-config';

export default defineConfig({
  runtime: {
    profile: 'self-hosted',
    providers: {
      authentication: { provider: 'magic-link' },
      tenancy: { mode: 'multi-tenant', context: 'required' },
      assets: { provider: 'local-files' },
    },
  },
});
```

```typescript
// application startup
import {
  loadConfig,
  resolveConfiguredApplicationRuntime,
} from '@happyvertical/smrt-config';

await loadConfig();
const runtime = resolveConfiguredApplicationRuntime();
// Safe for doctor output and agent inspection: provider selectors and derived
// capabilities are present; URLs, paths, credentials, and secret values are not.
console.log(JSON.stringify(runtime));
```

| Profile | Database | Authentication | Tenancy | Assets / secrets | Jobs | Network |
| --- | --- | --- | --- | --- | --- | --- |
| `local` | user-owned SQLite | single-use owner bootstrap | real default tenant | user-owned local files | embedded (`inline` override allowed) | loopback |
| `self-hosted` | operator PostgreSQL | OIDC (`magic-link` allowed) | single tenant (`multi-tenant` allowed) | S3-compatible + environment secrets (documented local/external overrides allowed) | external worker | public TLS |
| `cloud` | managed PostgreSQL | hosted identity | required multi-tenant context, application isolation or RLS | managed object storage/secrets | scalable workers | public TLS |

Every profile supports logical export/import. The local profile additionally
advertises file-snapshot backup; deployment profiles assign physical backup to
the operator or managed provider.

The override seam selects only infrastructure providers. It cannot modify
domain models, generated REST/CLI/MCP/WebMCP definitions, action-effect
metadata, approval policy, authorization records, or the job invocation API.
Those are cross-profile invariants and are emitted in every resolved snapshot.
Provider implementations keep their credentials and connection values in their
own configuration; do not add those values to `runtime.providers`.

Use `resolveApplicationRuntime(config.runtime)` for a pure, explicit value such
as a test fixture. Application startup should use
`resolveConfiguredApplicationRuntime()`: it composes the loaded file with
highest-priority `setConfig()` overrides before validation. `getConfig()` keeps
its legacy meaning and returns only loaded file state. Successive `setConfig()`
calls deep-merge providers while the profile is unchanged; an explicit profile
switch resets earlier runtime provider selections before applying the new
profile.

An application that may omit the block uses
`resolveEffectiveApplicationRuntime(await loadConfig())`, the rule `smrt app`
and the SvelteKit runtime share: when neither the file nor a `setConfig()`
override declares `runtime`, the profile is `local`; a present value that is
not a runtime block (`null`, `false`, `0`, `''`) throws the same
`RuntimeProfileValidationError` instead of selecting `local`.

### Use config in code

```typescript
import { loadConfig, getPackageConfig, getModuleConfig, setConfig } from '@happyvertical/smrt-config';

// Load config from file (cosmiconfig auto-discovery)
await loadConfig();

// Get package-scoped config with defaults
const aiConfig = getPackageConfig('ai', {
  defaultProvider: 'openai',
  defaultModel: 'gpt-4',
});

// Get module-scoped config with defaults
const scraperConfig = getModuleConfig('town-scraper', {
  cronSchedule: '0 0 * * *',
  maxPages: 50,
});

// Runtime overrides (highest priority)
setConfig({
  packages: {
    ai: { defaultModel: 'gpt-4-turbo' },
  },
});
```

### Type-safe config files

```typescript
import { defineConfig } from '@happyvertical/smrt-config';

export default defineConfig({
  smrt: {
    logLevel: 'info',
  },
  packages: {
    ai: {
      defaultProvider: 'anthropic',
    },
  },
});
```

### SSG-safe export

```typescript
import { loadConfig, exportConfig, sanitizeConfig } from '@happyvertical/smrt-config';

const config = await loadConfig();

// Export config without secrets (safe for static site generation)
const safeJson = exportConfig(config, { includeSecrets: false });

// Or manually sanitize — strips secret-bearing keys (case-insensitive, across
// camelCase / snake_case / kebab / UPPER variants): apiKey, password, secret,
// token, credential, private, oauth, authorization, accessKey, signingKey, encryptionKey,
// connectionString, dbUrl, cookie, salt, cert, and similar. Biases toward
// over-redaction; pass `{ includeSecrets: true }` to opt out.
const sanitized = sanitizeConfig(config);
```

## AI provider

Declare the assistant model once in `smrt.config.ts`; keep the secret in the environment.

```ts
export default defineConfig({
  ai: { provider: 'openai', model: 'gpt-4o', apiKeyEnv: 'OPENAI_API_KEY' },
});
```

```ts
import { resolveConfiguredAIProvider, toAIClientOptions } from '@happyvertical/smrt-config';
import { getAI } from '@happyvertical/ai';

const ai = await getAI(toAIClientOptions(resolveConfiguredAIProvider()));
```

Default precedence, applied per field (`provider`, `apiKey`, `baseUrl`, `model`), highest first:

1. `explicit` values passed by the caller (for example a class's `options.ai`)
2. the `ai` block (`provider`, `model`, `baseUrl`, `apiKeyEnv`; legacy `packages.ai` is read below `ai`)
3. environment, one prefix at a time: `<PREFIX>_PROVIDER`, `_API_KEY`, `_BASE_URL`, `_MODEL` for `SMRT_AI`, then `HAVE_AI`
4. the selected provider's own key variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`); a key for any other provider is never used
5. with no provider selected, auto-detect the first provider whose key variable is set (openai, anthropic, gemini)

Credential binding: a key or base URL belongs to the provider named by its own source (explicit, the
`ai` block, or one env prefix). If a higher-priority source selects a different provider, the lower
source's key and base URL are discarded and the key comes only from sources valid for the selected
provider (then that provider's own key variable). A source that supplies a key but names no provider is
generic and binds to whichever provider is selected. Displayed base URLs (`toJSON()`,
`describeAIProviderConfig()`, `redactBaseUrl()`) expose only the origin; the real URL still goes to the client.
The rule holds at every layer: the `ai` block layers (runtime `ai`, runtime `packages.ai`, file `ai`, file `packages.ai`)
are merged with provider ownership (`mergeAIConfigLayers`): when a higher layer names a different provider, the lower
layers' `apiKey`, `apiKeyEnv`, `baseUrl` and `model` are dropped (a model id is provider-specific). A layer with no provider
binds to the provider selected so far. Core applies the same rule between its global `ai` config and `options.ai`, and always
builds its client from the resolver's bound result. Aliases are normalised before coalescing (`provider`/`type`,
`model`/`defaultModel`), so a blank primary never hides the alias.
All object merges go through one canonicalising helper, `mergeAIConfigObjects(lower, higher)`
(folds `provider`/`type` and `model`/`defaultModel`, drops blanks, and drops the lower side's provider, key, key variable, base URL and model
when the higher side names a different provider): accumulating `setConfig({ ai })` / `setConfig({ packages: { ai } })`, `mergeExportedConfig`
`ai` blocks, and core's global `ai` + `options.ai`. `withAIAliases()` sets both client-facing aliases on the final result.
Core consults the block only when it names a `provider`; a partial block behaves like no block.

Call sites keep their historical order through options: the chat dev routes pass
`prefixes: ['SMRT_CHAT_DEV', 'SMRT_AI', 'HAVE_AI']` and `envOverridesConfig: true`; core passes
`prefixes: ['SMRT_AI']`, `autoDetect: false`. `resolveAIProviderConfig` throws
`AIProviderNotConfiguredError` (naming variables only) when nothing is configured;
`tryResolveAIProviderConfig` returns `undefined`. Results redact the key in `toJSON()` /
`describeAIProviderConfig()`; errors never include key or URL credentials.

## API

### Functions

| Export | Description |
|--------|------------|
| `loadConfig(options?)` | Async load from file via cosmiconfig |
| `getConfig()` | Get full merged config |
| `getPackageConfig(name, defaults?)` | Get package-scoped config section |
| `getModuleConfig(name, defaults?)` | Get module-scoped config section |
| `getSiteConfig()` | Get site-level config |
| `setConfig(overrides)` | Runtime overrides (highest priority) |
| `clearCache()` | Reset cached config (global — affects all modules) |
| `defineConfig(config)` | Type-safe config file helper |
| `exportConfig(config, options?)` | SSG-safe export (defaults to no secrets) |
| `sanitizeConfig(config)` | Strip secret-matching keys |
| `resolveApplicationRuntime(config)` | Resolve and fail-closed validate a runtime profile |
| `resolveConfiguredApplicationRuntime()` | Resolve effective file plus runtime-overridden profile config |
| `resolveEffectiveApplicationRuntime(config)` | Same, but no `runtime` block (file or override) selects `local`; a present non-block value fails closed |
| `getApplicationRuntimePreset(profile)` | Inspect an immutable copy of a profile preset |
| `resolveCliDatabaseConfig(env?)` | The `smrt` / `smrt-dev-mcp` database: configured `packages.cli.database.url`, else `DATABASE_URL` / `DATABASE_TYPE` (read-only) |
| `mergeExportedConfig(baseConfig, exportedConfig)` | Merge an exported config over a base |
| `parseExportedConfig(raw)` | Parse an exported config string |
| `resolveAIProviderConfig(options?)` / `tryResolveAIProviderConfig(options?)` | Pure resolver (throws / returns `undefined` when unconfigured) |
| `resolveConfiguredAIProvider(options?)` / `tryResolveConfiguredAIProvider(options?)` | Same, against the loaded `ai` block |
| `getAIConfigBlock()` | Effective `ai` block (runtime > file; `ai` > `packages.ai`) |
| `toAIClientOptions(resolved)` | `getAI()` options (`type`, `provider`, `apiKey`, `baseUrl`, `defaultModel`) |

### Priority Order

Configuration merging (highest to lowest):

1. Runtime overrides via `setConfig()`
2. Config file (`smrt.config.{js,ts,json}`)
3. Package/module defaults

### Key Types

`SmrtConfig`, `SmrtGlobalConfig`, `ApplicationRuntimeConfig`, `ResolvedApplicationRuntime`, `RuntimeProviders`, `RuntimeCapabilities`, `RuntimeInvariants`, `RuntimeProfileValidationError`, `DatabaseConfig`, `SiteConfig`, `MigrationsConfig`, `LoadConfigOptions`, `ExportConfig`, `ExportConfigOptions`

## Dependencies

No sibling package dependencies. This is a foundation-layer package.
