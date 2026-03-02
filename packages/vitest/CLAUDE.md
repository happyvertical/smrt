# @happyvertical/smrt-vitest

Vitest plugin for manifest generation and test database utilities. **Required for all SMRT projects.**

## Plugin Setup

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';
export default defineConfig({
  plugins: [smrtVitestPlugin()],
  test: { setupFiles: ['@happyvertical/smrt-vitest/setup'] } // optional: globalThis isolation
});
```

Without the plugin → "unregistered class" / "No field metadata found" errors.

## What the Plugin Does

1. Scans `src/**/*.ts` for SMRT classes via ManifestBuilder
2. Discovers `@happyvertical/smrt-*` dependencies from package.json
3. Loads external manifests via ManifestManager
4. Registers all classes in ObjectRegistry
5. Watch mode caveat: manifest only generated at startup — restart vitest after adding new classes/fields

## Test Database Utilities

| Function | Use Case |
|----------|----------|
| `createIsolatedTestDbFromManifest()` | Multi-table tests — auto-creates schema from manifest with FK ordering and STI dedup |
| `createIsolatedTestDb({ schema })` | Single-table tests — pass raw DDL |
| `createTestDb()` | No transaction isolation (legacy) |
| `getTestDbConfig()` | Get DB config for current environment |

**DB adapter auto-detection**: `DATABASE_URL` set → PostgreSQL; otherwise → SQLite temp files.

```typescript
let db, cleanup;
beforeEach(async () => {
  ({ db, cleanup } = await createIsolatedTestDbFromManifest());
});
afterEach(async () => { await cleanup(); }); // rolls back transaction
```

## Singleton Cache Gotcha

Module-level singleton caches (common in SMRT collections) persist across tests, ignoring new mocks.

**Fix**: `vi.resetModules()` in beforeEach + `await import(...)` in each test (not top-level imports).

## Key Files

- `src/index.ts` — Vite plugin, manifest generation, all exports
- `src/setup.ts` — globalThis isolation setup file
- `src/test-db.ts` — createIsolatedTestDb, createIsolatedTestDbFromManifest, createTestDb
