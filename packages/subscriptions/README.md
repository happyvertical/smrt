# @happyvertical/smrt-subscriptions

Tenant subscriptions, feature grants, immutable usage evidence, thresholds,
effective-dated client pricing, spending policies, and entitlement resolution
for s-m-r-t applications.

The package is provider-neutral. Stripe or another billing provider may be
recorded as binding metadata, but provider API calls belong in an injected SDK
accounting adapter.

## Installation

```bash
pnpm add @happyvertical/smrt-subscriptions
```

Add `svelte` for the optional plan, subscription, and threshold components.

## Resolve entitlements

```ts
import { SubscriptionResolver } from '@happyvertical/smrt-subscriptions';

const resolver = await SubscriptionResolver.create({ db: 'app.db' });
const context = await resolver.loadEntitlementContext('tenant-1');

const result = await resolver.resolveTenantEntitlements('tenant-1', {
  context,
});

if (!result.allowed) {
  throw new Error('Subscription thresholds do not allow this operation');
}

console.log(result.planKey, result.featureKeys, result.thresholdEvaluations);
```

Create one resolver per request or application unit of work and reuse the
loaded `EntitlementResolutionContext` when several checks need the same
subscription and plan.

### Plan grants as feature flags

`SubscriptionFeatureSource` feeds a tenant's plan grants into
`@happyvertical/smrt-features`, so `FeatureResolver` and its `requireFeature()`
gate answer from the plan. Build one per request with
`SubscriptionFeatureSource.create(dbOptions)` and pass it as `grantSource`, or
register an app-wide one (`memoize: false`) with
`registerSubscriptionFeatureSource()`. With no subscription tables or no
entitled subscription it reports no grants. A global feature override still
outranks a grant (an operator stop), and a tenant override outranks both.

## Core model

- `SubscriptionPlan` is tenant-scoped by `(tenantId, planKey)` and stores
  feature grants, thresholds, and a `free`, `fixed`, or `pay_what_you_can`
  pricing mode. Amounts (`priceAmount`, `minimumAmount`, and
  `suggestedAmount`) are integer minor units. Provider bindings are optional
  metadata (`externalProvider`, `providerProductId`, `providerPriceId`).
- `TenantSubscription` binds a tenant or external subscriber to a plan over an
  effective period and records its chosen `agreedAmount` in integer minor
  units for pay-what-you-can plans. Such subscriptions require an amount at
  least the plan minimum; free/fixed subscriptions must leave it null.
  Free and pay-what-you-can plans require `priceAmount: 0`; fixed plans use
  `priceAmount`. Monthly commerce period-close bills tenant subscribers using
  their agreed amount for pay-what-you-can, never the suggested amount, and
  skips free plans. External subscriber invoice routing remains host-owned. Pricing
  mode and minimum are immutable after the plan is saved; create a
  new plan instead. Other term changes publish a new plan version (see
  [Plan versions](#plan-versions-and-paid-periods)).
  Invalid legacy pricing fails only its payer group at period close and reports
  the subscription ID while other payer groups continue. Ordinary subscription
  writes resolve only their own tenant's plans or legacy global plans; trusted
  system-context billing can link a seller's plan to its child tenant.
  Entitlement resolution validates plan ownership on both reader and supplied
  context paths; trusted seller-to-child resolution requires explicit system
  context too.
- `SubscriptionPlanVersion` is an immutable, effective-dated snapshot of a
  plan's terms; subscriptions pin the version their period paid for.
- `TenantUsageMetric` is immutable, idempotent usage evidence.
- `SubscriptionResolver` combines current subscription, plan, and batched usage
  summaries into one entitlement decision.
- `TenantUsageMeter` records and summarizes ordinary and AI usage.
- `PricingRule`, `ClientCharge`, and `BillingAdjustment` model effective-dated
  commercial evidence.
- `SpendingPolicyEvaluator` applies scoped budget behavior without embedding a
  payment provider.
- `PriceBook`, `PriceBookAssignment`, `RetailCharge`, and `CreditGrant` add
  reseller pricing, the reseller's retail ledger, and prepaid credit (see
  [Reseller billing](#reseller-billing)).

Subscribers are polymorphic: tenant subscribers use a tenant ID, while external
subscribers add a stable external discriminator. Utilities such as
`normalizeSubscriber()` and `assertSubscriberInvariant()` keep that identity
coherent.

## Upgrade note

`SubscriptionPlanCollection.findByPlanKey` now requires `(tenantId, planKey)`;
pass `null` explicitly for legacy global plans. Update callers from the old
single-argument signature. Pricing mode and minimum cannot be edited after
persistence, even before the first subscriber, so a concurrent signup cannot
observe terms that change mode underneath it. Existing fixed-price edits and
current-period entitlement versioning arrived with #4032 (see
[Plan versions](#plan-versions-and-paid-periods)). Concurrent first creates
for one `(tenantId, planKey)` use a strict insert: one succeeds and a collision
fails without changing the winner. Retry by reading the existing plan; a
sequential create with matching mode/minimum retains natural-key upsert behavior.
Retrying different pricing mode/minimum is rejected. The provider-neutral price
lookup falls back to legacy Stripe IDs when the binding is Stripe or unspecified;
explicit bindings to other providers do not use that fallback. PlanPicker accepts
optional pricing mode, minimum and suggested amounts, labeling free plans and
PWYC terms explicitly instead of displaying them as zero fixed-price plans.

Existing databases created before #3829 may retain the global
`_smrt_subscription_plans_plan_key_idx` on older migration runners. Run
`scripts/migrate-3829-drop-legacy-plan-key-index.ts` after the ordinary manifest
migration so different tenants can reuse a plan key. The script supports SQLite
and PostgreSQL and refuses DuckDB, whose inline unique constraint needs a
reviewed table rebuild.

## Plan versions and paid periods

A `SubscriptionPlan` is the stable tier identity, scoped by
`(tenantId, planKey)`. Its terms — `status`, `priceAmount`, `currency`,
`billingInterval`, `pricingMode`, `minimumAmount`, `suggestedAmount`,
feature grants and thresholds — are published as immutable
`SubscriptionPlanVersion` rows (#4032):

- Saving a plan whose terms differ from its latest version publishes the next
  version (1, 2, 3 …), effective now. `plan.publishTerms({ effectiveFrom })`
  schedules a future amendment instead. Versions are append-only (no update,
  no delete) and monotonic: a version cannot start before the previous one.
  Re-saving unchanged terms, or changing only `name`/`description`/metadata,
  publishes nothing.
- A version is in force from its `effectiveFrom` until the next version's;
  an instant before the first version resolves to version 1.
- `TenantSubscription.planVersionId` is the version frozen for the current
  period (`planVersionPinnedAt`, `planVersionPinReason`, and
  `planVersionPinNote` audit it). It is maintained on every save:
  - a new subscription pins the version in force at its period start
    (`currentPeriodStart ?? startedAt`);
  - **renewal** — a save whose new `currentPeriodStart` is at or after the
    stored `currentPeriodEnd` (or, for an open-ended row, after the stored
    start) — re-pins the version in force at the new boundary, for the plan
    the row now names. A downgrade or a plan change that removes features is
    applied this way. Moving the start within a paid period is not a renewal,
    and a renewal saved before its start date may change the pinned terms
    only as an upgrade (otherwise save it once the period has started). It
    pins the version scheduled for its boundary at save time; an amendment
    published later but effective before that boundary applies from the
    following renewal (or re-save the renewal after the period starts).
    Period dates are host/provider-owned: shortening `currentPeriodEnd` ends
    the paid period;
  - at creation and renewal the boundary decides the version: naming any
    other `planVersionId` (for example to grandfather an import) needs an
    authorized replacement;
  - within an unchanged period, a different plan or version is accepted only
    when it is an **upgrade** (`isEntitlementUpgrade()`: every enabled feature
    stays enabled and no threshold is added, lowered or made stricter), or
    when the period no longer entitles. Anything else is rejected;
  - `subscription.replacePlanVersion({ policy: 'authorized', reason })` is the
    explicit, audited escape hatch for an approved in-period downgrade or
    correction. `policy: 'upgrade'` applies an amended version of the same
    plan mid-period when it only adds.
- **Cancellation** keeps the paid period: a subscription canceled while it
  entitled (`active`/`trialing` within its period) records
  `retainsPaidPeriod` and entitles until `currentPeriodEnd`, then resolves
  nothing. A subscription canceled from `incomplete`, `past_due` or `unpaid`
  (for example a provider's `incomplete_expired`) entitles nothing. For an
  immediate cancellation of a paid period (e.g. with a refund) set
  `currentPeriodEnd` to the cancellation time.

`SubscriptionResolver` resolves entitlements at `options.now` from the pinned
version, not the live plan: editing, archiving, or removing a feature from a
plan never changes a paid period. A pinned version that cannot be found, or
whose status is not `active`, fails closed. `EntitlementResolution` reports
`planVersionId` and `planVersion`; `EntitlementResolutionContext` carries
`planVersion`, validated against the subscription's plan, pin and tenant like
`plan`. Resolvers built from custom readers without `planVersions` keep the
live-plan behavior.

```ts
// A co-op removes a perk. Paying members keep it until their renewal.
plan.setFeatureGrants(['coop:vote']);
await plan.save(); // publishes version 2, effective now

// Schedule an entitlement change from a future date.
plan.setFeatureGrants(['coop:vote', 'coop:shift-swap']);
await plan.publishTerms({ effectiveFrom: new Date('2027-01-01T00:00:00Z') });

// Resolve what a member is entitled to at an instant.
const result = await resolver.resolveEntitlements(subscriber, { now });
result.planVersion; // the version their current period paid for
```

The plan row always shows the latest published terms, including a scheduled
version's. Hosts that charge from the plan row must price from the pinned
version instead; commerce period-close still reads the live row until #4146,
so do not schedule a price change ahead of time while relying on it.

The plan row is written before its version. If publishing fails, the save
rejects with the row already updated and the next save publishes the missing
version; wrap the save in `plan.withTransaction()` when both writes must be
atomic.

### Migrating existing data

1. Run the ordinary manifest migration (`smrt db:migrate`). It adds the
   `_smrt_subscription_plan_versions` table and the nullable `plan_version_id`,
   `plan_version_pinned_at`, `plan_version_pin_reason` and
   `plan_version_pin_note` and `retains_paid_period` columns on
   `_smrt_tenant_subscriptions`. Nothing is dropped or rewritten. Existing
   `canceled` rows default to `retains_paid_period = false`, so they stay
   unentitled exactly as before.
2. Run `migrateSubscriptionPlanVersions(db)` once. Every plan without versions
   gets version 1 — its current terms, effective from the plan's creation —
   and every unpinned subscription is pinned to it with
   `planVersionPinReason: 'migration'`. Entitlements are unchanged. The run is
   idempotent, works across tenants in system context, and reports any
   subscription it could not re-save in `failed` (that row keeps resolving
   through version 1).

Until step 2, unpinned subscriptions to plans without versions keep resolving
from the live plan, and the first edit of such a plan records its pre-edit
terms as version 1 before publishing the change.

## Thresholds and spending

Thresholds define a metric key, time window, limit, and enforcement behavior.
The resolver batches metric reads when possible. Do not bypass tenant context
or repeatedly construct a new resolver inside one request.

Commercial usage records client-facing prices separately from usage evidence.
Spending policy decisions can allow, warn, require approval, or deny based on
the configured behavior and scope.

## Reseller billing

Resellers buy a service at wholesale and resell it to their own child tenants.
Parentage and the billing owner come from `smrt-tenancy`'s
`BillingRelationshipService`; this package prices usage against it.

- **Price books.** A `PriceBook` is published by one seller tenant and is
  either `wholesale` (what a provider charges a reseller) or `retail` (what a
  reseller charges its children). Its prices are ordinary `PricingRule` rows
  carrying the book's `priceBookId`, one row per currency.
- **Assignment per relationship.** `ResellerBillingService.assignPriceBooks()`
  picks, for one child, the wholesale book and currency and (optionally) the
  reseller's retail book and currency. An assignment made under one reseller
  never applies after the child moves to another.
- **Rating.** `CommercialUsageService.rateUsage()` resolves the child's
  relationship and returns a `UsageRating`:
  - self-billed or unrelated tenant: one direct `ClientCharge`, priced exactly
    like `price()`;
  - reseller-billed: a wholesale `ClientCharge` payable by the reseller
    (`tenantId` = reseller, `usageTenantId` = child) and, with a retail book,
    a `RetailCharge` the child owes the reseller, committed together.

  A usage event is rated once. `ClientCharge` keeps exactly one row per usage
  event, so a later billing-owner change returns the original rating instead
  of charging a second payer.
- **Delegated spending.** `setDelegatedSpendingPolicy()` writes a
  `SpendingPolicy` on the child with `setByTenantId` = the parent. The ordinary
  `SpendingPolicyEvaluator` enforces it (observe, warn, approval, block), and
  the child cannot edit, delete, or overwrite it. Parents change or retire
  (`active: false`) their policies through the same method. A policy's `basis` selects
  what it counts: `billed` (what the tenant pays the provider, the default),
  `retail` (what it owes its reseller), or `wholesale` (what the parent pays
  for this child's usage).
- **Prepaid credit.** A `period: 'balance'` policy's limit is the sum of its
  `CreditGrant`s; spend accumulates from `balanceFrom`. Its currency and
  period cannot change once saved; create a new balance instead. Grants are append-only (updates and deletes are refused)
  and idempotent per `source`/`sourceId`. Pass `autoTopUp` to
  `SpendingPolicyEvaluator.create()` to be called when a charge would exhaust a
  balance; return a grant once the host has secured the funds. The evaluator
  never calls a payment provider. Before charging, a hook can call the
  request's `currentShortfall()` to recompute the shortfall against the
  current balance (another evaluation may have topped it up meanwhile); the
  evaluator re-reads the balance after the hook returns either way.
  smrt-commerce's `BillingRuntime.autoTopUpHook()` charges a saved card.

```ts
import { BillingRelationshipService } from '@happyvertical/smrt-tenancy';
import {
  CommercialUsageService,
  ResellerBillingService,
} from '@happyvertical/smrt-subscriptions';

const relationships = await BillingRelationshipService.create({
  db,
  tenantExists,
});
const reseller = await ResellerBillingService.create({
  db,
  billingRelationships: relationships,
});
await reseller.definePrice({
  priceBookId: retailBook.id,
  ruleKey: 'tokens',
  metricKey: 'ai.tokens',
  strategy: 'fixed_unit',
  prices: [
    { currency: 'USD', terms: { unitPrice: 5 } },
    { currency: 'EUR', terms: { unitPrice: 4.6 } },
  ],
});
await reseller.assignPriceBooks({
  childTenantId,
  wholesale: { priceBookId: wholesaleBook.id, currency: 'USD' },
  retail: { priceBookId: retailBook.id, currency: 'EUR' },
});

const rating = await commercial.rateUsage({
  usageEventId,
  billingRelationships: relationships,
  approved: true,
});
```

Mutations require a system context, a super-admin bypass, or a host
`authorize` callback, like `BillingRelationshipService`; a seller may also
define prices in its own book under its own tenant context. The callback
receives the tenant whose authority the action exercises: the book's publisher
for `define_prices` and `assign_wholesale_price_book`, the parent for
`assign_retail_price_book` and `manage_child_spending`. Bind every decision to
the caller, and never authorize a reseller for the wholesale leg that charges
it. The package refuses a wholesale book published by the reseller or child it
would charge, but whether a publisher is a legitimate provider for that
reseller (`resellerTenantId` in the request) is the host's decision. The
calls first read the child's relationship through `BillingRelationshipService`
in the caller's context, so a provider assigning a wholesale leg also needs
that service's `authorize` to grant it `read` for the child. Once
authorized, the service writes in a system context, because a parent's writes
land on rows the child owns.

```ts
const reseller = await ResellerBillingService.create({
  db,
  billingRelationships: relationships,
  authorize: async ({ action, tenantId, resellerTenantId }) => {
    const caller = currentTenantId();
    if (caller !== tenantId || !(await isBillingAdmin(caller))) return false;
    return action === 'assign_wholesale_price_book'
      ? isProviderFor(caller, resellerTenantId)
      : true;
  },
});
```

Rating reads a seller's books across tenants, so run it where the host's
tenancy rules allow that (typically a system context). Spending evaluation can
run in the child's own tenant context: a `wholesale`-basis policy reads only
the sum of the parent's charges for that child's usage. Pass
`billingRelationships` to `SpendingPolicyEvaluator.create()` so a former
parent's delegated policies stop applying after the child changes reseller;
without it they keep applying (fail closed), and the new parent may replace
them by name. A delegated balance counts only credit granted by its current
parent. A former parent's prepaid balance cannot be taken over by name; it
keeps its credit ledger (reversible in a system context), and the new parent
creates its own balance. A parent's `retail` cap counts only what the child owes that
parent.

## Billing host glue (Stripe)

`createBillingHost()` is the reusable checkout, webhook and customer-portal
wiring for hosts that sell a `SubscriptionPlan` through Stripe (#4786). A host
configures it; it does not re-implement it. Every provider call goes through
`@happyvertical/accounting`; there are no direct Stripe calls here. Web only:
phone apps never sell a subscription in-app.

### Host configuration

| Variable | Meaning |
| --- | --- |
| `STRIPE_SECRET_KEY` | Secret or restricted key (`sk_` / `rk_`). |
| `STRIPE_WEBHOOK_SECRET` | Webhook endpoint signing secret (`whsec_`). |
| `STRIPE_WEBHOOK_TOLERANCE` | Optional. Maximum signature age in seconds, 1 to 900, default 300. |
| `BILLING_METADATA_SECRET` | Optional. Secret that signs new Checkout metadata. Unset: the webhook secret is used, so rotating the webhook secret also rotates this. Set it to a stable value to decouple the two. |
| `BILLING_METADATA_PREVIOUS_SECRETS` | Optional, comma-separated. Retired metadata secrets still accepted when a completed Checkout is verified. |
| `STRIPE_PRICE_<PLAN_KEY>` | Price id sold for a plan, for example `STRIPE_PRICE_PRO`. Wins over `SubscriptionPlan.providerPriceId`. |
| `BILLING_SUCCESS_URL`, `BILLING_CANCEL_URL`, `BILLING_PORTAL_RETURN_URL` | Fixed absolute https destinations (plain http only for localhost). |

`readBillingEnv(process.env, { planKeys })` validates these and keeps the
secrets in non-enumerable properties, so logging the config does not print
them. Its errors name the variable, never the value.

**Rotating secrets.** A Checkout session is signed when it is created and
verified when it completes, which can be days later. If the signing secret
changes in between (by default it is the webhook secret), a paid session no
longer verifies and the purchase is dropped. Before rotating, put the outgoing
secret in `BILLING_METADATA_PREVIOUS_SECRETS` (`metadataVerificationSecrets`)
and keep it there until sessions created under it have expired. A completed
session that claims to be ours but does not verify under any accepted secret
is logged at error level (`billing.webhook.checkout_signature_invalid`), so a
dropped purchase is visible.

### Recipe (SvelteKit)

```ts
// src/lib/server/billing.ts
import { getAccountingProvider } from '@happyvertical/accounting';
import {
  createBillingHost,
  readBillingEnv,
  TenantSubscriptionCollection,
} from '@happyvertical/smrt-subscriptions';

const env = readBillingEnv(process.env, { planKeys: ['pro', 'team'] });
const provider = await getAccountingProvider({
  type: 'stripe',
  secretKey: env.stripe.secretKey, // read explicitly: non-enumerable on purpose
  webhookSecret: env.stripe.webhookSecret,
  webhookTolerance: env.stripe.webhookTolerance,
});
const { db } = await TenantSubscriptionCollection.create(smrtConfig);

export const billing = createBillingHost({
  provider,
  db, // needs transaction(): SQLite or PostgreSQL
  webhookSecret: env.stripe.webhookSecret,
  metadataSigningSecret: env.metadata.signingSecret,
  metadataVerificationSecrets: env.metadata.previousSecrets,
  webhookToleranceSeconds: env.stripe.webhookTolerance,
  urls: env.urls,
  prices: env.prices,
  logger, // optional; receives ids and reason codes only
});

// src/routes/api/billing/checkout/+server.ts  (authenticate and authorise first)
export const POST = async ({ request, locals }) => {
  const membership = await requirePermission(locals, 'billing.manage');
  return billing.handlers.checkout(request, {
    tenantId: membership.tenantId,
    email: membership.userEmail,
  });
};

// .../portal/+server.ts  -> billing.handlers.portal(request, { tenantId })
// .../webhook/+server.ts -> billing.handlers.webhook(request)   (no auth; signature only)
```

The webhook route must receive the raw body. Point the Stripe endpoint at it
and subscribe it to `checkout.session.completed` and
`customer.subscription.created|updated|deleted|paused|resumed`.

### What it guarantees

- **Checkout** takes only a plan key or id from the request. Tenant, price,
  customer and URLs come from the host's authenticated tenant, server
  configuration and the tenant's own subscription row. A plan must be visible
  to the tenant (its own or global), active, fixed-price and priced, and the
  tenant must not already hold a live Stripe subscription (use the portal to
  change plans). Only operator-owned (global) plans are sold unless the host
  sets `tenantPlans: 'allow'`, so a tenant that can write plan rows cannot buy
  entitlements it defined itself or shadow a plan key; set `allow` only when
  tenants cannot write `SubscriptionPlan`. `canPurchasePlan` adds host policy.
  The session metadata is HMAC-signed and bound to the server price, an
  expiry and, when known, the billing customer, so another integration on the
  same Stripe account cannot forge metadata for a tenant, and signed metadata
  cannot be reused for a different price or another customer's subscription.
- **First purchases are bound to the session the host created (#4814).** The
  host records each Checkout session id (table
  `_smrt_billing_checkout_sessions`: session id, tenant, expiry, status
  `pending`, `completed` or `needs_reconciliation`) before it returns the
  buyer's URL, and signs an expiry (`smrt_exp`, 25 hours, so a Stripe session's
  24 hours plus an hour) into the metadata. A paid session links a tenant only
  when, in order: the signature verifies, a record exists for exactly that
  session id, it is still `pending`, it names the same tenant as the signed
  metadata, and the event time (not the delivery time, so late webhook retries
  of an in-time payment still count) is before the signed and recorded expiry.
  Metadata copied onto another integration's session is therefore never
  linked, however it is paid. A completed session is single use: a second
  completion with the same session id changes nothing.
- **A paid session that cannot be bound is kept, not dropped.** If the record
  is missing, expired or names another tenant, the tenant is not linked, the
  event is claimed (no provider retry loop) and the session is stored as
  `needs_reconciliation` with a reason code (`session_record_missing`,
  `session_expired`, `session_record_mismatch`). The webhook answers 200 with
  `outcome: 'needs_reconciliation'` and logs
  `billing.checkout.needs_reconciliation` at error level (ids and codes only).
  A genuine buyer whose record was lost, or a session that was in flight when
  this binding was deployed (it has no record), lands here. An operator lists
  them with `host.listCheckoutsNeedingReconciliation()` and links one on
  purpose with `host.reconcileCheckout({ sessionId, tenantId, operatorId })`:
  server-side only (authenticate and authorise the operator first; it is not a
  request handler), it re-reads the subscription from the provider, requires
  it to be the subscription and customer recorded when the session was
  flagged, applies the same tenant/customer conflict checks as a normal
  completion, links once, and logs `billing.checkout.reconciled` with the
  operator id. Each listed row carries the paying `customerId`, the tenant the
  host recorded the session for (`targetTenantId`) and
  `claimedTenantHasOwnSession` (true suggests a copy of that tenant's signed
  metadata): confirm the customer is the tenant's own before linking. Treat a
  flagged session you did not expect as another integration's payment and close
  it with `host.dismissCheckout({ sessionId, operatorId, reason })` (terminal
  `dismissed`, logged with the operator id and reason), so it leaves the list.
  The list is paged (`{ limit, offset }`, default 200) and
  `host.countCheckoutsNeedingReconciliation()` gives the total.
- **Webhook** verifies the signature on the raw body with a bounded timestamp
  tolerance, then claims the event id durably in the same transaction as the
  subscription write (`runOnce`, `_smrt_run_once_claims`). A replay is a 2xx
  no-op; a failed apply rolls the claim back (non-2xx) so the provider's retry
  runs. Out-of-order events converge: each applied event records its time on
  the row and an older one is skipped, and a cancellation wins a same-second
  tie. A completed checkout reads the subscription back from the provider, so
  the row reflects current state however events were ordered. A plan change at
  the provider is applied as an authorised plan-version replacement, so
  feature keys flip within that one webhook (including a mid-period
  downgrade the provider billed).
- **Linking** is by provider ids stored on `TenantSubscription`. A subscription
  or customer already linked to one tenant is never re-linked to another, and
  an event for an unknown subscription is acknowledged and ignored.
- **Portal** opens the portal for the customer on the caller's own
  subscription row only.
- **Responses and logs** carry fixed messages, ids and reason codes. Provider
  error text is never returned, and anything shaped like a key is redacted
  before logging.

Operational notes: if a second Checkout for a tenant that already holds a live
subscription is paid (two tabs racing), the webhook cannot track it and logs
`billing.checkout.orphaned_subscription` at error level with the provider
subscription id; alert on it and cancel or refund that subscription at the
provider. Keep server clocks synchronised (NTP): event ordering compares the
provider's whole-second event time with this host's read-back time. A
concurrent duplicate of an event being applied answers
409 and Stripe retries it. Plans and which price backs which plan are the
owner's input; this module only maps them. No schema change is needed: event
claims use core's `_smrt_run_once_claims`, retained for its pruning window
(30 days by default), far longer than Stripe's three-day retry horizon.

## Hosted vault-account restart and supersede (#4841)

The hosted account layer (the service that holds the vault relay's admin
token) replaces a family's vault account after a restart. That is a takeover
of the backup line if done by the wrong person, so every action here is gated:

- `supersedeVaultAccount`, `unsupersedeVaultAccount` (relay admin `PUT` and
  `DELETE .../superseded-by`) and `provisionRestartAccount` (a fresh account
  linked to the tenant plus the working device's relay signing key, step 1 of
  the restart in the app-runtime README).
- Each requires the caller to be the tenant **owner** (`NotOwnerError`, code
  `not_owner`: a member, a device-only or layered session, no session, or an
  account of another tenant) **and** a **step-up**: the owner re-authenticated
  with a fresh password or passkey within `stepUpMaxAgeSeconds` (default 300;
  `StepUpRequiredError`, code `step_up_required`). A signed-in session or an
  unlocked device is not enough. See `smrt-users` "Step-up".
- The relay is called only after both checks pass, exactly once. Every attempt
  is written to your `audit` sink (`denied` with the reason code, `authorized`
  before the call, then `succeeded` or `failed`); records hold ids, codes and
  times, never a password, session id, token or key. If the `authorized`
  record cannot be written, nothing is done.
- Collaborators are injected: `session` (from `loadSessionContext`), `relay`
  (`VaultRelayAdminPort`; `createVaultRelayAdminClient({ baseUrl, adminToken })`
  speaks the admin HTTP API, and a `VaultRelay` instance fits in-process),
  `directory` (which tenant owns an account, and linking a new one so
  `backup.vault` resolves), and `audit`.

## Svelte entry point

`@happyvertical/smrt-subscriptions/svelte` exports provider-neutral,
presentational components:

- `PlanPicker`
- `SubscriptionSummary`
- `UsageThresholds`
- `CommercialOverview`

Hosts own data loading and mutation actions.

## Development

```bash
pnpm --filter @happyvertical/smrt-subscriptions test
pnpm --filter @happyvertical/smrt-subscriptions test:postgres
pnpm --filter @happyvertical/smrt-subscriptions typecheck
pnpm --filter @happyvertical/smrt-subscriptions build
```

See [`AGENTS.md`](./AGENTS.md) for provider, threshold, and resolver guidance.
