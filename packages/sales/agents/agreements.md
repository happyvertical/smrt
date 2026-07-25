# smrt-sales/agreements — verified execution evidence

Per-module semantics for `@happyvertical/smrt-sales/agreements`. Package orientation, the
cross-module invariants (currency, tenancy, cross-package refs, roles vs.
money), and the Gotchas that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

- **AgreementExecution**: private required-tenant orchestration state keyed by `(tenant_id, idempotency_key)`, with a collision-checked provider request/status, an expiring create-operation lease, source version/hash/size/Asset, intended signer identity/auth method, cancellation/expiry, reconciliation, exact staged artifact metadata, and secret-store references only.
- **AgreementExecutionEvent**: private append-only evidence for verified webhooks and operator/provider operations. Provider events are deduped by tenant/provider replay key; explicit occurrence/first-receipt timestamps and the exact payload/hash are retained, while signature headers are never stored. A later receipt time for the same verified provider event is an idempotent replay. Stale, regressive, or conflicting terminal events are audited without regressing lifecycle state or creating executed evidence.
- **ExecutedAgreement**: immutable read-only source version plus signed-document and audit-trail Asset ids/hashes/sizes/filenames/media types, completed signer evidence, acceptance/effective dates, and supersession reference. Amendments create new records.
- **AgreementExecutionService**: accepts an SDK `SignatureProvider` and shared `AssetRuntimeLike`; enforces ambient tenant equality, expiring remote-attempt fencing, create idempotency, verified webhook ingestion/replay, tenant-fenced lifecycle compare-and-set with monotonic provider-event ordering, partial audit/failure updates that cannot overwrite lifecycle state, cancellation/expiry/reconciliation, exact artifact hashing, and immutable finalization. An expired create lease may be reclaimed only when the provider advertises atomic idempotency; otherwise a create with no confirmed request id must be reconciled/adopted before retry.
