# @happyvertical/smrt-vitest

Vitest plugin for SMRT projects - **REQUIRED** for all SMRT tests.

## Features

- **Auto-generates manifests** at vitest startup - no need to run `smrt test` first
- **Loads cross-package manifests** from SMRT dependencies
- **Transaction isolation** utilities for parallel-safe database tests

## Installation

```bash
pnpm add -D @happyvertical/smrt-vitest
```

## Usage

### Required Plugin Setup

**Every SMRT project MUST include this plugin in vitest.config.ts:**

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

Without this plugin, tests fail with errors like:
- `Cannot generate schema for unregistered class 'MyClass'`
- `No field metadata found for 'MyClass'`

### Running Tests

```bash
# Correct - vitest plugin auto-generates manifest
npx vitest
npx vitest run
npm test

# Deprecated - no longer needed
smrt test  # Shows deprecation warning but still works
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `generateManifest` | `boolean` | `true` | Auto-generate manifest at startup |
| `include` | `string[]` | `['src/**/*.ts']` | Source patterns to scan |
| `exclude` | `string[]` | `['**/*.d.ts', ...]` | Patterns to exclude |
| `packages` | `string[]` | `[]` | Additional packages to load |
| `verbose` | `boolean` | `false` | Enable detailed logging |
| `root` | `string` | `process.cwd()` | Root directory |

### Example with Options

```typescript
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';

export default defineConfig({
  plugins: [
    smrtVitestPlugin({
      // Disable auto-generation (use pre-built manifest)
      generateManifest: false,
      // Additional packages beyond auto-discovered
      packages: ['@my-org/custom-smrt-package'],
      // Enable verbose logging
      verbose: true,
    }),
  ],
});
```

## Transaction Isolation for Parallel Tests

Use `createIsolatedTestDb` for reliable parallel test execution:

```typescript
import { createIsolatedTestDb } from '@happyvertical/smrt-vitest';
import { beforeEach, afterEach, it, expect } from 'vitest';

let db, cleanup;

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
```

### Benefits

- **Complete isolation**: Each test runs in its own transaction
- **Fast**: No table drops/recreates between tests
- **Parallel-safe**: Multiple tests can run simultaneously
- **Works with PostgreSQL in CI**: Eliminates SQLite concurrency issues

## Test Database Utilities

| Function | Description |
|----------|-------------|
| `createIsolatedTestDb()` | Create DB with transaction isolation (recommended) |
| `createTestDb()` | Create DB with cleanup function (no isolation) |
| `getTestDbConfig()` | Get DB config for current environment |
| `getTestAdapter()` | Detect adapter: 'postgres' or 'sqlite' |

## Watch Mode Note

The manifest is generated once at vitest startup. If you add new classes or fields while vitest is running in watch mode, restart vitest to pick up the changes.

## License

MIT
