# @have/config Specification

## Overview

`@have/config` provides centralized configuration management for SMRT modules and applications. It allows module options to be declared throughout the codebase while maintaining a single source of truth in project-level configuration files.

## Core Concepts

### Configuration File Formats

Support multiple configuration file formats with automatic detection:

- `smrt.config.js` - JavaScript (ESM)
- `smrt.config.ts` - TypeScript
- `smrt.config.json` - JSON
- `smrt.config.yaml` / `smrt.config.yml` - YAML
- `smrt.config.toml` - TOML

### Configuration Structure

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

## API Design

### Core Functions

```typescript
/**
 * Load and parse configuration from project root
 */
export async function loadConfig(
  options?: LoadConfigOptions
): Promise<SmrtConfig>;

/**
 * Get configuration for a specific module
 */
export function getModuleConfig<T = unknown>(
  moduleName: string,
  defaults?: T
): T;

/**
 * Get configuration for a specific package
 */
export function getPackageConfig<T = unknown>(
  packageName: string,
  defaults?: T
): T;

/**
 * Set configuration at runtime (merged with file config)
 */
export function setConfig(config: Partial<SmrtConfig>): void;

/**
 * Watch configuration file for changes
 */
export function watchConfig(
  callback: (config: SmrtConfig) => void
): () => void;

/**
 * Validate configuration against schema
 */
export function validateConfig(
  config: unknown,
  schema?: ConfigSchema
): ValidationResult;
```

### Options Types

```typescript
interface LoadConfigOptions {
  // Custom config file path (default: auto-detect in cwd)
  configPath?: string;

  // Search parent directories (default: true)
  searchParents?: boolean;

  // Merge with environment variables (default: true)
  useEnv?: boolean;

  // Environment variable prefix (default: 'SMRT_')
  envPrefix?: string;

  // Validate against schemas (default: true)
  validate?: boolean;

  // Cache loaded config (default: true)
  cache?: boolean;
}

interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
  warnings?: ValidationWarning[];
}
```

## Implementation Details

### File Discovery

1. Start from current working directory
2. Look for `smrt.config.*` in order: `.ts`, `.js`, `.json`, `.yaml`, `.yml`, `.toml`
3. If `searchParents: true`, traverse up directory tree
4. Stop at first config file found or project root (contains `package.json`)

### Configuration Merging

Priority order (highest to lowest):

1. Runtime config set via `setConfig()`
2. Environment variables (with prefix)
3. Configuration file
4. Module/package defaults

### Environment Variable Mapping

```bash
# Global options
SMRT_CACHE_DIR=/tmp/cache
SMRT_LOG_LEVEL=debug
SMRT_ENVIRONMENT=production

# Package-scoped options (double underscore separator)
SMRT_AI__DEFAULT_MODEL=gpt-4
SMRT_CACHE__PROVIDER=redis
SMRT_SPIDER__HEADLESS=true

# Module-scoped options
SMRT_MODULES__MY_MODULE__OPTION=value
```

### TypeScript Integration

```typescript
// Auto-generate types from config
import type { defineConfig } from '@have/config';

export default defineConfig({
  smrt: {
    cacheDir: '.cache',
    logLevel: 'info',
  },
  packages: {
    ai: {
      defaultProvider: 'openai',
      defaultModel: 'gpt-4',
    },
    spider: {
      headless: true,
      cacheDir: '.cache/spider',
    },
  },
  modules: {
    'my-custom-module': {
      apiKey: process.env.CUSTOM_API_KEY,
      timeout: 30000,
    },
  },
});
```

### Schema Validation

```typescript
// Packages can export config schemas
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
};

// Validate at load time
const config = await loadConfig({ validate: true });
// Throws if invalid
```

## Usage Examples

### Basic Configuration File

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

    cache: {
      provider: 'file',
      cacheDir: '.cache',
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

### Remote Configuration with Top-Level Await

```javascript
// smrt.config.js - Load from remote source
const remoteConfig = await fetch('https://config.example.com/smrt.json')
  .then(r => r.json());

// Merge with local overrides
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

### Dynamic Configuration Loading

```javascript
// smrt.config.js - Load from multiple sources
const [baseConfig, featureFlags] = await Promise.all([
  fetch('https://config.cdn.com/base.json').then(r => r.json()),
  fetch('https://flags.example.com/features').then(r => r.json()),
]);

export default {
  ...baseConfig,

  features: featureFlags,

  packages: {
    ai: {
      defaultModel: featureFlags.useGPT4 ? 'gpt-4' : 'gpt-3.5-turbo',
    },
  },
};
```

### Using Config in Code

```typescript
import { getPackageConfig, getModuleConfig } from '@have/config';

// In a package
export async function createAIClient() {
  const config = getPackageConfig<AIConfig>('ai', {
    defaultProvider: 'openai',
    defaultModel: 'gpt-4',
  });

  return getAI({
    provider: config.defaultProvider,
    model: config.defaultModel,
    apiKey: config.apiKeys?.[config.defaultProvider],
  });
}

// In a SMRT module
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

### Runtime Configuration

```typescript
import { setConfig, watchConfig } from '@have/config';

// Override config at runtime
setConfig({
  packages: {
    ai: {
      defaultModel: 'gpt-4-turbo',
    },
  },
});

// Watch for config changes (useful in development)
const unwatch = watchConfig((newConfig) => {
  console.log('Config updated:', newConfig);
});

// Later...
unwatch();
```

## Dependencies

- `cosmiconfig` - Configuration file discovery and loading
- `zod` - Schema validation
- `yaml` - YAML parsing
- `toml` - TOML parsing
- `chokidar` - File watching
- `dot-prop` - Deep object property access

## Package Structure

```
@have/config/
├── src/
│   ├── index.ts          # Main exports
│   ├── loader.ts         # Config file loading
│   ├── merge.ts          # Config merging logic
│   ├── env.ts            # Environment variable parsing
│   ├── validate.ts       # Schema validation
│   ├── watch.ts          # File watching
│   └── types.ts          # TypeScript types
├── package.json
├── tsconfig.json
├── README.md
└── SPEC.md (this file)
```

## Testing Strategy

1. **Unit Tests**
   - Config loading from different formats
   - Environment variable parsing
   - Configuration merging
   - Schema validation

2. **Integration Tests**
   - End-to-end config loading
   - Package integration examples
   - File watching

3. **Edge Cases**
   - Missing config files (use defaults)
   - Invalid config syntax
   - Circular dependencies
   - Concurrent file changes

## Advanced Orchestration Patterns

With top-level await, config files become powerful orchestration tools:

### Multi-Source Configuration Aggregation

```javascript
// smrt.config.js - Aggregate from multiple sources
const [
  infraConfig,      // Infrastructure settings from Terraform outputs
  secretsConfig,    // Secrets from Vault/AWS Secrets Manager
  featureFlags,     // Feature flags from LaunchDarkly/Split
  teamSettings,     // Team preferences from internal API
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

### Service Discovery Integration

```javascript
// smrt.config.js - Discover services dynamically
const serviceRegistry = await fetch('https://consul.internal/v1/catalog/services')
  .then(r => r.json());

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

### Configuration Validation Against Remote Schemas

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

### Gnode Federation Discovery

```javascript
// smrt.config.js - Discover and federate with other gnodes
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

### Dynamic Model Selection Based on Cost/Availability

```javascript
// smrt.config.js - Smart model selection
const [pricing, availability] = await Promise.all([
  fetch('https://api.company.com/ai/pricing').then(r => r.json()),
  fetch('https://status.openai.com/api/v2/status.json').then(r => r.json()),
]);

const selectModel = () => {
  if (availability.status.indicator === 'major') {
    return 'claude-3-5-sonnet-20241022'; // Fallback to Anthropic
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

### Secrets Management with Async Decryption

```javascript
// smrt.config.js - Decrypt secrets at load time
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const client = new SecretManagerServiceClient();

const [anthropicKey, openaiKey] = await Promise.all([
  client.accessSecretVersion({ name: 'projects/my-project/secrets/anthropic-key/versions/latest' })
    .then(([version]) => version.payload.data.toString()),
  client.accessSecretVersion({ name: 'projects/my-project/secrets/openai-key/versions/latest' })
    .then(([version]) => version.payload.data.toString()),
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

// Checkout config from specific commit
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

## Future Enhancements

1. **Config Encryption** - Encrypt sensitive values at rest
2. **Config Profiles** - Support development/staging/production profiles
3. **Config Caching** - Cache remote configs with TTL
4. **Config UI** - Web-based configuration editor
5. **Config Migration** - Auto-migrate old config formats
6. **Config Diff** - Show differences between environments
7. **Config Rollback** - Version history and rollback support
