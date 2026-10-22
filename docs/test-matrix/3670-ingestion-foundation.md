# Ingestion foundation behavior-to-test matrix

Refs #3670; frozen contract: [ADR 0004](../adr/0004-application-aware-ingestion.md).
High risk: persistent tenant/confidential authority, concurrent leases and cross-system recovery.
Executed evidence is captured outside the worktree in `/home/will/Work/tmp/s3670/evidence`; the review packet records command status, file digest and reviewed revision. The foundation suite executes the same 35 cases on each real database.

Commands: U = `pnpm --filter @happyvertical/smrt-ingestion test`; P = `pnpm --filter @happyvertical/smrt-ingestion test:postgres`; T = `pnpm --filter @happyvertical/smrt-ingestion typecheck`; K = `pnpm --filter @happyvertical/smrt-ingestion build`.
Both means actual Node 26 SQLite and PostgreSQL. Every service boundary uses a server-created authenticated scope, and denies both another tenant and a missing confidential grant identically.

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Test level/command |
|---|---|---|---|---|---|---|---|---|
| Receipt identity | concurrent repeated receive | original outcome, distinct conversations | changed payload/scope conflict | owner/delegate vs unrelated/revoked, tenant/scope | unique reservation transaction | Node/both | delivery replay | integration U,P |
| Preservation recovery | fault at reservation/storage/evidence/ready | stable target adopted, all originals before ack | hash mismatch, incomplete source, lost lease | authenticated source/repair | fenced finalize; storage outside tx | Node/both | real AssetRuntime local storage | crash integration U,P |
| Dispatch repair | queue write/mark failure and queue loss | repair recreates intent delivery | duplicates/stale stage no second output | captured worker scope | ready+intent tx; public jobs enqueue | Node/both | SmrtJobCollection | integration U,P |
| Analysis revision/attempt | retry/reprocess/timed out worker | append attempts, monotonic revision and fence | stale finish, expired lease, exhausted budgets | scoped workers | item/analysis CAS on owning tx | Node/both | host stage callback, safe errors | concurrency U,P |
| Immutable foundations | publish evidence/action/plan records | stable identity and revision bindings | overwrite, cross-item reference, successful action replacement | scoped server orchestration | atomic append + CAS | Node/both | later child consumes records; no domain apply here | integration U,P |
| Retention/deletion | expiry/privacy delete/retry | revoke before delete; minimal replay/action tombstones | pending job, accessible derivative/example, reaccepted expired delivery | operator with live scope | revoke+deletion intent tx; I/O afterward | Node/both | assets and host derived-index purge | integration U,P |
| Database rollback | throw during transaction | complete transaction rolls back | detached executor partial mutation | scoped service | public transaction executor | Node/both | N/A no network inside transaction | integration U,P |
| Migrations and types | deployment before runtime | manifest/registry parity, UUID/decimal/index types | missing schema, unsupported dialect fail | deployer | migration-only DDL | Node/both | public migration API | integration U,P,K |
| Browser boundary | bundle built root and DTO | no node/provider imports | server cannot leak into root | browser consumer | N/A pure imports | browser bundle | exports | build K; type T |

Provider/component/e2e/evaluation lanes are frozen but have no implementation in this foundation child: they must fail clearly until their owning children install real suites, never pass an empty lane. The initial feature was additive; accepted review fixes include baseline-failing regression comparisons on both databases. Assets changes require its full model/UI/browser suite, build and typecheck. Root lint/format/instruction/knowledge/audit checks apply. No new UI or extraction behavior is claimed.

## Executed coverage mapping

| Matrix row | Executable cases in `src/test-support/foundation.ts` | Evidence |
|---|---|---|
| Receipt identity | preserves originals/relationships/replay/separate arrivals; concurrent reservations across real connections | U,P |
| Preservation recovery | seven boundary-fault cases plus four actual process-death cases at reserved/storage/ready/enqueued; bytes read and hashed after restart | U,P |
| Dispatch repair | deleted queue repair and concurrent stage claims; real TaskRunner dispatch to a registered scoped host worker; bounded failed dispatch attempts and visible attention | U,P |
| Analysis revision/attempt | late worker fence, terminal provenance, decimal confidence, attempt/output budgets, cancellation and reanalysis | U,P |
| Immutable foundations | explicit stable action identity; proposal expected-revision CAS; pinned attempt digest; plan revision replay; successful action refuses new proposal | U,P |
| Retention/deletion | revoke before failed purge; retry deletion; success tombstones; feedback content redaction; actual late-written object removed by next sweep | U,P |
| Database rollback | owning executor rollback leaves both item and evidence unchanged | U,P |
| Migrations/types | public MigrationTracker applies manifest DDL on each engine; registry columns/indexes match; live schema diff empty; missing schema fails diagnostic; fractional confidence round-trip | U,P |
| Browser boundary | built root and DTO dependency graph bundled with browser conditions and banned provider/Node imports | K |
| Host authority | owner and delegated allow; unrelated/revoked actor and foreign tenant/confidential scope deny at list/item/evidence/byte reads and writes | U,P |

No domain action is executed in this child. The durable-success fixture is inserted
by trusted test setup to prove proposal/reprocessing/retention refusal and replay
identity, not to claim #3674 transaction-bound domain effect validation.
Decision/execution/feedback record foundations exist; human review, business
apply, external reconciliation and example retrieval remain their owning children.
The host's idempotent purge callback owns external derived indexes/caches; the
foundation tests prove revocation, retry and ingestion payload/byte propagation.

Assets evidence: complete model and maintained UI suite (`pnpm --filter
@happyvertical/smrt-assets test`), maintained Chromium suite (`test:e2e`), build
and typecheck. New AssetStore cases verify immutable adoption, changed-byte and
changed-resolver rejection, and failure-closed non-missing storage errors.

The ingestion package is registered in the consumer bundle gate. Its complete
`pnpm --filter @happyvertical/smrt-bundle-gate test` and `typecheck` commands
validate browser reachability and the existing consumer boundaries together.

Repository lint, format-check, instruction chain, audit policy and regenerated
strict knowledge validation apply and are captured. The coordinator runs the
broader monorepo build/typecheck/test before independent review. There is no
provider/UI/evaluation capability in this child, so the frozen future lanes are
not applicable and remain explicitly unavailable, never empty passing suites.

## Accepted review corrections (round 1)

The four `review regression:` cases run under both U and P. All four fail against
reviewed revision `552ddebb1b49080bc67f0971769010061b3fe384` and pass after correction;
full logs and hashes are in `/home/will/Work/tmp/s3670/r1-fixes`.

| Existing invariant | Deterministic regression trigger | Required observation |
|---|---|---|
| Host authority / receipt identity | Host revokes receive permission after the first check, before reservation | Transaction-bound authorization denies; no item or evidence row is committed |
| Dispatch repair / current state | Analysis completes after repair snapshots its intent, before allocation | Completed intent is skipped; public item remains completed; no new job |
| Revision isolation | Reanalysis supersedes an unfinished revision; repair also encounters a pre-fix obsolete intent | Supersession retires old dispatches atomically; repair retires stale work without changing current success or enqueueing |
| Visible attempt budgets | Last permitted worker lease expires before another claim | Item, analysis and attempt project needs-attention together; dispatch retires; late completion is rejected |

Only ingestion server behavior, its shared database tests and this matrix change
for these corrections. Previously recorded assets, package/dependency registration,
consumer bundle-gate and root full-suite evidence remains applicable; no source or
dependency in those packages changes. Full ingestion build/typecheck/U/P and root
lint/format/regenerated strict knowledge checks are rerun for the corrected tree.


## Accepted automated review corrections (round 3)

Four `review second regression:` cases fail against
`c4eaab8ced9260411e4b8c151b0c88beef33a2a1` on both databases. Evidence is captured
under `/home/will/Work/tmp/s3670/r2-fixes`.

| Existing invariant | Regression observation |
|---|---|
| Deterministic receipt retry | A ready duplicate whose dispatch repair throws returns retry/unavailable, preserves evidence and remains recoverable |
| Terminal cancellation/expiry | Both queued and running parent analyses become superseded together with attempts; late completion is rejected |
| Retention recovery | Expiring two items with one existing tombstone performs one repair traversal; subsequent sweeps still revisit all three cleanup locators for late writes |

Only server code, shared database tests and this matrix change. The unchanged-source
carry-forward rationale above still applies; full ingestion U/P/build/typecheck and
affected root lint/format/regenerated strict knowledge checks are rerun.


## Accepted incremental review correction (round 4)

The mixed-authority `review third regression:` fails on both databases at
`1301636946a68d8c54b05e15163b07699868ebee`: an earlier authorized receipt retains
its bytes after a later expiry authorization fails. The corrected sweep attempts
one repair before rethrowing the original scheduling failure. The test verifies
earlier bytes and derived data are purged, its tombstone completes, and the denied
receipt keeps its bytes, active visibility and no deletion intent. Repeated sweeps
preserve the same denial. Evidence: `/home/will/Work/tmp/s3670/r3-fixes`.
The same three-file scope and unchanged-source carry-forward rationale apply.


## Merge-queue registry integration correction (round 5)

Full core `test:integration` reproduces the queue failure at
`841aa743a98a3de69b79ffc6b3e0fe71e75c54d8`: the cycle allowlist assumed chat
contained the only mutual foreign keys. It now permits exactly the approved
`IntakeAnalysis.currentAttemptId` / `IntakeAnalysisAttempt.analysisId` pair too.
Strict ordering for acyclic edges, complete unique node retention and rejection
of any other cyclic edge are unchanged. The existing ingestion U/P migration
parity tests already exercise this schema; no schema/runtime code changes.
Evidence: `/home/will/Work/tmp/s3670/r4-fixes`. Full core test/integration/build/
typecheck and affected repository gates run. Ingestion U/P, core PostgreSQL and
full root runtime evidence carry forward because only test expectations and
this matrix change; no numeric, UUID, conflict, timestamp or migration path changes.

### #4085 trusted internal sources

`internal-sources.test.ts` and `internal-sources.postgres.test.ts` share
`src/test-support/internal-sources.ts` on both databases:

| Behavior/invariant | Positive | Negative/failure | Evidence |
|---|---|---|---|
| Receive by reference | text and structured snapshots become durable evidence with no asset record or stored object; `readEvidence` serves the snapshot after hash/length checks; copied sibling parts still preserve an asset | malformed reference/snapshot/owner, NUL or unpaired surrogates in snapshot text, reference owner/id/version or retention owner kind/id, and non-text inline parts reject `invalid` without reserving a row on both engines; `expireOwned` and `interpretInline` refuse such identifiers; a replay switching retention mode conflicts | U,P |
| Owner-bound retention | `expireOwned` revokes and redacts every receipt of that owner through the existing deletion ledger, removes copied assets, leaves other owners untouched and returns zero on repeat; every ledger table's payload is `{}` and `owner_key`/`submitter_id` are blank afterwards; each confidential scope's service releases its own receipts | the deleted delivery is never re-admitted; the own listing drops it immediately; a foreign tenant releases nothing | U,P |
| Referenced snapshot integrity | asset-less evidence is served only when length and hash match | same-length tampering, truncation and a missing snapshot fail closed; an uncategorized stage failure leaves the inline attempt running under its lease (job semantics), the same request reports `Inline interpretation busy`, and a fresh fenced attempt follows lease expiry with no job row | U,P |
| Inline mode | receive-to-proposals in-process: fenced extraction and interpretation revisions, catalog digest and provenance, no job row, every dispatch intent retained `completed`, `repairDispatches` enqueues nothing; identical `requestId` replays the same attempts | a job receipt cannot use the inline path; provider failure keeps the `unavailable` category without exception text; revoked process access denies before any stage | U,P |
| Submitter-scoped approval | own listing shows only the actor's own items; `submitOwnDecision` approve/defer records a human decision by that actor with `mode: 'review_own'`/`selfDecision: true` (reviewer decisions `mode: 'review'`), mirrored on feedback events; identical replay returns the review; `applyAction` succeeds once and replays its digest | non-reviewer submitter denied at `submitDecision`; other actors and reviewers denied as submitter; `correct` refused; missing live `submitter` grant or policy opt-out denied with no decision row; conflicting replay rejected; page limits validated; foreign tenant/scope lists nothing; with A < B < C and B's item-level read revoked, `limit: 2` returns `[A, C]` with no cursor and `limit: 1` pages `A` then `C` with the cursor naming only A, B's id appearing nowhere; an all-unreadable page is empty with no cursor; with 49 hidden rows the 50-row batch boundary still pages the readable rows on either side with a confirmed cursor; 999 hidden rows still list the readable row and 1000 fail closed with `Own proposal scan limit`; a readable item whose handler access is denied, or whose host `assertTarget` throws (reference host), is returned `unavailable` without handler, action or host error text while the others keep their reviews; a throwing grant store propagates instead of hiding rows; feedback re-evaluation cannot turn `submitterReview` on | U,P |
| Migrations/types | the existing manifest parity case covers the added `submitter_id`/`owner_key` columns and indexes on both engines | | U,P,K |

### #4116 retained dispatch routing

`foundation.test.ts` and `foundation.postgres.test.ts` share the `dispatch route
authority` cases: real TaskRunner failure followed by a differently configured
host, in both routing directions and with an unrelated denied captured ceiling;
no cross-host authorization, delivery consumption or enqueue; same-route revoked
authority remains an error. They also cover receipt/revision pins, cross-host
replay and analysis refusal, defensive host-target snapshots, exact legacy
job-lineage verification, malformed/conflicting lineage, and deleted-job unknown
recovery. Explicit operator recovery is tested closed by default, separately
authorized, current/captured permission-bound, scoped to tenant/confidential
context, fingerprint-checked under lock, bounded in evidence, atomic on rollback,
idempotent under identical concurrent retry and conflicting under differing
concurrent decisions, without enqueue or original-authority replacement.
Historical route-less rows are constructed only in the owned test fixture;
worker failures use the real public runner lifecycle, not edited job statuses.
