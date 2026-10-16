# @happyvertical/smrt-sales

Provider-neutral sales operations for s-m-r-t: agreement execution, CRM, referral
intake and attribution, a neutral commissions core, and reusable Svelte
surfaces. It is one installable package with subpaths that keep consumers scoped
to the modules they use.

`@happyvertical/smrt-affiliates` is a deprecated compatibility shim over the
commissions module. New applications should import this package directly.

## Installation

```bash
pnpm add @happyvertical/smrt-sales
```

Add `svelte` when consuming the optional UI export.

## Modules

| Entry point | Responsibility |
| --- | --- |
| `@happyvertical/smrt-sales/agreements` | Versioned commercial terms, verified e-signature execution, and immutable evidence |
| `@happyvertical/smrt-sales/crm` | Leads, pipelines, opportunities, activities, conversions |
| `@happyvertical/smrt-sales/referrals` | Referrers, links, attribution, qualification, agreements |
| `@happyvertical/smrt-sales/commissions` | Earners, plans, earning events, commissions, payouts |
| `@happyvertical/smrt-sales/svelte` | CRM, referrer, commission, and operator surfaces |

The root export re-exports all TypeScript modules for convenience.

## Quick start: commission terms

```ts
import {
  CommissionPlanCollection,
  EarnerCollection,
} from '@happyvertical/smrt-sales/commissions';

const db = 'sales.db';
const earners = await EarnerCollection.create({ db });
const plans = await CommissionPlanCollection.create({ db });

const earner = await earners.create({
  tenantId: 'tenant-1',
  profileId: 'profile-42',
  displayName: 'North Region Partner',
  status: 'active',
  currency: 'CAD',
});

const plan = await plans.create({
  tenantId: 'tenant-1',
  planKey: 'referral-standard',
  name: 'Standard referral plan',
  currency: 'CAD',
});
plan.setComponents([
  {
    key: 'collected-revenue',
    trigger: 'collected_revenue',
    basis: 'gross',
    rate: 0.1,
    recurrence: { kind: 'one_time' },
  },
]);
plan.activate();
await plan.save();

console.log(earner.id, plan.getComponents());
```

All money fields use integer cents. Rates and probability-like values use
decimals from `0` to `1`; rounding occurs through the exported money helpers.

## Waterfall plans

Version-two plans can carry ordered `steps`, an `effectiveTo` boundary, and a
`remainderSink`. `calculateWaterfall()` is a pure, generic allocation service:
hosts register recipient resolvers, then persist the returned trace as the
replay evidence. Step keys must be nonempty strings; malformed persisted keys
are rejected before allocation or activation. Replay snapshots copy recipient
and sink values, including nested metadata, so later caller-input mutation
cannot change the returned evidence. The trace freezes the resolved recipients, input facts, and
application-fee offset. All amounts are integer minor units; each percentage
rounds half away from zero and recipients plus the sink always equal gross.

An application fee already settled at checkout is modeled only as an offset to
the configured recipient's payable allocation. It is never emitted as a second
allocation or payable. Offset matching uses the entire recipient descriptor,
including nested metadata; object key order does not change identity. The service
does not initiate a payout or transfer.

The referral qualification and commission bridge remain component-based. Both
qualification and explicit requalification refuse a resolved waterfall plan with
`unsupported_plan_engine`, before writing a snapshot or changing the referral.
This applies to pinned plans and latest-active plan amendments. Existing frozen
v1 snapshots keep governing earnings. To recover, activate and bind compatible
component terms, then retry qualification; use `calculateWaterfall()` directly
for v2 allocations. Switching a plan key's engine does not migrate referrals.

## Core model

- **Roles are separate from money.** `SalesRepresentative` and `Referrer` are
  distinct roles; both point to one neutral `Earner` payout identity.
- **Terms are versioned rows.** Activated commission plans, attribution
  policies, and referral agreements are amended with new versions.
- **Evidence is immutable.** Earning events, executed agreements, referral
  touches, and adjustments are append-only or guarded after activation.
- **Retries are explicit.** Stable dedupe/idempotency keys prevent duplicated
  earning, click, adjustment, agreement, and payout operations.
- **Writes use services where required.** Payout transitions, adjustments,
  agreement execution, and attribution have service-owned invariants that raw
  generated CRUD must not bypass.

## Lead intake and lifecycle

`LeadWorkflowService` is the tenant-safe, application-facing seam for generic
intake, follow-up, qualification, stage movement, and opportunity closure. Construct it with the host database inside an
active `withTenant()` context; the host supplies authorization, actor/profile
ids, and view-model mapping.

```ts
import { LeadWorkflowService } from '@happyvertical/smrt-sales/crm';

const workflow = await LeadWorkflowService.create({ db });
await workflow.startWorking({ leadId, actorProfileId });
await workflow.scheduleNextAction({
  leadId,
  actorProfileId,
  summary: 'Call after product review',
  dueAt: new Date('2026-10-01T16:00:00Z'),
});
```

The service atomically records assignment and status audit events, human
activities, scheduled next actions, and monotonic task completion.
`createLead()` requires a name and email or phone, normalizes email, supports an
optional host-authorized `profileId`, and supports
active-lead deduplication and caller-supplied idempotency keys. A terminal duplicate
is reported for the host to resolve explicitly. `qualifyLead()` delegates to
`LeadCollection.qualify()` and returns the linked opportunity.
`moveOpportunityToStage()` atomically moves an open Opportunity between
nonterminal same-pipeline stages; exact retries add no audit. `closeOpportunity()`
selects the pipeline's won/lost stage and optionally records a won conversion
link. CRM never creates the downstream target. Money remains integer cents via
`expectedValueCents`; actor attribution uses `actorProfileId`.

`LeadCollection.listInbox()` provides tenant-scoped filtering, sorting, counts,
and pagination with batched owner/next-action reads. `getLeadWorkState()` includes
the linked opportunity. Duplicate merging remains owned by
`LeadCollection.mergeLeads()`.

`LeadCreateForm`, `LeadList`, and `LeadDetail` from `/svelte` receive view data and
callbacks. The host controls inbox filters and pagination, duplicate decisions,
routes, authorization, and service invocation. Components never fetch data.
See [the CRM contract](agents/crm.md) for retry and duplicate semantics and
[the Svelte contract](agents/svelte.md) for the component surfaces.

## Agreement boundary

`Agreement` is a counterparty-agnostic, effective-dated terms record. Parties
are ordered `{ kind, id }` descriptors, so consumers can use tenant, earner,
profile, organization, worker, or their own neutral kinds without importing a
consumer domain. Versions are rows: `createAmendment()` creates a draft and
`activateAmendment()` closes the predecessor at the successor's start. Effective
intervals are half-open (`[effectiveFrom, effectiveTo)`), and `activeFor()` is
an as-of query: it can return a superseded or terminated version that governed
the supplied record date, never terms inferred from today's status. Ambiguous
overlapping intervals fail closed. Activation rejects backdated or out-of-order
amendments that would overlap existing history. Ending a draft cancels it without
making it govern; closed intervals cannot be reopened. Party JSON is canonicalized
before persistence, so property order does not change an agreement's identity.
Tenant lookups fall back to global terms for each requested date when no tenant
version governs that date. A tenant must explicitly create its initial version
before using amendment helpers; global terms are never implicitly copied into a
tenant amendment. Callers that calculate money must snapshot
the returned version at their authoritative event; this model does not settle
or allocate funds.

The execution portion of the agreements module accepts the provider-neutral
`@happyvertical/signatures` contract plus an `AssetRuntimeLike`. Provider
credentials remain in the injected SDK adapter and secret store. Executed
agreements freeze the exact source, signed document, audit trail, hashes, and
signer evidence; amendments create new records.

## Tenancy and cross-package references

Most business models are optionally tenant scoped so intentional global
operator rows remain possible. Execution evidence and private operation fences
are required-tenant records. Profile, invoice, and asset references use
cross-package string references rather than circular runtime dependencies.

## Migration from affiliates

See [`smrt-affiliates`](../affiliates/README.md) and its migration guide for the
legacy mapping: `Partner` becomes `Earner`, and `Payout` becomes
`CommissionPayout`. The compatibility package owns no duplicate models or
tables.

## Development

```bash
pnpm --filter @happyvertical/smrt-sales test
pnpm --filter @happyvertical/smrt-sales typecheck
pnpm --filter @happyvertical/smrt-sales test:postgres
pnpm --filter @happyvertical/smrt-sales build
```

See [`AGENTS.md`](./AGENTS.md) for lifecycle, evidence, concurrency, and payout
invariants.

A future amendment activated through `activateAmendment` can be withdrawn through
`withdrawAmendment(id)` only before its start, while it is still active. This
transaction cancels the never-effective successor and restores its exact persisted
predecessor end (including a finite end); it never infers an open-ended interval.
Repeated, late, or conflicting withdrawals fail without changing history. Direct
model termination remains for already-effective terms. Global defaults apply only
before a tenant lane first governs; termination, expiry, and later gaps in that
lane return no agreement instead of silently resuming global fees.

Restoration provenance is written exclusively by amendment activation; ordinary
creates and saves cannot supply or edit it. Withdrawal advances both persisted
revision tokens so pre-withdrawal model instances cannot overwrite the result.

Concurrent `createAmendment` calls serialize version allocation within the owning
lane: PostgreSQL locks the oldest persisted version and re-reads the latest;
embedded engines use core's transaction/write queue. Each successful call keeps
its own terms and version. Direct `supersede()` requires a finite `effectiveTo`
set before the transition; saving an open-ended superseded row is rejected.
