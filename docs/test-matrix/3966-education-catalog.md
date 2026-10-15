# #3966 education catalog test matrix

| Behavior / invariant | Executable evidence | Dialect |
| --- | --- | --- |
| Service authorization, private-course filtering, answer URL/key redaction, deterministic order request | `src/__tests__/catalog-service.test.ts` | SQLite unit/service |
| Real family/ancestor/global scope excludes sibling | `CatalogService tenant integration` in `catalog-service.test.ts` | SQLite |
| Personal-copy tenant/license pin, child tenant mismatch, equal-sort ID order | `catalog.optional.test.ts` via `test:postgres` | PostgreSQL |
| Focused catalog persistence | `initializes catalog records on DuckDB with the focused schema selector` | DuckDB |
| Generated surfaces closed / model metadata | `catalog-models.test.ts` | Node |
| Browser registration and capability artifact | bundle gate suite | Node/browser fixture |

## Accepted security review regressions

| Behavior / invariant | Reachable trigger; positive / negative case | Actor / ownership / context | Executor / transaction | Runtime / dialect | External edge / test level | Validation |
| --- | --- | --- | --- | --- | --- | --- |
| Private copies require exact active owner | Guardian requests private catalog; own draft allowed, ancestor/sibling/global private rows denied in list and projection | Authorized guardian in child family, with real ancestor scope | Real SQLite database; read-only, atomicity N/A | Node / SQLite | Host permission grant cannot grant another owner's private copy; integration | education `test` |
| Projection rejects mismatched child owners | Existing hostile section, lesson, asset links; aligned rows retained, ancestor/global owners excluded at every level | Family guardian, own course, real ancestor/global read scope | Real SQLite database; injected stored corruption; read-only, rollback N/A | Node / SQLite | Saved-row guards cannot protect existing hostile rows; integration | education `test` |
| Personal copies cannot be published | Create published copy or publish existing draft; draft/archived allowed, published rejected with unchanged persisted state | Owning tenant author | Real database collection create/update; reject before write, no multiwrite transaction | Node / SQLite, DuckDB, PostgreSQL | Supported save/update API; integration | education `test`, `test:postgres` |
| Native UUID owner guards | Unchanged personal-copy save and matching/null-owned children allowed; changing owner/license rejected | Owning author, other tenant, global rows | Real DB identity+tenant predicate; rejection before write | Course: SQLite/DuckDB/PostgreSQL; children/assets: SQLite/PostgreSQL | Native UUID driver's raw value is not a JS string; integration | education `test`, `test:postgres` |

Family/group classification is a host provisioning and authorization decision:
the shared Tenant model has no tenant-kind discriminator. The enforceable package
boundary is exact owner tenant identity, independent of hierarchy or host labels.

DuckDB coverage is deliberately limited to reachable Course-only schema setup.
Existing core DDL validation rejects `course_sections.course_id` with ON UPDATE
CASCADE, Tenant self-references, and `assets.primary_version_id` self-references.
Full child/asset and hierarchy fixtures cannot initialize on that engine without
changing the existing contract. Those gates remain intact; SQLite/PostgreSQL
exercise child and asset owner guards, and SQLite exercises the real hierarchy.

## External review regressions (cycle 6185011513, round 4)

| Behavior / invariant | Reachable trigger; positive / negative case | Actor / context | Executor / transaction | Runtime / dialect | Contract edge / test level | Validation |
| --- | --- | --- | --- | --- | --- | --- |
| Video retains its URL | Construct/create/reload Video with nonempty URL; default remains empty | Owning author and persisted lesson | Real collection/database; one-row save, no multiwrite transaction | Node / SQLite, PostgreSQL; DuckDB child DDL unavailable | Derived field initialization must not lose input; integration | education `test`, `test:postgres` |
| Authorization filtering precedes pagination | Hidden ancestor/global personal rows sort before visible rows; limit/offset yield full authorized pages including own private only with grant | Family guardian/learner, real ancestor scope | Read-only real database; transaction N/A | Node / SQLite, PostgreSQL; DuckDB Tenant DDL unavailable | Collection SQL filtering before bounds, no foreign visibility; integration | education `test`, `test:postgres` |
| LessonAsset natural identity includes owner | Same-owner and global/null-owner repeated link adopts same id; hostile other-owner collision preserves foreign row and allows legitimate owner link | Owning tenant, foreign stored row, global context | Real generated unique index and natural-key save; existing core refuses foreign overwrite | Node / SQLite, PostgreSQL; DuckDB Asset DDL unavailable | Explicit conflict target is not automatically scoped; schema/integration | education `test`, `test:postgres`, build |

Video's failing-before assertion is the immediate constructor value; initialized
saves and collection hydration already restored the option and remain covered.
Pagination includes selected-column JavaScript options and an attempted runtime
`where` override; the service predicate wins. PostgreSQL fixtures use the supplied
transaction executor and roll back between tests. The asset-key regression proves
an existing cross-owner denial, not an overwrite: core already refused that write.
