# @happyvertical/smrt-config

Centralized configuration management for the SMRT framework. Uses [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) to load `smrt.config.{js,ts,json}` files, with secret sanitization and SSG-safe export.

## Installation

```bash
pnpm add @happyvertical/smrt-config
```

## Usage

### Create a config file

```javascript
// smrt.config.js
export default {
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
import { exportConfig, sanitizeConfig } from '@happyvertical/smrt-config';

// Export config without secrets (safe for static site generation)
const safeJson = exportConfig(config, { includeSecrets: false });

// Or manually sanitize — strips secret-bearing keys (case-insensitive, across
// camelCase / snake_case / kebab / UPPER variants): apiKey, password, secret,
// token, credential, private, auth, accessKey, signingKey, encryptionKey,
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
| `exportConfig(options?)` | SSG-safe export (defaults to no secrets) |
| `sanitizeConfig(config)` | Strip secret-matching keys |
| `mergeExportedConfig(configs)` | Merge multiple exported configs |
| `parseExportedConfig(raw)` | Parse an exported config string |

### Priority Order

Configuration merging (highest to lowest):

1. Runtime overrides via `setConfig()`
2. Config file (`smrt.config.{js,ts,json}`)
3. Environment variables
4. Package/module defaults

### Key Types

`SmrtConfig`, `SmrtGlobalConfig`, `DatabaseConfig`, `SiteConfig`, `MigrationsConfig`, `LoadConfigOptions`, `ExportConfig`, `ExportConfigOptions`

## Dependencies

No sibling package dependencies. This is a foundation-layer package.
