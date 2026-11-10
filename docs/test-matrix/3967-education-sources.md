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

## Accepted round-1 parser regressions

- **Accepted — Astra (P2):** non-lesson bold instructions ended a lesson's
  segment, causing a valid printable URL to disappear on refresh. The parser
  now delimits only validated lesson headings; real SQLite/PostgreSQL refresh
  tests require the existing worksheet ID to receive the new PDF URL.
- **Accepted — Opus (medium):** ignored second bold markers or markers in
  unsupported containers could attach another day's PDF to the prior lesson.
  Every recognizable marker must be accounted for. Ambiguous multi-marker
  paragraphs and unsupported div/td/span layouts fail before persistence.
  Real SQLite/PostgreSQL tests assert unchanged course/lesson rows and no new
  course for both refresh and initial-import attempts.

Both regression groups are run against covered head
`d71113876ad52c2e6da21d04e8e0e89848114bf2`'s parser to establish failing
baseline behavior, then against the correction. This is a bounded parser
correction: the full root suite already passed on the covered head; round 2
reruns the affected package, PostgreSQL, build/typecheck, browser boundary,
static and knowledge gates rather than an unrelated full-root test rerun.

## Accepted round-2 structural heading regression

**Accepted — Opus (medium):** ignoring non-lesson h1–h6 headings allowed
trailing Resources PDFs to become the last lesson's printable pointer. Structural
headings again delimit segments; ordinary bold instructions remain ignored and
unaccounted lesson markers still fail closed. A parser case and real SQLite/PG
refresh case verify the Resources URL never replaces a lesson pointer. Both new
cases fail against round-2 head `122af228052078da82d474db66f00ad3b099291f`.
The bounded round-3 gates and inherited full-root coverage are recorded in the
review packet; only the accepted regression is changed.

## Accepted external PR feedback (round 4)

Both P2 findings are accepted: generic Printable/Printables labels were
misclassified as course packets, and the href matcher read data-href metadata.
Packet recognition now requires packet-specific wording; href names must begin
at the attribute list or after HTML whitespace. Parser and real SQLite/PG
refresh cases cover generic singular/plural labels, metadata preceding a real
href, and metadata without any navigable href. Four new tests fail against
covered head `4d3cb14587c9c3dd60dd2e1bffdf150f51e61049`.
