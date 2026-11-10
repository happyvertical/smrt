# smrt-sales/agreements — verified execution evidence

Per-module semantics for `@happyvertical/smrt-sales/agreements`. Package orientation, the
cross-module invariants (currency, tenancy, cross-package refs, roles vs.
money), and the Gotchas that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

- **AgreementExecution**: private required-tenant orchestration state keyed by `(tenant_id, idempotency_key)`, with a collision-checked provider request/status, an expiring create-operation lease, source version/hash/size/Asset, intended signer identity/auth method, cancellation/expiry, reconciliation, exact staged artifact metadata, and secret-store references only.
- **AgreementExecutionEvent**: private append-only evidence for verified webhooks and operator/provider operations. Provider events are deduped by tenant/provider replay key; explicit occurrence/first-receipt timestamps and the exact payload/hash are retained, while signature headers are never stored. A later receipt time for the same verified provider event is an idempotent replay. Stale, regressive, or conflicting terminal events are audited without regressing lifecycle state or creating executed evidence.
- **ExecutedAgreement**: immutable read-only source version plus signed-document and audit-trail Asset ids/hashes/sizes/filenames/media types, completed signer evidence, acceptance/effective dates, and supersession reference. Amendments create new records.
- **AgreementExecutionService**: accepts an SDK `SignatureProvider` and shared `AssetRuntimeLike`; enforces ambient tenant equality, expiring remote-attempt fencing, create idempotency, verified webhook ingestion/replay, tenant-fenced lifecycle compare-and-set with monotonic provider-event ordering, partial audit/failure updates that cannot overwrite lifecycle state, cancellation/expiry/reconciliation, exact artifact hashing, and immutable finalization. An expired create lease may be reclaimed only when the provider advertises atomic idempotency; otherwise a create with no confirmed request id must be reconciled/adopted before retry.

## Effective-dated agreement withdrawal

`AgreementCollection.withdrawAmendment(id)` cancels any active version whose
`effectiveFrom` is strictly later than the current time, including a scheduled
initial version and an amendment starting after an ended predecessor. Cancelled
versions remain stored but never govern `activeFor` record-date lookups. Terms
and execution evidence are retained unchanged.

If activation closed a predecessor, withdrawal restores only the exact persisted
predecessor boundary and status. If activation closed nothing, withdrawal
restores nothing: an expired or terminated earlier version stays ended, and a
gap remains a gap. Imported overlapping governing history is refused; disjoint
later versions remain unchanged. Tenant scope, revision checks, cancellation,
and optional predecessor restoration share one transaction. Missing, draft,
terminal, already-effective, repeated, and conflicting withdrawals fail closed.

## Governed sales signing

`sourceKind: 'sales-quote'` requires `signingActorProfileId` and an injected
`authorizeSigning(CreateAgreementExecutionInput)` guard. Bind the exact tenant,
sourceId (quoteId), sourceVersion (revision) and actor to
`SalesGovernanceService.assertCanSign`, and validate the source document against
the frozen quote terms. The guard runs before source storage/existing-execution
replay and immediately before provider request creation. Actor identity is part
of immutable retry intent. Other agreement kinds may use the same optional guard.

Local authority commits before external provider I/O; provider work cannot join
a SQL transaction. Seller or finance revocation denies fresh/retried signing but
does not cancel already-dispatched provider requests. Hosts must explicitly cancel
outstanding requests when their policy requires it. See the governed sales
integration and supported PostgreSQL-only boundary in [crm.md](crm.md).
