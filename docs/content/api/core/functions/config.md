# Function: config()

> **config**(`options`): `void`

Defined in: [smrt/packages/core/src/config.ts:146](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/config.ts#L146)

Global configuration API

Callable function with attached methods for managing SMRT configuration.

## Parameters

### options

[`GlobalSignalConfig`](../interfaces/GlobalSignalConfig.md)

## Returns

`void`

## Example

```typescript
import { config } from '@smrt/core';

// Set application-level defaults
config({
  logging: { level: 'debug' },
  metrics: { enabled: true },
  pubsub: { enabled: false }
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
// product has logging at debug level and metrics enabled
```
