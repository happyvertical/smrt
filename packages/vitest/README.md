# @happyvertical/smrt-vitest

Vitest plugin for SMRT projects -- **required** for all SMRT tests. Auto-generates manifests, loads cross-package class metadata, and provides transaction-isolated test database utilities.

## Installation

```bash
pnpm add -D @happyvertical/smrt-vitest
```

## Usage

### Required Plugin Setup

Every SMRT project must include `smrtVitestPlugin()` in vitest.config.ts:

```typescript
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';

export default defineConfig({
  plugins: [smrtVitestPlugin()],
});
```

Without this plugin, tests fail with `"No field metadata found"` or `"unregistered class"` errors.

### Plugin Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `generateManifest` | `boolean` | `true` | Auto-generate manifest at startup |
| `include` | `string[]` | `['src/**/*.ts']` | Source patterns to scan |
| `exclude` | `string[]` | `['**/*.d.ts', ...]` | Patterns to exclude |
| `packages` | `string[]` | `[]` | Additional packages beyond auto-discovered |
| `verbose` | `boolean` | `false` | Enable detailed logging |
| `root` | `string` | `process.cwd()` | Root directory |

### Watch Mode Note

The manifest is generated once at vitest startup. Restart vitest after adding new `@smrt()` classes or fields.

## API

### Plugin

| Export | Description |
|--------|-------------|
| `smrtVitestPlugin(options?)` | Vite plugin -- generates manifest and loads cross-package classes |
| `setupSmrtManifests(options?)` | Imperative alternative for non-Vite setups (e.g., globalSetup files) |

### Test Database Utilities

| Export | Description |
|--------|-------------|
| `createIsolatedTestDbFromManifest(options?)` | Create DB from manifest with FK ordering and STI dedup (recommended) |
| `createIsolatedTestDb(options?)` | Create DB with raw DDL schema and transaction isolation |
| `createTestDb(prefix?)` | Create DB with cleanup function (no transaction isolation) |
| `getTestDbConfig(prefix?)` | Get DB config for current environment |
| `getInMemoryDbConfig()` | Get in-memory SQLite config |
| `getTestAdapter()` | Detect adapter: `'postgres'` or `'sqlite'` |
| `getAdapterDisplayName()` | Human-readable adapter name for test labels |
| `isPostgresAvailable()` | Check if `DATABASE_URL` is set |

DB adapter auto-detection: `DATABASE_URL` set -> PostgreSQL; otherwise -> SQLite temp files.

### Transaction Isolation Example

```typescript
import { createIsolatedTestDb } from '@happyvertical/smrt-vitest';

let db, cleanup;

beforeEach(async () => {
  ({ db, cleanup } = await createIsolatedTestDb({
    schema: `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)`
  }));
});

afterEach(async () => {
  await cleanup(); // Rolls back transaction
});

it('should insert and query', async () => {
  await db.insert('users', { id: '1', name: 'Alice' });
  const user = await db.get('users', { id: '1' });
  expect(user?.name).toBe('Alice');
});
```

### Types

`IsolatedTestDbOptions`, `IsolatedTestDbResult`, `ManifestTestDbOptions`, `TestDbAdapter`, `TestDbConfig`, `TransactionHandle`

## Dependencies

- `@happyvertical/smrt-core` -- manifest builder, object registry
- `@happyvertical/sql` -- database connections and transactions
- `vitest` (peer) -- Vite test framework

## License

MIT
