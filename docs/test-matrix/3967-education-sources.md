# #3967 source import behavior matrix

New feature, not a bug fix: baseline failure comparison is N/A because no source
model, parser or importer exists on the catalog base. All tests use synthetic
HTML and injected fetch functions; no external requests. Host authorization is a
trusted integration contract, never an untrusted request-level boolean.

| Behavior/invariant | Trigger; actor/context | Positive / negative case | Executor/transaction; dialect | External edge; level | Command |
| --- | --- | --- | --- | --- | --- |
| Pointer-only parsing | Local course HTML | Lesson days/markers/PDFs; duplicate, malformed, unsafe or ambiguous input rejected | N/A pure function; Node | HTML/URL contract; unit fixtures | education test |
| Opt-in terms | Host registration then import | accepted host config; absent/false registration denied before fetch | SQL read; SQLite/PostgreSQL | fetch injected; integration | education test / test:postgres |
| Actor isolation | Import in active tenant/user scope | matching authorized guardian; sibling, actor mismatch, no scope, bypass and host denial rejected | source reads and writes scoped to actor; SQLite/PostgreSQL | host family/group classification; integration | education test / test:postgres |
| Source sharing ceiling | private/group/global policy × private/group target | narrower destinations allowed; private→group, absent licensing, unknown policy and global destination denied | policy rechecked in transaction; SQLite/PostgreSQL | host licensing decision; integration | education test / test:postgres |
| Idempotent refresh/history | repeat import, change URL, omit a day | same course/lesson IDs; no history/retired-day deletion or private promotion | transaction-bound collections, real FK history sentinel; SQLite/PostgreSQL | future learner model FK contract; integration | education test / test:postgres |
| Atomicity | malformed source or later write failure | full successful import; malformed parse or injected second-lesson failure leaves prior state intact | real rollback; SQLite/PostgreSQL | host HTML failure; integration | education test / test:postgres |
| Contention/retry | concurrent import and rolled-back retry | one identity; retry once then bounded exhaustion/nonretry error | embedded queue / PG advisory lock, real transactions; SQLite/PostgreSQL | fetch occurs once; integration | education test / test:postgres |
| Private catalog | imported family course projected | owner's separately authorized read; sibling/ancestor and ordinary reads denied | real CatalogService/TenantCollection; SQLite/PostgreSQL | existing tenant read capability; integration | education test / test:postgres |
| Public package/browser boundary | Consumers import package root | Built exports resolve; Node-only imports rejected by bundle gate | N/A no persistence; Node/browser bundle | Packed exports and isolated consumer compile/import | education verify:pack; bundle-gate browser-boundary.spec.ts |
| Closed generated surface | CourseSource metadata | API/CLI/MCP disabled | N/A no generated operation; Node | registry contract; unit | education test |

`education` means `pnpm --filter @happyvertical/smrt-education`.
No new learner/progress/submission models are included in this issue. History
preservation uses an actual foreign-key sentinel and unchanged linked catalog
records rather than claiming to execute unimplemented learner workflows.
DuckDB full-import coverage is blocked by the catalog base's existing core DDL
limitations (ON UPDATE CASCADE and Tenant self-FK); source import does not claim
full DuckDB support or substitute a weaker schema. JSON export executors are not
transactional import databases. Network timing/HTTP failures are injected.

Documented root validation: `pnpm install`, `pnpm build`, `pnpm test`,
`pnpm typecheck`, `pnpm lint`, `pnpm format-check`,
`pnpm knowledge:check --strict --format markdown`, `pnpm audit:policy`.
The review packet records exact commands, current-head evidence files and hashes.
