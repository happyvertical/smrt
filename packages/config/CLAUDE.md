# @happyvertical/smrt-config: Configuration Management

## Purpose and Responsibilities

The `@happyvertical/smrt-config` package provides centralized configuration management for SMRT modules and applications. It handles:

- **Configuration Loading**: Multiple file formats (JS, TS, JSON, YAML, TOML) with auto-detection
- **Configuration Merging**: Priority-based merging of file, runtime, and environment configs
- **Package/Module Scoping**: Separate config namespaces for packages and modules
- **Config Export**: Export database-persisted configs for static site generation
- **Secret Sanitization**: Filter sensitive values when exporting configurations

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Config Loading Priority                       │
├─────────────────────────────────────────────────────────────────┤
│  1. Runtime overrides (highest) - setConfig()                    │
│  2. Environment variables - SMRT_* prefix                        │
│  3. File config - smrt.config.js                                 │
│  4. Package/module defaults (lowest)                             │
└─────────────────────────────────────────────────────────────────┘
```

## Core Components

### Configuration Loading (`loader.ts`)

**`loadConfig(options?)`** - Load and parse configuration from the project root.

```typescript
import { loadConfig } from '@happyvertical/smrt-config';

const config = await loadConfig({
  configPath: './custom-config.js',  // Custom config file path
  searchParents: true,               // Search parent directories
  useEnv: true,                      // Merge environment variables
  envPrefix: 'SMRT_',               // Environment variable prefix
  cache: true,                       // Cache loaded config
});
```

**`clearConfigCache()`** - Clear the configuration cache.

### Configuration Merging (`merge.ts`)

**`setConfig(config)`** - Set runtime configuration (merged with file config).

```typescript
import { setConfig } from '@happyvertical/smrt-config';

setConfig({
  packages: {
    ai: { defaultModel: 'gpt-4-turbo' },
  },
});
```

**`clearRuntimeConfig()`** - Clear runtime configuration overrides.

**`getRuntimeConfig()`** - Get current runtime configuration.

**`mergeConfigs(base, override)`** - Deep merge two configuration objects.

### Package/Module Config (`index.ts`)

**`getPackageConfig<T>(packageName, defaults?)`** - Get configuration for a specific package.

```typescript
import { getPackageConfig } from '@happyvertical/smrt-config';

interface AIConfig {
  defaultProvider: string;
  defaultModel: string;
}

const config = getPackageConfig<AIConfig>('ai', {
  defaultProvider: 'openai',
  defaultModel: 'gpt-4',
});
```

**`getModuleConfig<T>(moduleName, defaults?)`** - Get configuration for a specific module.

```typescript
import { getModuleConfig } from '@happyvertical/smrt-config';

const config = getModuleConfig('my-agent', {
  cronSchedule: '0 0 * * *',
  maxRetries: 3,
});
```

---

## Configuration Export System

The export system enables exporting database-persisted agent configurations for static site generation (SSG). This is critical for sites that need to bundle configuration at build time.

### Export Utilities (`export.ts`)

#### `sanitizeConfig(config)`

Deep clone and sanitize a config object, removing any sensitive values.

**Secret Patterns Filtered:**
- `/apiKey/i` - API keys
- `/password/i` - Passwords
- `/secret/i` - Secrets
- `/token/i` - Tokens
- `/credential/i` - Credentials
- `/private/i` - Private keys
- `/\bauth\b/i` - Authentication values
- `/\bkey\b$/i` - Keys (at end of property name)

```typescript
import { sanitizeConfig } from '@happyvertical/smrt-config';

const config = {
  apiEndpoint: 'https://api.example.com',
  apiKey: 'sk-secret-123',           // Will be removed
  nested: {
    password: 'hunter2',             // Will be removed
    name: 'test'                     // Will be kept
  }
};

const sanitized = sanitizeConfig(config);
// Result:
// {
//   apiEndpoint: 'https://api.example.com',
//   nested: { name: 'test' }
// }
```

#### `exportConfig(config, options?)`

Export a configuration object to a string.

**Options:**
- `includeSecrets?: boolean` - Include secrets in export (default: false)
- `format?: 'json' | 'js'` - Output format (default: 'json')
- `indent?: number` - JSON indentation spaces (default: 2)

```typescript
import { exportConfig } from '@happyvertical/smrt-config';

// Export as JSON (default)
const jsonExport = exportConfig(config);

// Export as JS module
const jsExport = exportConfig(config, { format: 'js' });
// Result: 'export default {"key":"value"};\n'

// Export with secrets (use with caution!)
const fullExport = exportConfig(config, { includeSecrets: true });
```

#### `parseExportedConfig(content)`

Parse an exported config string back to an object.

```typescript
import { parseExportedConfig } from '@happyvertical/smrt-config';

// Parse JSON format
const config1 = parseExportedConfig('{"key":"value"}');

// Parse JS module format
const config2 = parseExportedConfig('export default {"key":"value"};');
```

#### `mergeExportedConfig(baseConfig, exportedConfig)`

Merge exported config with file-based config. Performs deep merging of objects.

```typescript
import { mergeExportedConfig } from '@happyvertical/smrt-config';

const baseConfig = {
  sources: { scrapers: ['default'] },
  settings: { timeout: 5000 }
};

const exportedConfig = {
  sources: { scrapers: ['civicweb', 'govstack'] }
};

const merged = mergeExportedConfig(baseConfig, exportedConfig);
// Result:
// {
//   sources: { scrapers: ['civicweb', 'govstack'] },
//   settings: { timeout: 5000 }
// }
```

---

## Static Site Export Workflow

### CLI Command: `smrt config:export`

Export agent configuration from the database for static site generation.

```bash
# Basic export
smrt config:export --agent <agent-id>

# Custom output file
smrt config:export --agent <agent-id> --output my-config.json

# Export as JS module
smrt config:export --agent <agent-id> --format js

# Export specific slot only
smrt config:export --agent <agent-id> --slot sources

# Include secrets (for secure environments)
smrt config:export --agent <agent-id> --include-secrets

# Output JSON to stdout
smrt config:export --agent <agent-id> --json
```

**Options:**
| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--agent` | `-a` | Agent ID to export config for | (required) |
| `--output` | `-o` | Output file path | `smrt.exported.json` |
| `--format` | `-f` | Output format: json or js | `json` |
| `--slot` | `-s` | Export only a specific slot | (all slots) |
| `--include-secrets` | | Include sensitive values | `false` |
| `--json` | `-j` | Output JSON to stdout | `false` |

### Import Pattern in smrt.config.js

```javascript
// smrt.config.js - Import exported config for static site
import exported from './smrt.exported.json' with { type: 'json' };

export default {
  modules: {
    praeco: {
      ...exported,
      // Environment-specific overrides
      apiEndpoint: process.env.API_URL,
    }
  }
};
```

### Complete SSG Workflow

```bash
# 1. Development: Configure agent via admin UI
#    (settings saved to database)

# 2. Pre-build: Export config from database
smrt config:export --agent praeco-main --output smrt.exported.json

# 3. Commit exported config
git add smrt.exported.json
git commit -m "chore: export praeco config for static build"

# 4. Build: Static site generator reads smrt.config.js
#    which imports smrt.exported.json
npm run build
```

---

## Configuration File Structure

```typescript
interface SmrtConfig {
  // Global SMRT framework options
  smrt?: {
    cacheDir?: string;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    environment?: 'development' | 'production' | 'test';
  };

  // Package-scoped configurations
  packages?: {
    ai?: AIConfig;
    cli?: CLIConfig;
    spider?: SpiderConfig;
    sql?: SQLConfig;
    [packageName: string]: Record<string, unknown>;
  };

  // Module-scoped configurations
  modules?: {
    [moduleName: string]: Record<string, unknown>;
  };
}
```

### CLI Package Config

```typescript
interface CLIConfig {
  database?: {
    type?: 'sqlite' | 'postgres' | 'duckdb';
    url?: string;
  };
  migrations?: {
    directory?: string;
    table?: string;
    format?: 'sql' | 'typescript';
  };
}
```

---

## Environment Variables

Environment variables are automatically merged with configuration files using the `SMRT_` prefix.

### Naming Convention

```bash
# Global options
SMRT_CACHE_DIR=/tmp/cache
SMRT_LOG_LEVEL=debug

# Package-scoped (double underscore separator)
SMRT_AI__DEFAULT_MODEL=gpt-4
SMRT_CLI__DATABASE__URL=postgresql://localhost/mydb

# Module-scoped
SMRT_MODULES__MY_AGENT__CRON_SCHEDULE="0 0 * * *"
```

### Priority Order

1. Runtime config (`setConfig()`) - highest
2. Environment variables (`SMRT_*`)
3. Configuration file
4. Package/module defaults - lowest

---

## Usage Examples

### Basic Module Configuration

```typescript
import { getModuleConfig } from '@happyvertical/smrt-config';
import { Agent } from '@happyvertical/smrt-agents';
import { smrt } from '@happyvertical/smrt-core';

@smrt()
class MyAgent extends Agent {
  protected config = getModuleConfig('my-agent', {
    cronSchedule: '0 0 * * *',
    maxRetries: 3,
    timeout: 30000,
  });

  async run(): Promise<void> {
    console.log(`Running with schedule: ${this.config.cronSchedule}`);
  }
}
```

### Dynamic Configuration with Remote Sources

```javascript
// smrt.config.js - Load config from multiple sources
const [infraConfig, featureFlags] = await Promise.all([
  fetch('https://infra.company.com/config').then(r => r.json()),
  fetch('https://flags.company.com/features').then(r => r.json()),
]);

export default {
  packages: {
    ai: {
      defaultModel: featureFlags.useGPT4 ? 'gpt-4' : 'gpt-3.5-turbo',
    },
    sql: {
      connectionString: infraConfig.databaseUrl,
    },
  },
};
```

### Programmatic Export

```typescript
import { exportConfig, sanitizeConfig } from '@happyvertical/smrt-config';
import { writeFileSync } from 'node:fs';

// Get config from database or agent
const agentConfig = await agent.exportConfig();

// Export to file
const exported = exportConfig(agentConfig, { format: 'json' });
writeFileSync('./smrt.exported.json', exported);

// Or sanitize before processing
const sanitized = sanitizeConfig(agentConfig);
console.log('Safe to log:', sanitized);
```

---

## Package Exports

```typescript
// Configuration loading
export { loadConfig, clearConfigCache } from './loader.js';
export type { LoadConfigOptions } from './types.js';

// Configuration merging
export {
  setConfig,
  clearRuntimeConfig,
  getRuntimeConfig,
  mergeConfigs,
} from './merge.js';

// Package/module config
export { getPackageConfig, getModuleConfig } from './index.js';

// Export utilities
export {
  sanitizeConfig,
  exportConfig,
  parseExportedConfig,
  mergeExportedConfig,
  type ExportConfigOptions,
} from './export.js';

// Types
export type { SmrtConfig, PackageConfig, ModuleConfig } from './types.js';
```

---

## Testing

### Unit Test Examples

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  sanitizeConfig,
  exportConfig,
  parseExportedConfig,
  mergeExportedConfig,
} from '@happyvertical/smrt-config';

describe('sanitizeConfig', () => {
  it('should remove apiKey fields', () => {
    const config = { apiKey: 'secret', name: 'test' };
    const sanitized = sanitizeConfig(config);
    expect(sanitized).toEqual({ name: 'test' });
    expect(sanitized).not.toHaveProperty('apiKey');
  });

  it('should remove nested password fields', () => {
    const config = {
      db: { password: 'secret', host: 'localhost' }
    };
    const sanitized = sanitizeConfig(config);
    expect(sanitized).toEqual({ db: { host: 'localhost' } });
  });

  it('should handle arrays', () => {
    const config = {
      items: [{ name: 'test', token: 'secret' }]
    };
    const sanitized = sanitizeConfig(config);
    expect(sanitized).toEqual({ items: [{ name: 'test' }] });
  });
});

describe('exportConfig', () => {
  it('should export as JSON by default', () => {
    const config = { key: 'value' };
    const exported = exportConfig(config);
    expect(JSON.parse(exported)).toEqual(config);
  });

  it('should export as JS module', () => {
    const config = { key: 'value' };
    const exported = exportConfig(config, { format: 'js' });
    expect(exported).toMatch(/^export default/);
    expect(exported).toMatch(/"key":\s*"value"/);
  });

  it('should sanitize by default', () => {
    const config = { apiKey: 'secret', name: 'test' };
    const exported = exportConfig(config);
    const parsed = JSON.parse(exported);
    expect(parsed).not.toHaveProperty('apiKey');
  });

  it('should include secrets when requested', () => {
    const config = { apiKey: 'secret', name: 'test' };
    const exported = exportConfig(config, { includeSecrets: true });
    const parsed = JSON.parse(exported);
    expect(parsed).toHaveProperty('apiKey', 'secret');
  });
});

describe('parseExportedConfig', () => {
  it('should parse JSON format', () => {
    const parsed = parseExportedConfig('{"key":"value"}');
    expect(parsed).toEqual({ key: 'value' });
  });

  it('should parse JS module format', () => {
    const parsed = parseExportedConfig('export default {"key":"value"};');
    expect(parsed).toEqual({ key: 'value' });
  });
});

describe('mergeExportedConfig', () => {
  it('should deep merge objects', () => {
    const base = { a: { b: 1, c: 2 } };
    const override = { a: { b: 3 } };
    const merged = mergeExportedConfig(base, override);
    expect(merged).toEqual({ a: { b: 3, c: 2 } });
  });

  it('should replace arrays', () => {
    const base = { items: [1, 2] };
    const override = { items: [3, 4, 5] };
    const merged = mergeExportedConfig(base, override);
    expect(merged).toEqual({ items: [3, 4, 5] });
  });
});
```

---

## Common Patterns

### 1. Hybrid Config (File + Database)

```typescript
// Agent loads both file config and database config
const fileConfig = getModuleConfig('my-agent', defaults);
const dbConfig = await AgentConfig.forSlot(agentId, 'settings', options);

// Merge with database taking precedence
const config = { ...fileConfig, ...dbConfig };
```

### 2. Environment-Specific Exports

```bash
# Development: include all slots
smrt config:export --agent praeco-main

# Production: export without secrets
smrt config:export --agent praeco-main --output dist/config.json

# Staging: include secrets for testing
smrt config:export --agent praeco-main --include-secrets
```

### 3. Slot-Based Configuration

```typescript
// Export specific configuration slots
smrt config:export --agent praeco-main --slot sources
smrt config:export --agent praeco-main --slot settings
smrt config:export --agent praeco-main --slot reports
```

---

## Troubleshooting

### Config file not found

```bash
Error: Config file not found
```

**Solution**: Ensure `smrt.config.*` exists in your project root:
```bash
ls smrt.config.*
# Should show: smrt.config.js, smrt.config.ts, etc.
```

### Secrets appearing in export

**Solution**: Check if you accidentally passed `includeSecrets: true`:
```typescript
// Wrong - includes secrets
const exported = exportConfig(config, { includeSecrets: true });

// Correct - sanitizes secrets
const exported = exportConfig(config);
```

### Database not configured for export

```bash
❌ Database configuration required
```

**Solution**: Configure database in smrt.config.js:
```javascript
export default {
  packages: {
    cli: {
      database: {
        type: 'sqlite',
        url: './data/app.db',
      },
    },
  },
};
```

---

## Related Packages

- **@happyvertical/smrt-agents**: Uses export utilities for `agent.exportConfig()`
- **@happyvertical/smrt-cli**: Provides `config:export` command
- **@happyvertical/smrt-core**: Uses config for database resolution

## License

MIT License - see [LICENSE](../../LICENSE) file for details.
