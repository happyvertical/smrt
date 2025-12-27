# @happyvertical/smrt-vitest

Vitest plugin for automatic cross-package manifest loading in SMRT tests.

## Purpose

Solves Issue #583: Cross-package integration tests fail because external package classes aren't registered in the local test manifest.

When testing smrt-commerce, for example, and you import `AccountCollection` from smrt-ledgers, the test fails with "unregistered class" errors because:
1. Each package generates its own test manifest via `generate-test-manifest.js`
2. The manifest only scans `src/**/*.ts` within that package
3. Classes from peer dependencies aren't included

This plugin automatically discovers SMRT peer dependencies and loads their manifests before tests run.

## Installation

```bash
pnpm add -D @happyvertical/smrt-vitest
```

## Usage

### As a Vitest Plugin (Recommended)

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';

export default defineConfig({
  plugins: [smrtVitestPlugin()],
  test: {
    globals: true,
    environment: 'node',
  },
});
```

### With Options

```typescript
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';

export default defineConfig({
  plugins: [
    smrtVitestPlugin({
      // Additional packages to load (beyond auto-discovered)
      packages: ['@my-org/custom-smrt-package'],
      // Enable verbose logging
      verbose: true,
    }),
  ],
});
```

### As Global Setup

Alternative to the plugin approach:

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./setup-smrt.ts'],
  },
});

// setup-smrt.ts
import { setupSmrtManifests } from '@happyvertical/smrt-vitest';

export default async function() {
  await setupSmrtManifests({ verbose: true });
}
```

## How It Works

1. **Discovery**: Scans `package.json` for `@happyvertical/smrt-*` dependencies
2. **Load**: Uses `loadExternalManifestSync` to load each package's manifest
3. **Register**: Calls `ObjectRegistry.registerFromManifest` for each class
4. **Test**: Classes are now available for cross-package integration tests

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `packages` | `string[]` | `[]` | Additional packages to load beyond auto-discovered |
| `verbose` | `boolean` | `false` | Enable detailed logging |
| `root` | `string` | `process.cwd()` | Root directory for package.json discovery |

## Example: smrt-commerce Integration Tests

Before this plugin, the following test would fail:

```typescript
// src/__tests__/payment-ledger.test.ts
import { AccountCollection } from '@happyvertical/smrt-ledgers';  // Fails!

describe('Payment Ledger Integration', () => {
  it('should create journal entry on payment', async () => {
    const accounts = await AccountCollection.create(dbConfig);
    // Test code...
  });
});
```

With this plugin in `vitest.config.ts`, the test works because smrt-ledgers classes are pre-registered.

## Development

```bash
# Build
pnpm build

# Type check
pnpm typecheck
```
