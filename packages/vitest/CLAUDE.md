# @happyvertical/smrt-vitest

Vitest plugin for automatic manifest generation and cross-package manifest loading in SMRT tests.

## Purpose

This plugin is **required** for all SMRT projects. It:

1. **Generates manifests automatically** - No need to run `smrt test` or `smrt generate:test` first
2. **Loads cross-package manifests** - Solves Issue #583 where external package classes aren't registered
3. **Registers all classes** - Makes SMRT objects available for tests

Without this plugin, tests fail with "unregistered class" or "No field metadata found" errors.

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

At vitest startup, the plugin:

1. **Generates local manifest** - Scans `src/**/*.ts` for SMRT classes using ManifestBuilder
2. **Discovers dependencies** - Scans `package.json` for `@happyvertical/smrt-*` packages
3. **Loads external manifests** - Uses ManifestManager to load each package's manifest
4. **Registers classes** - Calls `ObjectRegistry.registerFromManifest` for all classes
5. **Tests run** - All SMRT classes are available for testing

**Note on watch mode**: The manifest is generated once at vitest startup. If you add new classes or fields while vitest is running in watch mode, restart vitest to pick up the changes.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `generateManifest` | `boolean` | `true` | Auto-generate manifest at startup |
| `include` | `string[]` | `['src/**/*.ts']` | Source patterns to scan for manifest generation |
| `exclude` | `string[]` | `['**/*.d.ts', '**/node_modules/**', '**/dist/**']` | Patterns to exclude from scanning |
| `packages` | `string[]` | `[]` | Additional packages to load beyond auto-discovered |
| `verbose` | `boolean` | `false` | Enable detailed logging |
| `root` | `string` | `process.cwd()` | Root directory for package.json discovery |

### Disabling Auto-Generation

If you prefer to use a pre-built manifest (e.g., from `npm run build`):

```typescript
export default defineConfig({
  plugins: [
    smrtVitestPlugin({
      generateManifest: false, // Use existing manifest only
    }),
  ],
});
```

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

## GlobalThis Isolation

For complete test isolation, use the setup file to prevent manifest cache bleeding across test files:

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';

export default defineConfig({
  plugins: [smrtVitestPlugin()],
  test: {
    setupFiles: ['@happyvertical/smrt-vitest/setup'],
  },
});
```

This ensures each test file starts with a clean global state.

## Development

```bash
# Build
pnpm build

# Type check
pnpm typecheck
```
