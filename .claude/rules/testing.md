## SMRT Testing Conventions

### Required Setup
`vitest.config.ts` MUST include `smrtVitestPlugin()` in plugins array. Without it: "No field metadata" errors.

### Timeouts
Never set `testTimeout` without also setting `hookTimeout` — hooks do NOT inherit it and stay on vitest's 10s default. Symptom: the file fails with "Hook timed out in 10000ms" while every test reports *skipped*. Budget for where the work happens: setup that spawns processes or generates code is bounded by `hookTimeout`, not `testTimeout`.

### Database
- Use real in-memory SQLite for SmrtObject/SmrtCollection tests
- `createIsolatedTestDb()` for transaction-isolated tests (rolls back on cleanup)
- `createIsolatedTestDbFromManifest({ includeObjects: ['Product'] })` for schema-aware isolation
- Never mock database operations

### Mocking Policy
- Mock ONLY external API calls (`@happyvertical/ai`, HTTP requests)
- Never mock Agent instances, SmrtObject, SmrtCollection, or business logic
- Test generators, not generated output

### File Naming
- `*.test.ts` — unit tests
- `*.spec.ts` — integration tests
- `*.optional.test.ts` — requires external APIs (skipped in CI)

### Patterns
- Descriptive test names that read as user stories
- Bug fixes require regression tests (BDD/TDD)
- Proper cleanup in `afterEach`/`afterAll`
- `vi.resetModules()` + dynamic import for testing module-level singleton caches
- Manifest generated once at startup — restart vitest after adding new `@smrt()` classes
