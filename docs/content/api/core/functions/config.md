# Function: config()

> **config**(`options`): `void`

Defined in: [packages/core/src/config.ts:187](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/config.ts#L187)

Global configuration API

Callable function with attached methods for managing SMRT configuration.

## Parameters

### options

[`GlobalSignalConfig`](../interfaces/GlobalSignalConfig.md)

## Returns

`void`

## Example

```typescript
import { config } from '@happyvertical/smrt-core';

// Set application-level defaults
config({
  logging: { level: 'debug' },
  metrics: { enabled: true },
  pubsub: { enabled: false },
  ai: {
    provider: 'claude-cli',
    model: 'sonnet'
  }
});

// Reset to defaults
config.reset();

// Get current configuration
const current = config.toJSON();

// Auto-convert to string
console.log(`Config: ${config}`);

// Auto-convert to JSON
JSON.stringify(config);

// All SmrtClass instances now use these defaults
const product = new Product({ name: 'Widget' });
await product.initialize();
// product has logging at debug level, metrics enabled, and uses claude-cli by default
```
