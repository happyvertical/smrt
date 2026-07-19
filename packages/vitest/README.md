# @happyvertical/smrt-vitest

Vitest plugin for s-m-r-t projects -- **required** for all s-m-r-t tests. Auto-generates manifests, loads cross-package class metadata, and provides transaction-isolated test database utilities.

## Installation

```bash
pnpm add -D @happyvertical/smrt-vitest
```

## Usage

### Required Plugin Setup

Every s-m-r-t project must include `smrtVitestPlugin()` in vitest.config.ts:

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
| `setupFile` | `string` | package setup entry | Override the setup file injected into Vitest projects |
| `aliasFilter` | `(entry) => boolean` | keep all | Drop auto-generated workspace alias entries (receives the raw string `find` and `replacement`) |

### Vite 8 (rolldown/oxc) Normalization

Vite 8 replaced esbuild with rolldown/oxc, which changed three behaviors that
break s-m-r-t projects. The plugin normalizes all three so consuming apps don't
need per-repo workarounds (evidence: anytown.ai#707, willgriffin.dev#220):

1. **`esbuild.tsconfigRaw` is ignored** — legacy `@smrt()` decorators reach
   the bundle untransformed. The plugin injects
   `oxc.decorator = { legacy: true, emitDecoratorMetadata: true }` (plus the
   matching `oxc.tsconfig.compilerOptions` mirror).
2. **oxc elides type-position side-effect imports by default** — test files
   usually sit outside the tsconfig `include`, so a repo-wide
   `verbatimModuleSyntax` never reaches them and side-effect model imports
   (s-m-r-t object registration) are silently dropped. The plugin injects
   `oxc.typescript = { onlyRemoveTypeImports: true }`.
3. **Rolldown prefix-matches string alias `find`s** — a bare workspace alias
   like `@org/pkg` → `src/index.ts` mangles unaliased subpath imports
   (`@org/pkg/sub` → `src/index.ts/sub`). Workspace aliases are emitted as
   anchored exact-match RegExps, so unaliased subpaths fall through to the
   package exports map; use `aliasFilter` to drop entries entirely.

   > **Breaking change for direct `getWorkspaceViteAliases()` consumers:**
   > each entry's `find` is now an anchored `RegExp`, not a `string` (the
   > returned array is still ordered most-specific first, and the new second
   > `options` parameter is optional). Code that used `find` as a string —
   > e.g. a `Map` key or an equality filter — should match with
   > `entry.find.test('<specifier>')` instead. Filters passed via
   > `aliasFilter` (or the helper's `options.filter`) are unaffected: they
   > receive the raw string `find` before anchoring. Plugin-only consumers
   > need no changes.

All defaults are override-able: any `oxc` field you set in your own config is
never injected (explicit consumer values always win, and sibling fields still
deep-merge), and `oxc: false` suppresses injection entirely. The `oxc` keys
are inert on esbuild-based vite ≤ 7.

Note: the plugin only reaches configs that include it (vitest configs and any
vite config listing it in `plugins`). An app's separate build-only
`vite.config.ts` without the plugin still needs its own `oxc.decorator`
settings on vite 8.

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
