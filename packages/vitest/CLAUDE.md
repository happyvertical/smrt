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

## Transaction Isolation for Parallel Tests

For reliable parallel test execution (especially in CI with PostgreSQL), use `createIsolatedTestDb`:

```typescript
import { createIsolatedTestDb, type TransactionHandle } from '@happyvertical/smrt-vitest';
import { beforeEach, afterEach, it, expect } from 'vitest';

let db: TransactionHandle;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const result = await createIsolatedTestDb({
    schema: `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)`
  });
  db = result.db;
  cleanup = result.cleanup;
});

afterEach(async () => {
  await cleanup(); // Rolls back transaction - no data persists
});

it('should insert and query', async () => {
  await db.insert('users', { id: '1', name: 'Alice' });
  const user = await db.get('users', { id: '1' });
  expect(user?.name).toBe('Alice');
});

it('should start with clean state', async () => {
  // Previous test's data was rolled back
  const users = await db.list('users', {});
  expect(users).toHaveLength(0);
});
```

### Benefits

- **Complete isolation**: Each test runs in its own transaction
- **Fast**: No table drops/recreates between tests
- **Parallel-safe**: Multiple tests can run simultaneously
- **Works with PostgreSQL in CI**: Eliminates SQLite concurrency issues

### Environment Detection

The package automatically detects the database adapter:
- **CI (DATABASE_URL set)**: Uses PostgreSQL
- **Local development**: Creates unique SQLite temp files

### Requirements

Requires `@happyvertical/sql` with transaction handle support (SDK PR #722).

## Test Database Utilities

| Function | Description |
|----------|-------------|
| `createIsolatedTestDb()` | Create DB with transaction isolation (recommended) |
| `createTestDb()` | Create DB with cleanup function (no isolation) |
| `getTestDbConfig()` | Get DB config for current environment |
| `getTestAdapter()` | Detect adapter: 'postgres' or 'sqlite' |
| `isPostgresAvailable()` | Check if DATABASE_URL is set |
| `getAdapterDisplayName()` | Get human-readable adapter name |

## Development

```bash
# Build
pnpm build

# Type check
pnpm typecheck
```
