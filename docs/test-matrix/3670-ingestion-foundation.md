# Ingestion foundation behavior-to-test matrix

Refs #3670; frozen contract: [ADR 0004](../adr/0004-application-aware-ingestion.md).
High risk: persistent tenant/confidential authority, concurrent leases and cross-system recovery.
Executed evidence is captured outside the worktree in `/home/will/Work/tmp/s3670/evidence`; the review packet records command status, file digest and reviewed revision. The foundation suite executes the same 26 cases on each real database.

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

Provider/component/e2e/evaluation lanes are frozen but have no implementation in this foundation child: they must fail clearly until their owning children install real suites, never pass an empty lane. No regression comparison: additive feature. Assets changes require its full model/UI/browser suite, build and typecheck. Root lint/format/instruction/knowledge/audit checks apply. No new UI or extraction behavior is claimed.

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
