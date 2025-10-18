---
id: config
title: "@have/config: Configuration Management"
sidebar_label: "@have/config"
sidebar_position: 2
---

# @have/config

Centralized configuration management for SMRT modules and applications with support for multiple file formats, environment variables, remote sources, and powerful orchestration via top-level await.

## Features

- 🎯 **Multiple formats** - JS, TS, JSON, YAML, TOML with auto-detection
- 🔐 **Secure** - Environment variable integration and async secrets management
- 🌐 **Remote config** - Load from APIs, feature flags, service discovery
- 🔄 **Hot reload** - Watch for config changes in development
- ✨ **Type-safe** - Full TypeScript support with auto-completion
- 🎭 **Orchestration** - Top-level await enables powerful composition patterns
- 📦 **Scoped** - Global, package, and module-level configuration
- ✅ **Validated** - Schema validation with Zod

## Installation

```bash
npm install @have/config
# or
pnpm add @have/config
# or
bun add @have/config
```

## Quick Start

### 1. Create a config file

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
      defaultModel: 'claude-3-5-sonnet-20241022',
      apiKeys: {
        anthropic: process.env.ANTHROPIC_API_KEY,
      },
    },

    spider: {
      headless: true,
      cacheDir: '.cache/spider',
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

### 2. Use config in your code

```typescript
import { getPackageConfig, getModuleConfig } from '@have/config';

// Get package configuration
const aiConfig = getPackageConfig('ai', {
  defaultProvider: 'openai',
  defaultModel: 'gpt-4',
});

// Get module configuration
const scraperConfig = getModuleConfig('town-scraper', {
  cronSchedule: '0 0 * * *',
  maxPages: 50,
});
```

## Configuration File Formats

`@have/config` automatically detects and loads configuration from these files (in order of precedence):

- `smrt.config.ts` - TypeScript
- `smrt.config.js` - JavaScript (ESM)
- `smrt.config.json` - JSON
- `smrt.config.yaml` / `smrt.config.yml` - YAML
- `smrt.config.toml` - TOML

## API Reference

### `loadConfig(options?)`

Load and parse configuration from the project root.

```typescript
import { loadConfig } from '@have/config';

const config = await loadConfig({
  // Custom config file path (default: auto-detect in cwd)
  configPath: './custom-config.js',

  // Search parent directories (default: true)
  searchParents: true,

  // Merge with environment variables (default: true)
  useEnv: true,

  // Environment variable prefix (default: 'SMRT_')
  envPrefix: 'SMRT_',

  // Validate against schemas (default: true)
  validate: true,

  // Cache loaded config (default: true)
  cache: true,
});
```

### `getPackageConfig<T>(packageName, defaults?)`

Get configuration for a specific package with optional defaults.

```typescript
import { getPackageConfig } from '@have/config';

interface AIConfig {
  defaultProvider: string;
  defaultModel: string;
  apiKeys?: Record<string, string>;
}

const config = getPackageConfig<AIConfig>('ai', {
  defaultProvider: 'openai',
  defaultModel: 'gpt-4',
});
```

### `getModuleConfig<T>(moduleName, defaults?)`

Get configuration for a specific SMRT module.

```typescript
import { getModuleConfig } from '@have/config';

const config = getModuleConfig('my-module', {
  enabled: true,
  timeout: 5000,
});
```

### `setConfig(config)`

Set configuration at runtime (merged with file config).

```typescript
import { setConfig } from '@have/config';

setConfig({
  packages: {
    ai: {
      defaultModel: 'gpt-4-turbo',
    },
  },
});
```

### `watchConfig(callback)`

Watch configuration file for changes. Returns an unwatch function.

```typescript
import { watchConfig } from '@have/config';

const unwatch = watchConfig((newConfig) => {
  console.log('Config updated:', newConfig);
});

// Later...
unwatch();
```

### `validateConfig(config, schema?)`

Validate configuration against a schema.

```typescript
import { validateConfig } from '@have/config';

const result = validateConfig(config, schema);

if (!result.valid) {
  console.error('Invalid config:', result.errors);
}
```

## Configuration Structure

```typescript
interface SmrtConfig {
  // Global SMRT framework options
  smrt?: {
    cacheDir?: string;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    environment?: 'development' | 'production' | 'test';
  };

  // Module-scoped configurations
  modules?: {
    [moduleName: string]: Record<string, unknown>;
  };

  // Package-scoped configurations
  packages?: {
    ai?: AIConfig;
    cache?: CacheConfig;
    spider?: SpiderConfig;
    sql?: SQLConfig;
    [packageName: string]: Record<string, unknown>;
  };
}
```

## Environment Variables

Environment variables are automatically merged with configuration files using the `SMRT_` prefix.

### Naming Convention

```bash
# Global options
SMRT_CACHE_DIR=/tmp/cache
SMRT_LOG_LEVEL=debug
SMRT_ENVIRONMENT=production

# Package-scoped (double underscore separator)
SMRT_AI__DEFAULT_MODEL=gpt-4
SMRT_CACHE__PROVIDER=redis
SMRT_SPIDER__HEADLESS=true

# Module-scoped
SMRT_MODULES__MY_MODULE__OPTION=value
```

### Priority Order

Configuration merging follows this priority (highest to lowest):

1. Runtime config set via `setConfig()`
2. Environment variables (with prefix)
3. Configuration file
4. Module/package defaults

## TypeScript Integration

### Type-safe Configuration

```typescript
import { defineConfig } from '@have/config';

export default defineConfig({
  smrt: {
    cacheDir: '.cache',
    logLevel: 'info', // Auto-completion works!
  },
  packages: {
    ai: {
      defaultProvider: 'openai', // Type-checked
      defaultModel: 'gpt-4',
    },
  },
});
```

### Custom Type Definitions

```typescript
// types/config.d.ts
declare module '@have/config' {
  interface CustomPackageConfig {
    myPackage: {
      apiUrl: string;
      timeout: number;
    };
  }
}
```

## Basic Usage Examples

### Simple Configuration

```javascript
// smrt.config.js
export default {
  packages: {
    ai: {
      defaultProvider: 'anthropic',
      defaultModel: 'claude-3-5-sonnet-20241022',
    },
  },
};
```

### Using in Packages

```typescript
// In @have/ai
import { getPackageConfig } from '@have/config';

export async function getAI(options?: Partial<AIConfig>) {
  const config = getPackageConfig('ai', {
    defaultProvider: 'openai',
    defaultModel: 'gpt-4',
  });

  return createClient({
    ...config,
    ...options,
  });
}
```

### Using in SMRT Modules

```typescript
import { getModuleConfig } from '@have/config';

@smrt()
export class TownScraper {
  private config = getModuleConfig('town-scraper', {
    cronSchedule: '0 0 * * *',
    maxPages: 50,
  });

  async scrape() {
    console.log(`Running with schedule: ${this.config.cronSchedule}`);
  }
}
```

## Advanced Orchestration Patterns

With Node v24's top-level await support, configuration files become powerful orchestration tools.

### Remote Configuration

```javascript
// smrt.config.js - Load from remote source
const remoteConfig = await fetch('https://config.example.com/smrt.json')
  .then(r => r.json());

export default {
  ...remoteConfig,

  // Override specific values locally
  smrt: {
    ...remoteConfig.smrt,
    logLevel: 'debug', // Local override
  },

  packages: {
    ...remoteConfig.packages,
    ai: {
      ...remoteConfig.packages.ai,
      apiKeys: {
        // Keep secrets local, never from remote
        anthropic: process.env.ANTHROPIC_API_KEY,
      },
    },
  },
};
```

### Multi-Source Aggregation

```javascript
// smrt.config.js - Aggregate from multiple sources
const [
  infraConfig,      // Infrastructure from Terraform
  secretsConfig,    // Secrets from Vault/AWS Secrets Manager
  featureFlags,     // Feature flags from LaunchDarkly
  teamSettings,     // Team preferences from API
] = await Promise.all([
  fetch('https://infra.company.com/outputs').then(r => r.json()),
  fetch('https://vault.company.com/secrets/app').then(r => r.json()),
  fetch('https://flags.company.com/features').then(r => r.json()),
  fetch('https://api.company.com/team/settings').then(r => r.json()),
]);

export default {
  smrt: {
    environment: infraConfig.environment,
    logLevel: teamSettings.defaultLogLevel,
  },

  packages: {
    ai: {
      defaultModel: featureFlags.useGPT4 ? 'gpt-4' : 'gpt-3.5-turbo',
      apiKeys: secretsConfig.aiKeys,
    },

    sql: {
      connectionString: infraConfig.databaseUrl,
      maxConnections: infraConfig.dbPoolSize,
    },
  },
};
```

### Service Discovery

```javascript
// smrt.config.js - Discover services dynamically
const aiService = await fetch('https://consul.internal/v1/health/service/ai-gateway')
  .then(r => r.json())
  .then(services => services[0]); // Get first healthy instance

export default {
  packages: {
    ai: {
      baseUrl: `http://${aiService.Service.Address}:${aiService.Service.Port}`,
      timeout: 30000,
    },
  },
};
```

### Gnode Federation Discovery

```javascript
// smrt.config.js - Discover and federate with nearby gnodes
const nearbyGnodes = await fetch('https://registry.gnodes.network/nearby?lat=52.52&lon=13.40&radius=50')
  .then(r => r.json());

export default {
  modules: {
    'gnode-federation': {
      peers: nearbyGnodes.map(node => ({
        id: node.id,
        name: node.name,
        url: node.apiUrl,
        topics: node.topics,
      })),
      syncInterval: 3600000, // 1 hour
    },
  },

  packages: {
    spider: {
      allowedDomains: nearbyGnodes.flatMap(node => node.domains),
    },
  },
};
```

### Dynamic Model Selection

```javascript
// smrt.config.js - Smart model selection based on cost/availability
const [pricing, availability] = await Promise.all([
  fetch('https://api.company.com/ai/pricing').then(r => r.json()),
  fetch('https://status.openai.com/api/v2/status.json').then(r => r.json()),
]);

const selectModel = () => {
  if (availability.status.indicator === 'major') {
    return 'claude-3-5-sonnet-20241022'; // Fallback
  }

  const budget = process.env.AI_BUDGET || 100;
  return pricing.gpt4Price < budget ? 'gpt-4' : 'gpt-3.5-turbo';
};

export default {
  packages: {
    ai: {
      defaultModel: selectModel(),
      fallbackModels: ['claude-3-5-sonnet-20241022', 'gpt-3.5-turbo'],
    },
  },
};
```

### Secrets Management

```javascript
// smrt.config.js - Load secrets from Google Cloud Secret Manager
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const client = new SecretManagerServiceClient();

const [anthropicKey, openaiKey] = await Promise.all([
  client.accessSecretVersion({
    name: 'projects/my-project/secrets/anthropic-key/versions/latest'
  }).then(([version]) => version.payload.data.toString()),

  client.accessSecretVersion({
    name: 'projects/my-project/secrets/openai-key/versions/latest'
  }).then(([version]) => version.payload.data.toString()),
]);

export default {
  packages: {
    ai: {
      apiKeys: {
        anthropic: anthropicKey,
        openai: openaiKey,
      },
    },
  },
};
```

### Git-Based Configuration Versioning

```javascript
// smrt.config.js - Load config from specific git commit
import { simpleGit } from 'simple-git';

const git = simpleGit();
const deployCommit = process.env.DEPLOY_COMMIT || 'HEAD';

// Load config from specific commit
const configContent = await git.show([`${deployCommit}:config/production.json`]);
const baseConfig = JSON.parse(configContent);

export default {
  ...baseConfig,

  meta: {
    deployedAt: new Date().toISOString(),
    gitCommit: await git.revparse(['HEAD']),
    gitBranch: await git.revparse(['--abbrev-ref', 'HEAD']),
  },
};
```

### Remote Schema Validation

```javascript
// smrt.config.js - Validate against remote JSON Schema
const configSchema = await fetch('https://schemas.company.com/smrt-config.schema.json')
  .then(r => r.json());

const localConfig = {
  packages: {
    ai: {
      defaultProvider: 'anthropic',
      defaultModel: 'claude-3-5-sonnet-20241022',
    },
  },
};

// Validate before export
const { default: Ajv } = await import('ajv');
const ajv = new Ajv();
const validate = ajv.compile(configSchema);

if (!validate(localConfig)) {
  throw new Error(`Invalid config: ${JSON.stringify(validate.errors)}`);
}

export default localConfig;
```

### Conditional Module Loading

```javascript
// smrt.config.js - Load modules based on environment
const environment = process.env.NODE_ENV;

const productionModules = environment === 'production'
  ? await fetch('https://cdn.company.com/prod-modules.json').then(r => r.json())
  : {};

export default {
  modules: {
    ...productionModules,

    // Development-only modules
    ...(environment === 'development' && {
      'debug-tools': {
        enabled: true,
        port: 9229,
      },
    }),
  },
};
```

## Schema Validation

Packages can export configuration schemas for validation:

```typescript
// @have/ai exports schema
export const aiConfigSchema = {
  type: 'object',
  properties: {
    defaultProvider: {
      type: 'string',
      enum: ['openai', 'anthropic', 'google', 'aws']
    },
    defaultModel: { type: 'string' },
    apiKeys: {
      type: 'object',
      additionalProperties: { type: 'string' }
    },
  },
  required: ['defaultProvider', 'defaultModel'],
};

// Validate at load time
const config = await loadConfig({ validate: true });
// Throws ValidationError if invalid
```

## File Watching

Watch for configuration changes in development:

```typescript
import { watchConfig } from '@have/config';

const unwatch = watchConfig((newConfig) => {
  console.log('Configuration reloaded');

  // Reinitialize services with new config
  reinitializeServices(newConfig);
});

// Clean up on exit
process.on('SIGINT', () => {
  unwatch();
  process.exit();
});
```

## Testing

### Unit Tests

```typescript
import { loadConfig, setConfig } from '@have/config';

describe('@have/config', () => {
  it('should load config from file', async () => {
    const config = await loadConfig({
      configPath: './test-config.js',
    });

    expect(config.smrt.logLevel).toBe('debug');
  });

  it('should merge runtime config', () => {
    setConfig({
      packages: {
        ai: { defaultModel: 'gpt-4-turbo' },
      },
    });

    const aiConfig = getPackageConfig('ai');
    expect(aiConfig.defaultModel).toBe('gpt-4-turbo');
  });
});
```

### Integration Tests

```typescript
import { getPackageConfig } from '@have/config';

describe('Package Integration', () => {
  it('should use config in package', async () => {
    const { getAI } = await import('@have/ai');

    const client = await getAI();

    // Client should use config values
    expect(client.model).toBe('claude-3-5-sonnet-20241022');
  });
});
```

## Best Practices

### 1. Keep Secrets Local

```javascript
// ✅ Good - secrets from environment
export default {
  packages: {
    ai: {
      apiKeys: {
        openai: process.env.OPENAI_API_KEY,
      },
    },
  },
};

// ❌ Bad - hardcoded secrets
export default {
  packages: {
    ai: {
      apiKeys: {
        openai: 'sk-123456...', // Never do this!
      },
    },
  },
};
```

### 2. Use Defaults Wisely

```typescript
// ✅ Good - sensible defaults
const config = getPackageConfig('ai', {
  defaultProvider: 'openai',
  timeout: 30000,
});

// ❌ Bad - no defaults
const config = getPackageConfig('ai');
// May be undefined!
```

### 3. Validate Remote Configs

```javascript
// ✅ Good - validate remote data
const remoteConfig = await fetch('https://api.example.com/config')
  .then(r => r.json());

const result = validateConfig(remoteConfig);
if (!result.valid) {
  throw new Error('Invalid remote config');
}

export default remoteConfig;
```

### 4. Cache Remote Configs

```javascript
// ✅ Good - cache with TTL
const cacheKey = 'remote-config';
const cached = await cache.get(cacheKey);

const remoteConfig = cached || await fetch('https://api.example.com/config')
  .then(r => r.json())
  .then(async config => {
    await cache.set(cacheKey, config, 3600); // 1 hour TTL
    return config;
  });

export default remoteConfig;
```

### 5. Handle Errors Gracefully

```javascript
// ✅ Good - fallback on error
let remoteConfig = {};

try {
  remoteConfig = await fetch('https://api.example.com/config')
    .then(r => r.json());
} catch (error) {
  console.warn('Failed to load remote config, using defaults:', error);
}

export default {
  ...remoteConfig,
  // Local overrides always work
  smrt: {
    logLevel: 'info',
  },
};
```

## Troubleshooting

### Config file not found

```bash
Error: Config file not found
```

**Solution**: Ensure `smrt.config.*` exists in your project root or use `configPath` option:

```typescript
const config = await loadConfig({
  configPath: './path/to/config.js',
});
```

### Environment variables not working

```bash
# Make sure to use the correct prefix
SMRT_AI__DEFAULT_MODEL=gpt-4  # ✅ Correct
AI__DEFAULT_MODEL=gpt-4       # ❌ Missing prefix
```

### TypeScript errors in config file

```typescript
// Use defineConfig for type safety
import { defineConfig } from '@have/config';

export default defineConfig({
  // Full type checking and auto-completion
});
```

### Remote config timeout

```javascript
// Set timeout for remote fetches
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5000);

const remoteConfig = await fetch('https://api.example.com/config', {
  signal: controller.signal,
}).then(r => r.json())
  .finally(() => clearTimeout(timeout));
```

## Roadmap

- [x] Multiple config file formats
- [x] Environment variable integration
- [x] TypeScript support
- [x] Schema validation
- [x] File watching
- [ ] Config encryption for sensitive values
- [ ] Config profiles (dev/staging/prod)
- [ ] Config caching with TTL
- [ ] Config diff tool
- [ ] Config migration utilities
- [ ] Web-based config editor UI
- [ ] Version history and rollback

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for development guidelines.

## License

MIT © HappyVertical
