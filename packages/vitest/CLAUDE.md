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
| `createIsolatedTestDbFromManifest()` | Create DB from manifest DDL (recommended for multi-table tests) |
| `createIsolatedTestDb()` | Create DB with transaction isolation (recommended) |
| `createTestDb()` | Create DB with cleanup function (no isolation) |
| `getTestDbConfig()` | Get DB config for current environment |
| `getTestAdapter()` | Detect adapter: 'postgres' or 'sqlite' |
| `isPostgresAvailable()` | Check if DATABASE_URL is set |
| `getAdapterDisplayName()` | Get human-readable adapter name |

## Creating Test DBs from Manifest (Issue #854)

For multi-table, tenant-scoped applications, use `createIsolatedTestDbFromManifest()` to avoid manual DDL extraction:

```typescript
import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import { withTenant, resetTenancy, setupTestTenancy } from '@happyvertical/smrt-tenancy';

// In setup file or beforeAll
setupTestTenancy({ enableInterceptors: true, rawQueryPolicy: 'allow' });

// In test file
let db, cleanup;

beforeEach(async () => {
  ({ db, cleanup } = await createIsolatedTestDbFromManifest());
});

afterEach(async () => {
  resetTenancy();
  await cleanup();
});

it('should auto-populate tenantId', async () => {
  await withTenant({ tenantId: 'test-tenant' }, async () => {
    const product = await collection.create({ name: 'Widget' });
    expect(product.tenantId).toBe('test-tenant');
  });
});
```

### Features

- **Auto-detects manifest** - Checks `.smrt/manifest.json`, `dist/manifest.json`, `src/manifest/manifest.json`
- **STI deduplication** - Multiple classes sharing one table are handled correctly
- **FK dependency ordering** - Tables are created in the correct order based on foreign key references
- **Filtering** - Use `includeObjects` to limit to specific classes

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `manifestPath` | `string` | Auto-detect | Explicit path to manifest file |
| `includeObjects` | `string[]` | All objects | Filter to specific class names |
| `prefix` | `string` | `'smrt-manifest'` | Prefix for SQLite temp files |

### Example: Filter to Specific Objects

```typescript
const { db, cleanup } = await createIsolatedTestDbFromManifest({
  includeObjects: ['Product', 'Order', 'OrderItem'],
});
```

### Error Messages

The function provides helpful error messages:

```
No manifest found. Ensure smrtVitestPlugin() is configured in vitest.config.ts
or specify manifestPath. Checked: .smrt/manifest.json, dist/manifest.json, src/manifest/manifest.json
```

```
No objects with schema found matching: NonExistentClass
```

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

## Module-Level Singleton Caches and Mock Isolation (Issue #861)

When testing modules that use module-level singleton caches (a common pattern for database collections), `vi.mock()` doesn't properly reset these caches between tests. This causes mocks to not be applied correctly after the first test runs.

### The Problem

Many SMRT modules use this pattern:

```typescript
// analytics.ts
let propertyCollection: AnalyticsPropertyCollection | null = null;

async function getPropertyCollection(): Promise<AnalyticsPropertyCollection> {
  if (!propertyCollection) {
    propertyCollection = await AnalyticsPropertyCollection.create({ db: getDbConfig() });
  }
  return propertyCollection;
}
```

When testing, the cached instance persists across tests, ignoring new mock setups.

### Solution: Reset Modules + Dynamic Imports

The workaround requires:
1. Using `vi.resetModules()` in `beforeEach`
2. Using dynamic imports (`await import(...)`) in each test instead of top-level imports
3. Defining mock objects at module scope but populating them in `beforeEach`

```typescript
import { vi, describe, it, expect, beforeEach } from 'vitest';

// Define mock at module scope, but populate in beforeEach
let mockPropertyCollection: any;

vi.mock('@happyvertical/smrt-analytics', () => ({
  AnalyticsPropertyCollection: {
    create: vi.fn(() => Promise.resolve(mockPropertyCollection)),
  },
}));

describe('Analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();  // Critical: reset module cache

    // Populate mock with fresh methods for each test
    mockPropertyCollection = {
      findAll: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'test-id' }),
    };
  });

  it('should list properties', async () => {
    mockPropertyCollection.findAll.mockResolvedValueOnce([
      { id: '1', name: 'Property 1' },
    ]);

    // Dynamic import after resetModules
    const { listAnalyticsProperties } = await import('$lib/server/analytics');

    const result = await listAnalyticsProperties();
    expect(result).toHaveLength(1);
    expect(mockPropertyCollection.findAll).toHaveBeenCalled();
  });

  it('should get property by id', async () => {
    mockPropertyCollection.get.mockResolvedValueOnce({ id: '1', name: 'Test' });

    // Fresh import - gets new mock instance
    const { getAnalyticsProperty } = await import('$lib/server/analytics');

    const result = await getAnalyticsProperty('1');
    expect(result?.name).toBe('Test');
  });
});
```

### Key Points

1. **`vi.resetModules()`** - Clears vitest's module cache so the next import gets a fresh module
2. **Dynamic imports** - Use `await import()` inside tests, not top-level imports
3. **Mock factory function** - Return the mock object from a function to get the current value
4. **Populate mocks in `beforeEach`** - Create fresh mock objects for each test

### When This Pattern is Needed

This affects all SMRT modules that use the singleton collection pattern, including:
- `smrt-analytics`
- `smrt-affiliates`
- `smrt-users` (UserCollection, TenantCollection, etc.)
- `smrt-profiles`
- Any custom collections built on SMRT

### Alternative: Dependency Injection

For new code, consider using dependency injection instead of module-level singletons:

```typescript
// Instead of module-level cache
export async function listAnalyticsProperties(
  collection?: AnalyticsPropertyCollection
): Promise<AnalyticsProperty[]> {
  const coll = collection ?? await getDefaultCollection();
  return coll.findAll({});
}

// In tests - pass mock directly, no resetModules needed
it('should list properties', async () => {
  const mockCollection = { findAll: vi.fn().mockResolvedValue([...]) };
  const result = await listAnalyticsProperties(mockCollection);
  expect(result).toHaveLength(1);
});
```

## Development

```bash
# Build
pnpm build

# Type check
pnpm typecheck
```
