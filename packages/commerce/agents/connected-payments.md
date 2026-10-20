# Tenant-owned connected payment accounts (#3831)

A tenant (for example a co-op) is paid into its own Stripe Connect **Standard**
account. Checkouts are direct charges on that account, the platform's share is
an application fee, and the platform never holds the tenant's money. Source:
`src/connected-payments.ts`, `src/models/TenantPaymentAccount.ts`,
`src/models/TenantPaymentWebhookEvent.ts`.

## Model

`TenantPaymentAccount { tenantId, backendId, environment, providerAccountId,
status, chargesEnabled, detailsSubmitted, payoutsEnabled, capabilitiesJson,
capabilitiesObservedAt, feePolicyRef, disabledAt, disabledReason }`.

- Tenant-scoped (`required`), native UUID tenant ids. Two unique indexes:
  `(tenantId, backendId, environment)` and
  `(backendId, environment, providerAccountId)`, so the database refuses a
  second owner of a provider account even if a command check were bypassed.
- `status`: `pending` (details not submitted), `restricted` (details
  submitted, charges or payouts off), `enabled` (charges, details and payouts
  all on), `disabled` (operator; refreshes keep it off). Only `enabled` takes
  new charges.
- Read-only generated surface (REST, MCP and CLI: `list`/`get` and read methods only); never deleted. `save()` refuses any write outside the
  commands, any change of tenant/backend/environment, and a provider account
  change outside the relink command.
- Connected `Payment` rows and connected `PaymentIntent` creation/option
  writes need the commands' internal authority (`connected-payments-internal.ts`,
  per tenant), so no generated REST/MCP/CLI write can forge or advance them;
  connected payments and refunds are never deleted. A checkout's identity
  includes its environment (`PaymentIntent.connectedEnvironment`): the same
  `acct_` id exists in test and live.
- `TenantPaymentWebhookEvent` (`_smrt_tenant_payment_webhook_events`, system
  table, unique `(backendId, environment, eventId)`) stores processed event ids;
  the SDK's dedupe is in memory only.
- `PaymentIntent` and `Payment` gain server-managed `connectedAccountId` and
  `applicationFeeCents` (`Payment` also `refundOfPaymentId` and
  `connectedRefundState`), frozen once settled. A connected intent settles only
  with a Payment on the same account and fee, and its account, fee and payment
  options (which name the provider session settlement re-reads) are frozen
  from creation, so a generated update cannot repoint it. A connected
  `Payment` (charge or refund) keeps its kind, amounts, currency, provider
  references, account, fee and refunded payment from its first write, even
  while pending.

## Commands

All take an explicit `tenantId` and check ownership against it, so a
privileged or system caller is refused the same way. There is no fallback to
the platform account.

| Command | Does |
|---|---|
| `onboardTenantPaymentAccount` | Create the Standard account (per-tenant idempotency key) and store it; returns the existing one on retry. |
| `createTenantOnboardingLink` | Single-use onboarding URL. A bearer secret: redirect, never log or store. |
| `linkTenantPaymentAccount` | Link an existing account; `replace: true` relinks. Refused (`ACCOUNT_IN_USE`) when another tenant holds it or its `smrt_tenant_id` metadata names another tenant. An account whose metadata names no tenant needs `ownershipVerified: true` (the host proved control, for example Stripe OAuth). |
| `refreshTenantPaymentAccount` | Snapshot from `getAccountCapabilities`, re-derive status. |
| `setTenantPaymentAccountDisabled`, `setTenantPaymentFeePolicy` | Operator switches. |
| `requireEnabledTenantPaymentAccount` | Throws `NO_ENABLED_ACCOUNT` unless enabled. |
| `createConnectedCheckout` | Checkout on the tenant's account with `stripeAccount` + `applicationFeeAmount` (integer minor units from the caller's fee policy; `0` for none; below the amount). The intent (account, environment, fee, expiry) is recorded before the provider call and the option naming the provider session is added once, so a retry replays the same request (the expiry is part of the provider idempotency key) and recovers a lost answer; once the recorded expiry is under 31 minutes away the retry asks for a fresh session with a renewed expiry (the lost URL never reached the buyer). The requested amount and currency are recorded too: a retry with a different price, environment, account or fee is refused; a retry of a closed (expired, cancelled, settled or lapsed) quote gets `QUOTE_CLOSED`; an explicit `expiresAt` too close to replay must be replaced by the caller. |
| `handleConnectedPaymentWebhook` | See below. |
| `refundConnectedPayment` | Refund on the tenant's account; `refundApplicationFee` is required; partial and full. The refund row is written (`requested`, holding its amount) before the provider is asked; only a provider-`succeeded` refund is journaled, `pending` waits for the refund update, `failed` (including a first request the SDK refused before sending) releases the amount; a re-sent request must repeat its `refundApplicationFee` (stored in the frozen `applicationFeeRefunded`). A retry with the same key returns a recorded result, or re-sends a lost request with the same provider idempotency key within 23 hours (older lost requests wait for the refund update). Once booked refunds cover the payment it is marked `REFUNDED` and its intent retired. |
| `createStripeConnectGateway` | Platform `StripeAdapter` from smrt-secrets. |

## Webhooks

`handleConnectedPaymentWebhook({ db, gateway, environment, endpoint, payload,
signature, resolveSettlementAccounts })`:

1. The SDK verifies the signature **before** routing, then maps the event's
   connected account to its `TenantPaymentAccount` (cross-tenant read under
   `withSystemContext`, the one reviewed cross-tenant path). Unknown accounts
   throw the SDK's `PaymentNotOwnedError`.
2. The event's `livemode` must match `environment` (`ENVIRONMENT_MISMATCH`).
3. A stored event id returns `{ duplicate: true }` with its first outcome (and the `application_fee` details, so a host can still book them).
4. `account.updated` applies the snapshot unless an earlier second than the
   stored one (`stale_account_update`). `application_fee.*` (platform endpoint,
   `endpoint: 'platform'`) is routed to the tenant and reported, not booked.
   A payment event loads the quote **in the resolved tenant** and refuses
   (`QUOTE_NOT_OWNED`) unless it belongs to that tenant and account, then
   re-reads the Checkout Session from the provider, so delivery order never
   matters. A provider-confirmed checkout settles even when its notice
   arrives after the price lock (the session expires with the lock); a
   payment confirmed for a quote already expired or cancelled is reported
   `late_payment` and posts nothing. `account.updated` reloads the row and
   refuses an event for a provider account the row no longer holds; a
   concurrent operator write fails the revision-guarded save (retried by the
   provider). Refund updates (`charge.refund.updated`, `refund.*`) book or fail
   a pending refund recorded by `refundConnectedPayment` on that account;
   terminal states never move back. Refunds made by the command carry
   `metadata.smrt_refund_id` and are matched by it (an unknown one throws
   `REFUND_NOT_RECORDED`; an amount differing from the row throws
   `AMOUNT_MISMATCH`). Refunds made elsewhere are reported. Settlement records a `Payment` (deterministic id from the intent)
   through `recordPayment()` and marks the intent paid. `refunded` events are
   reported (`refund_reported`), never booked automatically.
5. The event id is stored only after processing succeeds; a refusal throws,
   so respond non-2xx and nothing unprocessed is acknowledged.

## Accounting

The direct charge arrives net of the fee, which the provider withheld at
source: `recordPayment()` debits cash `amount - fee`, debits
`applicationFeeAccountId` `fee`, and credits receivables `amount`. The fee is
an expense already paid, never a payable to the platform. A payment with a fee
and no `applicationFeeAccountId` is refused. Refund journals reverse the
refunded amount; a refunded application fee is reported by
`application_fee.refunded` for the host to book.

## Operator setup

- smrt-secrets (held by the installation tenant, `secretsTenantId`):
  `stripe-connect-<env>-secret-key` (`sk_`/`rk_` key of that environment),
  `stripe-connect-<env>-webhook-secret` (platform endpoint),
  `stripe-connect-<env>-connect-webhook-secret` (Connect endpoint). Values
  never appear in errors.
- Stripe: one platform endpoint (`application_fee.created`,
  `application_fee.refunded`) and one Connect endpoint (`account.updated`,
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`,
  `charge.refunded`, `charge.refund.updated`), per environment.
- Each tenant needs ledger accounts for cash, receivables and the platform fee
  expense, returned by `resolveSettlementAccounts`.

## Known limits

A `requested` refund the provider never made (a request lost in transport
and not retried within 23 hours, or one the provider rejected — the SDK does
not expose the HTTP status, so a rejection cannot be told from an unreadable
success) holds its amount and books nothing until an operator resolves it.
Automatic reconciliation needs an SDK refund read and error status
([sdk#1430](https://github.com/happyvertical/sdk/issues/1430)).

Relinking strands open checkouts on the old account and refuses refunds of
its payments (`ACCOUNT_NOT_OWNED`). Concurrent refunds with different keys are
capped by the provider, not locally. Payments confirmed after an intent
expired or was cancelled are reported `ignored` for an operator.
