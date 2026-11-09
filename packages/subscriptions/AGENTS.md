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

## Plan versions (#4032)

- `SubscriptionPlan.save()` publishes the next immutable
  `SubscriptionPlanVersion` when its terms (`PLAN_TERM_FIELDS`) change; the
  logic lives in `src/plan-versioning.ts`. Versions are append-only,
  contiguous, and monotonic in `effectiveFrom`.
- `TenantSubscription.validateBeforeSave()` maintains `planVersionId` via
  `pinSubscriptionPlanVersion()`: pin at period start, re-pin when
  `currentPeriodStart` moves, and refuse in-period changes that are not an
  `isEntitlementUpgrade()` unless `replacePlanVersion({ policy: 'authorized',
  reason })`. Never relax this to "latest version wins": a paid period must
  not lose entitlements.
- The resolver reads the pinned version; a missing or inactive pinned version
  fails closed. Only unpinned rows on plans without versions fall back to the
  live plan. `migrateSubscriptionPlanVersions(db)` backfills both.
- Renewal means the new `currentPeriodStart` is at or after the stored
  `currentPeriodEnd`; creation and renewal pin the boundary's version, and a
  caller-named other version needs an authorized replacement.
- `canceled` subscriptions entitle until `currentPeriodEnd` only with
  `retainsPaidPeriod`, derived on save from an entitled pre-cancel row.
- **Recipe `subscriptions.plans`** (`src/recipes.ts`, help in `src/plans.recipe.md`): lists plans, subscriptions, plan versions (read-only, written by `plan-versioning.ts`) and charges (read-only, written by the usage service) for the planner and other catalog hosts. Fields it shows carry `@field({ description })` in plain words, money fields saying "in cents"; keep them when editing the models. Reseller models and pricing rules stay out of it.

## Hosted AI spend caps (#4760)

`src/services/hosted-ai-spend.ts`. Plans cap platform-paid (`source:
hosted`) inference with ordinary `PlanThreshold`s on two reserved keys, so
window, amount and enforcement come from the plan (pinned version included):
`AI_HOSTED_SPEND_METRIC` (`ai.hosted.spend_micros`, the tenant) and
`AI_HOSTED_USER_SPEND_METRIC` (`ai.hosted.user_spend_micros`, each user).

- `limit` is **integer micro-dollars** (1 USD = 1,000,000; the money rule at
  per-call precision). `block` blocks at or over the cap, `warn` warns,
  `observe` never affects a call; `warningRatio` (default 0.8) warns early;
  a 0 cap blocks every hosted call. A malformed hosted cap (fractional or
  negative limit, unknown window/enforcement) throws
  `HostedAiSpendPolicyError` (the gate fails closed); it never reads as "no
  cap". `resolvePlanThresholds()` returns thresholds unfiltered for this
  reason (the models' `getThresholds()` drop invalid entries) and throws on
  non-array JSON.
- Spend: `createHostedAiSpendReader(db)` sums `_smrt_ai_usage.estimated_cost`
  (USD, rounded to micro-dollars) by `tenant_id` and `created_at` in the
  cap's window for rows whose `tags` hold `"source":"hosted"` (and
  `"userId":"<id>"` for the per-user cap), as exact, case-sensitive JSON
  fragments (`hostedAiTagFragment()`; `strpos` on the PostgreSQL dialect,
  `instr` elsewhere, never `LIKE`, which folds ASCII case on SQLite and
  would merge `Alice` and `alice`); errors only over-count.
  `operation: 'blocked'` rows and external-agent measurements never count;
  uncosted rows add nothing (give hosted models a cost rate). The `userId`
  tag exists only while the hosted gate's ambient-user resolver is
  registered.
- `resetsAt`: the calendar window's end; for a blocked `rolling` cap (30
  days), `HostedAiSpendReader.liftsAt()`: one window-function query (newest
  first running `SUM(estimated_cost)`, rounded as `summarize()` rounds)
  returns the row whose expiry first brings the total below the cap, plus
  30 days (null for a 0 cap). A blocked decision names the blocking cap that
  lifts last.
- `HostedAiSpendEvaluator` (`create({ db })`): plan thresholds via
  `SubscriptionResolver.resolvePlanThresholds()` (entitled terms, no usage
  meters; memoized per tenant for `termsTtlMs`, 30 s, failures evicted,
  `invalidate()`), spend read fresh per call; per-user caps only with a
  user. Errors propagate. smrt-inference's `./gate` consumes it.
- `resolveEntitlements()` / the tenant usage meter report these keys with
  quantity 0: only the evaluator meters them. The meter's AI summary (and so
  `ai.requests`) skips `operation: 'blocked'` rows. `SpendingPolicy` rows stay the
  billed-charge (cents) policy; hosted AI caps are plan terms because the
  issue's window and amount come from the plan.

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
  (the model records no upstream seller). Relationship reads precede
  authorization and stay under smrt-tenancy's own read rules. The only
  cross-tenant read in evaluation is the bounded `wholesale`-basis sum.
- `balance` policies take their limit from `CreditGrant`s; `limitAmount` must
  be 0, and currency and period are fixed once saved (the ledger is scoped to
  them). Auto top-up is a host hook only — no payment provider calls. The
  evaluator re-reads credit after the hook returns (grant or not) and hands
  it `currentShortfall()`, so a hook that charges asynchronously can see a
  concurrent top-up (smrt-commerce's `autoTopUpHook()`, #3139).

## Billing host glue (#4786)

`src/billing/` is the reusable Stripe checkout, signed idempotent webhook and
portal wiring (`createBillingHost()`, `readBillingEnv()`); the recipe and
environment names are in the README. Invariants:

- **No direct Stripe calls.** The provider is the structural
  `BillingProviderPort`; `StripeAccountingProvider` from
  `@happyvertical/accounting` satisfies it (a test pins that). A missing SDK
  capability is fixed in the SDK first. `@happyvertical/accounting` is a
  devDependency only (tests run the real provider over a fake `fetch`).
- **Webhook order is load-bearing:** size cap, signature header, own timestamp
  tolerance, SDK `verify` on the raw body, parse, handled-type filter,
  completed-claim pre-check, then (checkout only) the outside-transaction
  provider read-back, then `runOnce` claiming the event id *and* applying it.
  All DB access inside that transaction must use the `tx` handle; a read on the
  base handle deadlocks single-connection SQLite. Never claim before applying.
- **Trust comes from our own state.** Checkout metadata is HMAC-signed
  (`smrt_sig`, `signing.ts`) and an unsigned or foreign-signed session never
  links a tenant or plan. A provider subscription or customer id links to one
  tenant; a conflicting event is ignored with a reason code, not merged.
  Verification accepts the signing secret plus `metadataVerificationSecrets`
  (rotation); a purpose-matching session that fails them logs at error.
  A price the host cannot map that differs from the recorded one is held
  (`incomplete`, plan and recorded price kept, `metadata.stripe.held` set so
  checkout still refuses a second subscription) with an error log, never
  carried over onto the previous plan.
  Ignore (2xx, logged) for security refusals; fail (5xx) for configuration or
  database faults so the provider retries.
- **Only operator plans are sold by default** (`tenantPlans: 'deny'`); price
  resolution never lets a tenant-owned plan outrank a global one. Checkout
  metadata also signs the price and known customer, and the webhook refuses a
  session whose read-back subscription differs. PostgreSQL events lock the
  subscription and tenant (advisory, sorted) and re-read before deciding.
- **Order state lives on the row** (`metadata.stripe.lastEventAt`, `terminal`);
  a checkout read-back stamps `max(eventCreated, readAt)` so later-delivered
  older events cannot rewind it. Cancellation caps `currentPeriodEnd` at now.
- **Plan changes** from the provider use `replacePlanVersion({ policy:
  'authorized', reason: 'stripe:<eventId>' })`; the provider billed the change,
  so a mid-period downgrade is honoured and audited. Do not relax the pinning
  rules for any other caller.
- **No secrets out.** Responses use fixed messages; logs get ids and reason
  codes only, errors pass through `safeErrorMessage()`. `readBillingEnv` keeps
  secrets non-enumerable. Add a named test per new threat in
  `__tests__/billing-host.test.ts`.

## Vault account restart and supersede (#4841)

`src/vault-account/`. `supersedeVaultAccount`, `unsupersedeVaultAccount` and
`provisionRestartAccount` take injected ports (`VaultRelayAdminPort`,
`VaultAccountDirectory`, an audit sink); no HTTP server or relay is needed.
Order is load-bearing: owner of the tenant and of both accounts (`not_owner`),
then `requireRecentAuthentication` from `smrt-users/step-up`
(`step_up_required`, default 300 s), then the `authorized` audit record, then
exactly one relay call, then the outcome record. Refusals are audited and never
reach the relay; a member never learns about the step-up. Audit entries carry
ids and codes only (no session id, key, token or message text). Import only the
`@happyvertical/smrt-users/step-up` subpath, never the package root.

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
- **Feature grants as flags (#4761).** `SubscriptionFeatureSource` implements
  `smrt-features`' `FeatureGrantSource` structurally (no dependency either
  way). Build one per request (`SubscriptionFeatureSource.create(options)` or
  `new SubscriptionFeatureSource({ resolver })`; it memoizes grants per
  tenant) and pass it as `grantSource`, or register an app-wide one built with
  `memoize: false` through `registerSubscriptionFeatureSource()`, which writes
  the features slot key `FEATURE_GRANT_SOURCE_SLOT_KEY`. It reads
  `SubscriptionResolver.resolveFeatureGrants()`, which shares the
  version-pinning and entitlement rules of `resolveEntitlements()` but never
  evaluates thresholds, so a flag check reads no usage meters. Missing
  subscription tables (`isMissingSubscriptionTableError`) and no entitled
  subscription report no grants silently; every other error propagates.
  `findGrantingPlan()` names the first active plan by `sortOrder` visible in
  the current context.
- **Entitlement change hook (#4759).** `src/services/entitlement-changes.ts`.
  The host wraps its billing-webhook write in
  `trackEntitlementChange({ tenantId, resolver }, apply)`: it snapshots
  `resolveFeatureGrants()` (keys plus grant `metadata`, no usage reads)
  before and after, diffs `gained` / `lost` / `changed` (metadata, e.g. a
  plan budget) and calls listeners registered with
  `registerEntitlementChangeListener()` (a `Symbol.for` slot) or passed in.
  Listeners run after `apply`; their failures are returned in `failures`,
  never thrown, and never undo the write, so listeners must be idempotent.
  An `apply` error propagates and notifies nobody. A redelivered webhook
  diffs to no change, so a lost reaction is repaired by the consumer's
  reconcile entry point (hosted inference: `createHostedInferenceReconciler()`
  with `snapshotEntitlements()`), run on redelivery or a schedule. Listeners satisfy the
  structural type (smrt-inference's hosted listener), so this package
  depends on none of them.
