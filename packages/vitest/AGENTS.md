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

## CI retry (flaky-test resilience)

The plugin injects `test.retry` into every consuming package's config: **2 in CI
(`process.env.CI`), 0 locally** (`resolveCiRetry`). Several packages have rare,
CI-environment-specific timing flakes that pass on re-run (none reproducible
locally); retry keeps the shared cross-package "Test Packages" job reliable
without masking real failures — a deterministic failure still fails all attempts,
and vitest flags retried tests as `flaky`. Local runs keep retry at 0 so flakes
surface during development. Override with `SMRT_VITEST_RETRY=<n>`.

Packages that don't use `smrtVitestPlugin` (notably `cli`, plus `core`) set the
same `retry` policy inline in their own `vitest.config.ts`.

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

## Svelte component testing (S11 #1416)

Shared component-test harness so any UI package can render Svelte components, drive
them, and assert a11y — without copying setup or adding Testing Library deps
(smrt-vitest carries `@testing-library/{svelte,jest-dom,user-event}` + `axe-core`).

Wire it into a package's `vitest.config.ts` (keep `environment: 'node'` as default
so DB tests are unaffected — the harness only activates under a DOM):

```typescript
test: {
  environment: 'node',
  setupFiles: [smrtVitestSetupPath, '@happyvertical/smrt-vitest/svelte-setup'],
}
```

`svelte-setup` adds jest-dom matchers, Testing Library auto-cleanup, and a jsdom
`<dialog>` `showModal`/`close` polyfill — guarded behind a `document` check, so it
is inert in node-environment test files.

Component tests opt into the DOM per-file and import the whole surface from one place:

```typescript
// @vitest-environment jsdom
import { render, screen, userEvent, expectNoA11yViolations }
  from '@happyvertical/smrt-vitest/svelte';

const { container } = render(MyComponent, { props });
await userEvent.click(screen.getByRole('button', { name: 'Save' }));
await expectNoA11yViolations(container); // axe; color-contrast off (jsdom can't paint)
```

Exports: `./svelte` (render/screen/fireEvent/within/userEvent + `expectNoA11yViolations`),
`./svelte-setup` (the setupFiles entry), `./a11y` (just the axe helper). The plugin
aliases these subpaths to source for workspace consumers (`getWorkspaceViteAliases`).
Pattern: render → assert role/name/state → drive with user-event → prove axe-clean.

## Key Files

- `src/index.ts` — Vite plugin, manifest generation, workspace aliases, all exports
- `src/setup.ts` — globalThis isolation setup file
- `src/svelte-setup.ts` — Svelte component-test setup (jest-dom, cleanup, dialog polyfill)
- `src/svelte.ts` — component-test surface (Testing Library + a11y, one import)
- `src/a11y.ts` — `expectNoA11yViolations` (axe-core)
- `src/test-db.ts` — createIsolatedTestDb, createIsolatedTestDbFromManifest, createTestDb
