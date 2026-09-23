# @happyvertical/smrt-subscriptions

Tenant subscriptions, plan features, immutable/idempotent usage evidence,
effective-dated client pricing, scoped spending policies, and entitlement
resolution for SMRT applications.

## Validation

```bash
pnpm --filter @happyvertical/smrt-subscriptions test
pnpm --filter @happyvertical/smrt-subscriptions test:postgres
pnpm --filter @happyvertical/smrt-subscriptions typecheck
pnpm --filter @happyvertical/smrt-subscriptions build
```

`test:postgres` is the lane that holds the money-column line — SQLite's type
affinity stores a REAL in an INTEGER column without complaint, so a money field
that reverted to DECIMAL passes every SQLite suite.

## Money

- **Money is integer minor units** (cents) — `$19.99` is `1999`.
  `SubscriptionPlan.priceAmount`, `ClientCharge.amount`, `RetailCharge.amount`,
  `CreditGrant.amount`,
  `BillingAdjustment.amount` and `SpendingPolicy.limitAmount` all initialize
  `= 0`, never `= 0.0`: the integer literal is what maps them to INTEGER
  columns (BIGINT on fresh PostgreSQL/DuckDB databases; #2401, #2373). `ClientCharge.quantity` and `TenantUsageMetric.quantity` are
  the opposite case — metered quantities are genuinely fractional and stay
  DECIMAL.
- **`PricingRule.terms` are minor units *per unit of usage*, and stay
  fractional.** A per-token rate is routinely a fraction of a cent, so an
  integer `unitPrice` would truncate it to zero. `calculateAmount()` rounds the
  computed result to a whole minor unit — that is the single boundary in the
  package where a rate meets money, and it is what lets `evaluateSpending()`
  compare charge sums against `limitAmount` exactly.
- **`adjust()` rejects a fractional amount.** Negative amounts are legitimate
  (a credit); fractional ones almost always mean the caller passed major units.
- **Billing rejects immediate JSON write-back.** The JSON adapter's default
  `writeStrategy: 'immediate'` and DuckDB with that write-back strategy export
  files before transaction commit, while adapter rollback restores only the
  database transaction. `CommercialUsageService` therefore fails before setup
  on those configurations. PostgreSQL, SQLite, ordinary DuckDB, and explicit
  non-immediate write strategies remain supported. When supplying an already
  resolved database handle, also pass `billingStorage` so this capability
  decision is explicit rather than inferred from private adapter state.
- **Embedded sourced adjustments serialize per database.** SQLite, DuckDB, and
  supported non-immediate JSON handles multiplex local writes; the complete
  deterministic adjustment flow, including recovery reads, runs under one
  database-scoped lock. Every supported embedded adjustment transaction,
  sourced or unsourced, also holds the core embedded write queue for its full
  lifetime; transaction-bound model saves re-enter that hold so adjustments
  cannot absorb, roll back, or deadlock with unrelated ordinary writes.
- **UI formats by dividing, never by `toFixed`.** `PlanPicker` and
  `CommercialOverview` scale back to major units using the currency's own
  minor-unit exponent, so zero-decimal currencies (JPY, KRW) are not divided.
- **Migrating an existing database**: `preflightSubscriptionsMoneyMinorUnits(db)`
  reports which columns still hold major units and which rows would be rounded
  or exceed JavaScript's safe-integer range; `migrateSubscriptionsMoneyToMinorUnits(db)` converts them
  (idempotent via `_smrt_backfills`). On SQLite the values are rescaled but the
  declared type needs the table-rebuild path (#2370). Existing
  `PricingRule.terms` are **not** migrated automatically — only the operator
  knows which keys in a given rule are prices rather than quantities or ratios.
- **Range and existing deployments**: fresh PostgreSQL/DuckDB INTEGER columns
  are BIGINT, and hydration rejects values outside JavaScript's safe-integer
  range. Existing PostgreSQL `int4` columns require the explicit widening in #2424.

## Reseller billing (#3059)

- Billing ownership is consumed from `smrt-tenancy`'s
  `BillingRelationshipService` (`BillingRelationshipReader`); never re-derive
  parentage or owners here.
- `ClientCharge` stays one row per usage event (`usage_event_id` unique) and
  `tenantId` is always the payer. That uniqueness is the double-billing guard
  across owner changes; do not widen its conflict key. The retail leg lives in
  `RetailCharge` (also one per event), written in the same transaction.
- Price-book rules are `PricingRule` rows with `priceBookId`; `price()` must
  keep ignoring them, and `rateUsage()` only trusts rules whose tenant owns the
  book.
- Delegated `SpendingPolicy` rows (`setByTenantId`) are guarded in
  `validateBeforeSave` and a `beforeDelete` hook, by id and by conflict key;
  `CreditGrant` applies the same parent-only rule to delegated balances.
  `PriceBookAssignmentCollection` is deliberately not a root export.
- `ResellerBillingService` authorizes first, then writes in a system context
  (parent writes land on child-owned rows). The wholesale leg is authorized by
  the book's publisher and may never be published by the payer; whether a
  publisher is a legitimate provider for the reseller is a host obligation
  (the model records no upstream seller). The only
  cross-tenant read in evaluation is the bounded `wholesale`-basis sum.
- `balance` policies take their limit from `CreditGrant`s; `limitAmount` must
  be 0. Auto top-up is a host hook only — no payment provider calls.

## Notes

- Keep Stripe-specific fields as provider binding metadata. Runtime Stripe API
  calls belong in the HappyVertical SDK accounting provider.
- Thresholds are evaluated from tenant usage metrics and optional AI usage
  summaries. Resolve multiple thresholds with the batch usage path where
  available; do not bypass tenant context in application code.
- Use `SubscriptionResolver.create()` or an explicitly injected
  `SubscriptionResolver` once per request when resolving entitlements multiple
  times. Load and pass `EntitlementResolutionContext` to avoid re-reading the
  current subscription and plan.
- Subscription UI components should stay provider-neutral and receive actions
  from the host app.
