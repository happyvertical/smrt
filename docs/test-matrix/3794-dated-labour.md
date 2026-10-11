# #3794 — dated labour snapshots

Additive feature; no schema or legacy resolver behavior change. Financial exactness
and tenant/worker identity are the named risks. Host authorization is required;
the resolver checks the supplied identity against the entry, not session grants.

| Behavior / invariant | Reachable trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | Contract edge | Level | Validation |
|---|---|---|---|---|---|---|---|---|---|
| Explicit calendar date and effective interval | Construct resolver | Leap day and adjacent half-open periods | Invalid date, overlap, empty schedule, gap, duplicate periods | Authorized host | N/A: pure calculation | Node | No clock or implicit date | Unit | Package test |
| Exact separate commercial math | Resolve seconds or decimal hours | Half-up ties, fractional rates, nonbillable cost | Invalid/unsafe rate, hours, total, currency | Matching human worker/tenant | N/A: pure calculation | Node | Decimal strings and minor-unit output | Unit | Package test |
| Identity and private terms | Resolve an entry | Matching identity, client-only provenance | Wrong tenant, worker or participant kind; malformed billability | Host owns authorization | N/A: no reads/writes | Node | Customer excludes compensation | Unit | Package test |
| Frozen snapshots and corrections | Service submit/approve/correct | Persist IDs/versions, retry once, correction preserves original | Attempted snapshot mutation; preflight failure leaves submitted | Tenant-scoped host | Existing ServiceEvidenceService executor; approval is resumable, not transactional | SQLite and PostgreSQL | Existing lifecycle, no new persistence | Integration | Package test and test:postgres |
| Mutable caller input and partial retry | Approval with snapshot-write failure | Resolver defensively copies schedule; same explicit terms on retry | Changed caller object cannot alter selected facts | Same authorized host | Existing resumable lifecycle; no new atomicity promise | SQLite and PostgreSQL | Host must retain original resolver terms across reconstructed retries | Integration | Package test and test:postgres |

Commands: `pnpm --filter @happyvertical/smrt-timesheets test`, `test:postgres`,
`typecheck`, `build`; compatibility suites for projects and support per package
AGENTS. Root integration/review belongs to the Release 1 coordinator.

Validation evidence (2026-10-11). Logs are outside the tree at
`/home/will/.local/state/happyvertical/tradeschief-277-release1/timesheets`.
Base regression comparison N/A: new opt-in resolver with no prior behavior.


- `test-final.log`: full timesheets suite, 127 passed; 10 PostgreSQL-gated skips
  executed separately below. Covers every pure contract row and SQLite lifecycle.
- `postgres.log`: complete documented PostgreSQL lane, 53 passed, including
  both new approval/correction and identity-preflight cases. Invoked with
  `CI_POSTGRES_BASE_URL=postgresql://will@127.0.0.1:55479/postgres`; the documented
  harness creates/drops an isolated database. No mock database or skipped gate.
- `typecheck.log`: TypeScript and Svelte check passed, zero errors/warnings.
- `package-build.log`: documented timesheets package build passed.
- `knowledge.log`: changed-package strict knowledge freshness passed after
  normal graph generation; `format.log` and `git diff --check` passed.
- `install.log`: normal workspace install passed. `build.log` is a deliberately
  cancelled full workspace build at coordinator request to bound shared memory;
  it is not a passing full-build claim. Coordinator owns final combined build.
- `projects-final.log`: complete Projects compatibility suite, 171 passed.
- `support-final.log`: complete Support compatibility suite, 175 passed, three
  pre-existing environment-gated skips. The migration-plan/no-DDL cases passed.
  Initial compatibility runs lacked built board/projects/support artifacts after
  the coordinated cancellation; normal `smrt-svelte`, Projects and Support builds
  restored those artifacts (`svelte-build.log`, `projects-build.log`,
  `support-build.log`) before these passing reruns.

No schema/migration, generated transport, or UI contract changed. Financial
checks use real SQLite/PostgreSQL persistence and the existing resumable approval
executor; no new transaction or rollback guarantee is introduced. Reconstructed
approval retries must retain their original authorized host date/rate input.

## Provider-earning semantic correction

The existing public `ServiceCompensationSnapshot.amount` means provider earnings,
not employer loaded cost. The dated resolver must preserve that meaning.

| Behavior / invariant | Reachable trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | Contract edge | Level | Validation |
|---|---|---|---|---|---|---|---|---|---|
| Provider amount excludes employer burden | Approve nonbillable labour, then read persisted compensation.amount | Wage 6003; private burden 1001 and loadedCostMinor 7004 | Legacy wage+burden amount must fail the provider read assertion; loaded sum overflow still rejected | Authorized tenant/worker | Existing resumable approval executor | SQLite and PostgreSQL | Provider earning remains payable amount; loaded costing uses private terms | Unit + integration | Full timesheets test / test:postgres |

Correction evidence (same external log directory):

- `earning-regression-base.log`: new persisted-provider-read assertion fails on
  the prior implementation: expected 6003, received 7004 (one failure/one pass).
- `earning-test.log`: full timesheets suite passes, 127 passed and 10
  PostgreSQL-gated skips; includes the now-passing persisted-provider regression.
- `earning-typecheck.log`: TypeScript/Svelte checks pass, zero errors/warnings.
- `earning-postgres.log`: all 53 PostgreSQL tests pass, including the persisted
  provider-amount, private loaded-cost, approval-retry and correction assertions.
- `earning-build.log`: normal package build passes. Commands ran sequentially.

Original validation above describes the initial implementation; these correction
logs and results supersede its amount semantics. No schema or existing resolver
contract changed; provider earnings and employer loaded cost remain distinct.
