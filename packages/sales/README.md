# @happyvertical/smrt-sales

Provider-neutral agreement execution, CRM, referral attribution, commissions, payout orchestration, and reusable sales surfaces.

## Installation

```bash
pnpm add @happyvertical/smrt-sales
```

## Modules

- `./agreements` — verified execution evidence and immutable executed agreements.
- `./crm` — leads, opportunities, configurable pipelines, activities, and conversion links.
- `./referrals` — referral links, attribution policies, agreements, and immutable term snapshots.
- `./commissions` — earners, plans, events, adjustments, balances, and payout batches using integer cents.
- `./svelte` — props-driven CRM, referrer, payout, and operator surfaces.

The root export includes every TypeScript module. Provider credentials remain in injected SDK adapters and secret stores. `@happyvertical/smrt-affiliates` is a deprecated compatibility shim over the commissions core.

## Validation

```bash
pnpm --filter @happyvertical/smrt-sales test
pnpm --filter @happyvertical/smrt-sales typecheck
pnpm --filter @happyvertical/smrt-sales test:postgres
```
