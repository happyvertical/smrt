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
| `getApplicationRuntimePreset(profile)` | Inspect an immutable copy of a profile preset |
| `mergeExportedConfig(baseConfig, exportedConfig)` | Merge an exported config over a base |
| `parseExportedConfig(raw)` | Parse an exported config string |

### Priority Order

Configuration merging (highest to lowest):

1. Runtime overrides via `setConfig()`
2. Config file (`smrt.config.{js,ts,json}`)
3. Package/module defaults

### Key Types

`SmrtConfig`, `SmrtGlobalConfig`, `ApplicationRuntimeConfig`, `ResolvedApplicationRuntime`, `RuntimeProviders`, `RuntimeCapabilities`, `RuntimeInvariants`, `RuntimeProfileValidationError`, `DatabaseConfig`, `SiteConfig`, `MigrationsConfig`, `LoadConfigOptions`, `ExportConfig`, `ExportConfigOptions`

## Dependencies

No sibling package dependencies. This is a foundation-layer package.
