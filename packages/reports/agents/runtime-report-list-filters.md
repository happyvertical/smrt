# Runtime report list predicates (#3758)

`listRuntimeReports({ db, tenantId, createdByUserId, specHash, status, limit })`
accepts optional exact author and normalized-spec-hash filters. All supplied
predicates are applied by the collection before its result limit, ANDed with
status (default active), explicit owner tenant and ambient tenancy. These are
selection predicates, never permissions or an authorization bypass. An app must
provide the authenticated principal's identity and retain its live authority
checks before reading or running a saved report. The spec hash comes from the
public compiler, not a client-supplied authority proof. Omitted options preserve
existing behavior; empty supplied values match exactly rather than dropping the
predicate.

| Behavior / invariant | Trigger | Positive | Negative | Actor / context | Executor / transaction | Runtime / dialect | External edge | Test level / validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Author isolation before limit | List own saved specs | Exact author gets own report with limit 1 | Other authors and empty author excluded | Tenant A/B principals; ordinary/system ambient contexts | RuntimeReportCollection read; mutation transaction N/A | Node26 / SDK SQLite test fixture; collection predicates dialect-neutral | Public optional values | Package runtime-report.test.ts |
| Exact retry lookup | List author + compiled specHash | Normalized spec locates matching prior save | Other spec/hash, other tenant, archived status excluded | Explicit author and tenant | Same collection query, conjunctive filters | Node26 / SDK SQLite test fixture | Compiler-owned spec hash; unknown strings yield no match | Package runtime-report.test.ts |
| Existing list contract | Omit new filters | Existing tenant/status and cap preserved | Explicit other tenant remains absent under system context | Existing principal tenancy | N/A mutation: list is read-only | Existing package test fixture | No new capability or permission | Existing package runtime-report.test.ts |

Run `pnpm --filter @happyvertical/smrt-reports exec vitest run src/__tests__/runtime-report.test.ts`.
This is additive API behavior, so base bug regression evidence is N/A. Native SQL
semantics are N/A for this extension: existing collection equality and tenancy
implementations own dialect behavior; no SQL generator or dialect branch changes.
Cross-repository coordinator owns the complete release checks and exact-head review.

Evidence: focused runtime-report storage/compiler suite passes all 77 tests,
including the two new predicate cases; Biome passes the changed TypeScript files.
Full output is retained outside the repository in the release coordinator's
`search/upstream-reports-unit.log` and `search/upstream-format.log` evidence files.
An explicit tenant mismatch in ordinary tenant context retains its established
`TenantIsolationError`; a mismatched explicit tenant in system context returns
no rows. Neither new predicate changes that boundary.
