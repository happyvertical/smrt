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
| `@happyvertical/smrt-sales/agreements` | Verified e-signature execution and immutable evidence |
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

## Lead follow-up workflow

`LeadWorkflowService` is the tenant-safe, application-facing seam for generic
pre-qualification follow-up. Construct it with the host database inside an
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
activities, scheduled next actions, and monotonic task completion. Qualification
and duplicate merge ownership remain respectively with `LeadCollection.qualify()`
and `LeadCollection.mergeLeads()`. `LeadDetail` from the `/svelte` subpath is
props- and callback-driven; it never fetches data or applies authorization/SLA
policy.

## Agreement boundary

The agreements module accepts the provider-neutral
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
