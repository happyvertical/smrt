# #3966 education catalog test matrix

| Behavior / invariant | Executable evidence | Dialect |
| --- | --- | --- |
| Service authorization, private-course filtering, answer URL/key redaction, deterministic order request | `src/__tests__/catalog-service.test.ts` | SQLite unit/service |
| Real family/ancestor/global scope excludes sibling | `CatalogService tenant integration` in `catalog-service.test.ts` | SQLite |
| Personal-copy tenant/license pin, child tenant mismatch, equal-sort ID order | `catalog.optional.test.ts` via `test:postgres` | PostgreSQL |
| Focused catalog persistence | `initializes catalog records on DuckDB with the focused schema selector` | DuckDB |
| Generated surfaces closed / model metadata | `catalog-models.test.ts` | Node |
| Browser registration and capability artifact | bundle gate suite | Node/browser fixture |
