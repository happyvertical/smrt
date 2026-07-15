---
id: sales
title: "Sales and Agreement Execution"
sidebar_label: "Sales"
---

# Sales and agreement execution

`@happyvertical/smrt-sales` exposes CRM, referrals, commissions, Svelte views,
and a provider-neutral agreement execution module.

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
verified event evidence requires explicit occurrence and receipt timestamps.
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
