# #3966 education catalog test matrix

| Behavior / invariant | Executable evidence | Dialect |
| --- | --- | --- |
| Service authorization, private-course filtering, answer URL/key redaction, deterministic order request | `src/__tests__/catalog-service.test.ts` | SQLite unit/service |
| Real family/ancestor/global scope excludes sibling | `CatalogService tenant integration` in `catalog-service.test.ts` | SQLite |
| Personal-copy tenant/license pin, child tenant mismatch, equal-sort ID order | `catalog.optional.test.ts` via `test:postgres` | PostgreSQL |
| DuckDB catalog lane | Not executable: shared users dependency emits unsupported `ON UPDATE CASCADE` FK in DuckDB (`api_keys.profile_id`) before catalog schema; PostgreSQL/SQLite cover supported catalog persistence | Blocked upstream dialect limitation |
| Generated surfaces closed / model metadata | `catalog-models.test.ts` | Node |
| Browser registration and capability artifact | bundle gate suite | Node/browser fixture |
