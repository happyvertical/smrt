# Scoped fact reconciliation (#3496)

High risk: same-tenant confidential candidate isolation. An application authorizes the caller and selects an opaque access scope; the token is a partition, not an authorization credential. Legacy NULL is a separate partition, not public. No automatic classification from source metadata. Owner reclassification requires reconciliation writers stopped. Standard schema migration adds nullable Fact.accessScope before new writers run. Existing source metadata and fact provenance remain intact.

Acceptance: exact and semantic candidates match tenant plus access scope before candidate hydration, ranking and disambiguation. Newly created and branched facts retain scope. Default reconciliation selects legacy NULL only. Different scopes cannot converge or supersede one another. Invalid tokens fail before persistence/providers. Public typed list/get predicates support scoped reuse. Concurrent retries and source-write failures retain transaction semantics.

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level | Command |
|---|---|---|---|---|---|---|---|---|---|
| Exact isolation and retry | identical claim | same scope converges | other scope/tenant excluded | tenant A/B and explicit context | real collection transaction | Node26 SQLite/PostgreSQL | optional NULL legacy | integration | package test; scoped PG suite |
| Semantic isolation before ranking/AI | paraphrase | eligible candidate merges/branches | higher-ranked private candidate never hydrated/disambiguated | tenant A; public/private | real persisted vectors/query | SQLite/PostgreSQL | deterministic embedding provider | integration | scoped suite |
| Scope propagation | create/branch | returned and persisted scope retained | explicit branch scope switch rejected | same tenant | collection transaction | SQLite/PostgreSQL | malformed scope | integration | scoped suite |
| Legacy and migration | omitted/null scope and existing rows | NULL rows reconcile | NULL cannot consume explicit scoped rows | legacy caller | real schema/public create | SQLite/PostgreSQL | no implicit metadata classification | integration | scoped suite |
| Failure/concurrency | concurrent claims/source failure | one identity converges | rollback leaves no partial fact/source | same tenant/scope | distinct collections and real transaction | SQLite/PostgreSQL | provider unavailable | integration | scoped and existing exact suites |
| Public contract/reuse | downstream typed import | public options and scoped list/get compile | invalid tokens fail closed | authorized application | public collection APIs | Node26 TS | token is not ACL authorization | consumer/typecheck | package build/typecheck/verify:pack |

Executable cases live in `packages/facts/src/__tests__/reconcile-scope.test.ts`; the PostgreSQL command also runs the existing concurrent exact-reconciliation and confidence persistence suites. The new suite proves historical-schema migration leaves old rows NULL. Public consumer compilation uses only the package export and typed list/get predicates. Base comparison on 55bd09fec fails seven of nine SQLite cases with the final regression source; the active-tenant and generic migration fixtures pass on both.

Validation artifacts are captured in `/tmp/smrt3496-evidence`; final review evidence binds their hashes to the committed head. SQLite partial source-write failure is intentionally tested as convergent retry; atomic rollback is guaranteed/tested only on PostgreSQL, preserving the existing dialect contract. DuckDB canonical Fact persistence is unsupported by its self-referencing foreign-key constraint (see the existing catalog dialect fixture); no DuckDB reconciliation support is claimed. UI/browser gates are N/A: this package has no maintained UI harness. Remote required CI is a post-publication gate. No live AI or real databases are used.

## External review P1 r4178842011 (round 2)

Accepted: ordinary authenticated generated REST/MCP writes could mass-assign
`accessScope`, bypassing the documented owner-only reclassification procedure.
The field must be server-managed in generated input policy while trusted server
collection writes, reconciliation, branching and operator migration remain usable.

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level | Command |
|---|---|---|---|---|---|---|---|---|---|
| Generated write boundary | REST POST/PUT/PATCH and MCP create/update | ordinary text edits succeed | forged create scope stripped; private-to-public update stripped | authenticated ordinary editor, active tenant | real collection and SQLite persistence through generated handlers | Node26/SQLite; policy strips input before dialect persistence | same REST/MCP public API; no blanket write disable | integration | pnpm --filter @happyvertical/smrt-facts exec vitest run src/__tests__/access-scope-api.test.ts |
| Trusted server writes | reconcile, branch and operator migration | explicit scope persists and branch inherits; controlled server migration can classify legacy row | generated callers cannot invoke the operator procedure | trusted tenant service and system-context owner with writers stopped | real SQLite; existing scoped PostgreSQL persistence gate unchanged | Node26/SQLite and existing PostgreSQL gate | readonly is generated-input policy, not a database immutability flag | integration | same generated-boundary suite plus registered test:postgres |
