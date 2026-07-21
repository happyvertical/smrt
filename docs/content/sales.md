---
id: sales
title: "Sales and Agreement Execution"
sidebar_label: "Sales"
---

# Sales and agreement execution

`@happyvertical/smrt-sales` exposes CRM, referrals, commissions, Svelte views,
and a provider-neutral agreement execution module.

## Atomic referral clicks

Use the public `ReferralLinkCollection.recordClick()` boundary for link-click
intake. Do not create `ReferralTouch` rows or update `referral_links` directly.
The method resolves the visible tenant-owned link, claims a private replay
fence, creates the immutable touch, and increments `clickCount` in one database
transaction:

```ts
const result = await links.recordClick({
  code,
  idempotencyKey: requestId, // reuse this exact value for every retry
  evidence: { userAgentHash, referrer },
  maxEvidenceBytes: 4096, // optional; 4096 is the default
});
```

On the first successful call, `result.replayed` is `false`. An exact retry
returns the same touch with `replayed: true` and does not increment the counter
again. The returned link is freshly loaded, so its counter may also include
other independently keyed clicks. Later edits to mutable link fields such as
`targetUrl` do not invalidate an exact replay: replay comparison uses the
immutable operation/touch snapshot, the returned link reflects its current
state, and the returned touch retains the original persisted evidence.
Reusing the key with another code/link,
tenant, attribution subject, explicitly supplied occurrence time, or caller
evidence throws `ReferralClickReplayConflictError`; its `mismatches` field
names the conflicting intent fields. Replay keys are exact, non-empty strings
of well-formed Unicode and at most 256 UTF-8 bytes. They are globally fenced
while the associated link, touch, and operation remain tenant-filtered; a
foreign-tenant collision reveals no foreign payload. `maxEvidenceBytes` is a
creation-time guard: an already-committed exact replay remains successful if a
later invocation supplies a different limit.

For source compatibility, callers may omit `idempotencyKey`. Sales then
generates a one-shot UUID and returns it as `result.idempotencyKey`, but a later
independent call cannot be recognized as its replay. Retry-capable transports
should always supply their own stable key.

Sales canonicalizes JSON evidence and then overwrites the package-owned
`code`, `linkId`, and `targetUrl` fields. It measures the UTF-8 bytes of that
exact final JSON string and rejects an over-limit call with
`ReferralClickValidationError` (`reason: 'evidence_too_large'`, with
`actualBytes` and `maxBytes`) before any touch, counter, or replay fence commits.
Character counts and caller-only JSON sizes are not equivalent, especially for
multibyte URLs or evidence. Schema migration must include the private
`referral_click_operations` table before using this contract.

### Recording clicks inside your own transaction

By default `recordClick()` opens and commits its own transaction. Never call
that default form while your own open transaction holds locks the click needs
(above all the `referral_links` row it increments) or created the link it
resolves: a nested adapter transaction runs on an independent pooled
connection, so it deadlocks undetectably on your locks and cannot see your
uncommitted rows. To compose, participate in your transaction instead:

```ts
await db.transaction(async (tx) => {
  await tx.query(
    `SELECT id FROM ${links.tableName} WHERE id = $1 FOR UPDATE`,
    linkId,
  );
  const result = await links.recordClick({
    code,
    idempotencyKey: requestId,
    transaction: tx, // participate — no nested transaction is opened
  });
  // ... other writes that must commit atomically with the click
});
```

Equivalently, a collection bound to the transaction participates without the
input field: `await ReferralLinkCollection.create({ db: tx,
_reuseInitializedDb: true, _deferRuntimeInitialization: true })`. In both
forms atomicity, rollback, and locking belong to your transaction, and the
returned models are bound to it — they are current while it is open, so carry
ids across the commit boundary and re-fetch on a pool-bound collection for
long-lived use. Passing a pool-level database as `transaction` is refused with
`ReferralClickValidationError` (`reason: 'invalid_transaction'`) because it
would run the click's writes without any transaction.

## Agreement execution

Use `@happyvertical/smrt-sales/agreements` with an injected
`SignatureProvider` from `@happyvertical/signatures` and an `AssetRuntimeLike`
from `@happyvertical/smrt-assets`.

The execution flow is:

1. Store the exact generated source document as a tenant-scoped Asset and
   create an idempotent `AgreementExecution`.
2. Send through the injected provider. Credentials remain in the provider;
   SMRT stores only an optional secret-store reference.
3. Pass the exact webhook body and signature header to `ingestWebhook()`.
   The SDK adapter verifies authenticity/freshness before SMRT writes an
   append-only, replay-deduped `AgreementExecutionEvent`.
4. On verified completion, retrieve both the signed document and audit trail,
   verify their SDK SHA-256 values, store them as Assets, and create one
   immutable `ExecutedAgreement`.

All service methods require an ambient tenant context matching the explicit
tenant id. Provider responses, webhooks, and stored Assets are checked against
that same boundary. Provider request ids cannot be bound to two executions,
and lifecycle reconciliation never regresses terminal or progressive state.
An uncertain provider create is not blindly retried when the provider lacks
atomic idempotency. A durable create-operation lease prevents concurrent sends;
once it expires, non-atomic providers fail closed and require reconciliation
plus `adoptProviderRequest()` with the confirmed remote request id. Providers
that advertise atomic idempotency may reclaim an expired lease and resend the
same idempotency key.

`AgreementExecution` and `AgreementExecutionEvent` are private orchestration
objects: they have no generated API, MCP, or CLI mutations. Operator and
provider operations append start/success/failure-or-uncertain audit records;
verified event evidence requires explicit occurrence and first-receipt
timestamps. A replay keeps the original receipt timestamp rather than treating
the later delivery time as different provider evidence. Terminal provider
states never resurrect into a different terminal outcome.
`ExecutedAgreement` exposes read-only list/get surfaces and freezes exact Asset
ids, SHA-256 values, byte sizes, filenames, media types, signed signer evidence,
acceptance/effective dates, and amendment provenance. Webhook signature headers
and signer access codes are never persisted.

## Referral Agreement binding

`ReferralAgreementExecutionService` binds one versioned Referral Agreement to
the generic execution flow. A version cannot activate without immutable
executed evidence. `createAmendment()` always creates a fresh unsigned draft;
the prior version's execution and evidence ids are never copied.

A signed future-effective amendment can coexist with the currently effective
version. `activeFor()` selects the highest active version whose effective
window contains the requested instant, and `supersedePriorIfEffective()`
end-dates/supersedes the prior version once the new effective date arrives.

UI view models carry Asset ids and hashes, not provider URLs. Applications
must build authorized Asset retrieval URLs at their own HTTP boundary.

### Migrating mutable referral evidence

`ReferralAgreement` no longer exposes `contractRef`, `executedArtifactUrl`,
`executedArtifactHash`, or `acceptanceEvidence`. It instead binds the exact
version to `executionId` and `executedAgreementId`; an active row cannot be
saved without both bindings. Do not promote a legacy URL, hash, or JSON blob
into `ExecutedAgreement`: immutable evidence requires the verified source,
signed document, audit trail, and signer record. Where those artifacts can be
verified, import them through the same tenant Asset and immutable-evidence
invariants. Otherwise create and execute a fresh agreement version. Amendment
creation never copies either legacy evidence or the new execution bindings.
