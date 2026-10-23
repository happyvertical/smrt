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

### #4212 reviewer instructions as trusted guidance

`proposals.test.ts` and `proposals.postgres.test.ts` share three cases. The
record case covers reviewer-grant and actor denial, empty/oversized text, stale
revision, replay identity and changed-text conflict, immediate suggestion
staleness, the extraction-configuration record (`kind`, id, digest, actor), the
digest-verified interpretation copy, the separate trusted-guidance prompt section
after the untrusted-evidence instruction, unchanged `offered`/`catalogDigest`,
`provenance.reviewerInstruction`, `automaticActionEligible: false` with
`authorizeAutomatic` refusal, supersession (`supersedesId`, newest-first history)
and a guided reply naming an unoffered handler failing as `provider_error` with
no domain effect. The injection case shows `analyze` refusing an extraction-stage
instruction and a forged interpretation copy failing before provider disclosure
while history stays empty. The feedback case shows the judgment carrying
`{id, digest, text}`, `retrieveFeedback` returning it with the example, and the
receiving generation seeing it only as example content. Further shared cases cover `processing` state with earlier (stale) actions and
`getReinterpretationState`; an instruction retained beside a later split
correction with `human_split_not_respected` still enforced; a tampered stored
extraction record and a well-formed forged interpretation copy both failing
before provider disclosure; replay of a superseded request ID, a concurrent
double record (exactly one wins) and retry against the latest completed
generation after a failed re-extraction, after a failed **interpretation**
(old anchor rejected once a newer interpretation completes), and with a split
recorded after the anchor carried into the retry; retries refused while the
later work is queued, running, between extraction and interpretation, or
interpreting, then accepted once interpretation fails; judgments storing only the
instruction reference with retrieval joining the text, a write-time refusal when
the joined example alone exceeds the read budget (nothing written), an exactly
fitting judgment recording and retrieving at its exact size, one byte short
refused, the handler `policy.maxBytes` side of the write-time `min()` refusing
on its own, and re-signed stored references with a wrong digest or id excluded;
a wedged gap (extraction completed, interpretation never appended) staying in
flight up to exactly the item lease and then reporting `not_started` and
accepting the retry, which recovers; a slow host's late interpretation append
after that retry refused with `GenerationSourceStaleError` (nothing appended, the
retry still queued, then completing under the retried instruction); missing
completion timing treated as expired immediately; the existing superseded
preparation case now refused at append time; genuinely interleaved concurrency
(on PostgreSQL a second real connection; on SQLite the shared write queue): two
reviewers at one revision (one wins, one refused, no fork), an instruction and a
split racing in both orders (the loser refused, both earlier corrections kept),
and a double-clicked instruction and split replaying a duplicate committed after
the unlocked replay check. Mutation evidence on PostgreSQL: the double-click
case fails (`ReviewerInstructionStaleError`) with the replay-under-lock removed;
the two race cases fail (the second writer is no longer blocked; the split race
hangs) only when *every* item-row lock is removed, because the guards were
already serialized twice before this change (the snapshot read's lock and the
execution authorization's `item(db, id, true)` row lock, both in the same
transaction before the guard step); the decision stage receiving the guidance
exactly once under `reviewerGuidance` and never under `evidence` (all decision
cases on both engines); the shared instruction-view projection used by both the
published and reference hosts (`review-instruction-view.test.ts`: an instruction
recorded between the history and state reads re-reads history instead of
reporting a drop, `dropped` only when nothing is in effect); missing-attempt and non-finite `leaseMs` gap timing expiring
immediately; and carried instruction text being
counted in the exact feedback byte budget, with one byte short still failing
closed before provider I/O (the existing byte-budget contract is unchanged). `review-host.test.ts`
covers `instruct` wiring, `onInstruct` wakeup and the `current/applied/stale`
projection; the component suite covers the textarea/button binding, disabled
empty text, polling through `processing` until the in-place update (also with an
earlier action present, with drafts and the textarea element preserved and no
loading placeholder), the failure/retry binding path, the 5× backoff cap under fake timers, a
transient thrown tick keeping the view then recovering, three thrown ticks
failing closed and stopping, edited-versus-untouched split drafts, polling with
Re-read disabled through the between-stages gap, a `{ stale: true }` result
reloading with a note and keeping the draft instead of denying, the note
cleared once a later poll shows the item settled (and at once when the reload
answering the click is already settled), the
`not_started` retry against the server binding, and stale display; the Chromium suite records a real instruction, observes the background
"Reinterpreting…" state, the in-place update, provenance, unchanged original
bytes, whitespace-only instruction text refused by server-side validation, and
supersession. No schema or migration changes:
the record lives in the existing append-only analysis ledger beside the split
correction.

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

### #4210 reviewer-chosen actions, handled-no-action disposition, routing feedback

New model `IntakeDisposition` (`intake_dispositions`) joins the manifest
migration/parity case automatically (`Object.keys(models)`), `assertReady` and
privacy redaction. Behavior cases live in `src/test-support/proposals.ts` and run
on both databases (U, P):

| Behavior/invariant | Positive | Negative/failure | Executor/transaction | Level |
|---|---|---|---|---|
| Start a reviewer-chosen handler | extraction-only, `provider_error` interpretation and wrong-suggestion items publish a `waiting_review` review with origin `reviewer-selected`; approve and apply create the real domain record; replay returns the same review | non-reviewer, foreign actor, unknown handler/version, unoffered media type, invalid arguments (no action row survives rollback), changed replay payload conflict | one locked item transaction through `buildBinding`/`publish` | U, P, components, E |
| Never automatic | a generated proposal under the same layered opt-in is machine-authorizable | the reviewer-selected action is refused by `authorizeAutomatic` | execution transaction | U, P |
| Handled, no action | disposition recorded once, projected on `IntakeItemDTO` as state and time only (reviewer/reason via `getItemDisposition` under reviewer authority, hidden from a denied reader), inbox state `resolved` and filterable; extraction-only items close too | non-reviewer/foreign tenant, invalid disposition, second request conflicts, authorized (live approval)/applied actions block while an exhausted failed action or a lapsed approval does not, executing/outcome_unknown/succeeded block too, later approve/correct/defer/re-preview/start/apply/retry/analyze/split/createAction refused while reject still works; createAction refuses reserved reviewer provenance; re-preview of a reviewer-selected action needs review authority and a fixed handler; resolve supersedes queued analysis and claimAnalysis refuses; privacy deletion and retention expiry keep only the kind for dispositions and routing feedback | append-only `intake_dispositions` under the item lock | U, P, components, E |
| Routing feedback | `reviewer_routing` rows for approved handler choices and `none` dispositions; retrieved for comparable items with `kind`, `routing` and no model versions; included in generation input; two independent handler choices support a rule suggestion with `automaticActionEligible: false` | tenant/confidential scope and per-item capture/retrieve denial exclude; `none`, duplicate, rejected and deferred support rejected; a correction retires the example until re-approval; starting alone records nothing; a lapsed unapplied approval or a disposition excludes the example and its support at selection while lineage re-checks of used examples ignore later resolution, lapse, outcome changes and target writes; a replayed suggestion returns the stored row; stored routing support survives a target write while interpretation support keeps the target check; tampered routing origin excluded from retrieval and support; interpretation judgments on reviewer-selected actions (even rejected, on a generated item) refused and never retrieved, while judgments on resolved items still count; no rows without feedback configuration | owning transactions; live source revalidation per example | U, P |
| UI | handler picker with suggestion/evidence pre-fill and missing fields, exact start payload, review and inbox no-action controls with reason, disposition replaces controls, origin label | malformed JSON rejected locally; absent callbacks render nothing; no implicit approve/apply/feedback | N/A | components, E |

Commands: package `pnpm test`, `pnpm test:postgres`, `pnpm test:components`,
`pnpm test:e2e`, `pnpm typecheck`, `pnpm build`; root lint/format/knowledge/audit.
