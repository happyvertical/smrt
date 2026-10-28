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
| `createConnectedCheckout` | Checkout on the tenant's account with `stripeAccount` + `applicationFeeAmount` (integer minor units from the caller's fee policy; `0` for none; below the amount). The intent (account, environment, fee, expiry) is recorded before the provider call and the option naming the provider session is added once, so a retry replays the same request (the expiry is part of the provider idempotency key) and recovers a lost answer; once the recorded expiry is under 31 minutes away the retry asks for a fresh session with a renewed expiry (the lost URL never reached the buyer). The requested amount and currency are recorded too: a retry with a different price, environment, account or fee is refused; a retry of a paid checkout returns it with `settled: true` (no URL; never charge again); a retry of an unpaid closed (expired, cancelled or lapsed) quote gets `QUOTE_CLOSED`; an explicit `expiresAt` too close to replay must be replaced by the caller. |
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
5. Connected `charge.dispute.*` events re-read the typed dispute through the
   public SDK (`gateway.getDispute`, optional for older custom gateways but
   required for dispute delivery), scoped to the verified account and environment. They locate one
   settled payment in that tenant by provider payment-intent/charge reference;
   when none exists, `gateway.lookupCheckout` resolves authoritative ownership
   by PaymentIntent/Charge in that same account and environment. Only a complete
   provider `no_match` is acknowledged as `dispute_reported`, without any journal
   or dispute projection. A matched quote must belong to a persisted intent in
   that tenant/account/environment (and match the saved session when present);
   a missing local settlement then refuses delivery (`DISPUTE_NOT_RECORDED`)
   until settlement arrives, including when checkout creation lost its response
   and saved no option. Unknown quote/tenant/account/environment, conflicting
   session identity, ambiguous or incomplete lookup and provider failure refuse
   delivery. An older custom gateway without `lookupCheckout` refuses this
   zero-settlement case with `CONFIGURATION`; it never guesses from absent rows.
   Unknown statuses or balance transaction kinds,
   currency conversions, changed evidence and missing fee configuration refuse
   delivery for operator reconciliation. No dispute is acknowledged as ignored.
6. The event id is stored only after processing succeeds; a refusal throws,
   so respond non-2xx and nothing unprocessed is acknowledged.

## Accounting

The direct charge arrives net of the fee, which the provider withheld at
source: `recordPayment()` debits cash `amount - fee`, debits
`applicationFeeAccountId` `fee`, and credits receivables `amount`. The fee is
an expense already paid, never a payable to the platform. A payment with a fee
and no `applicationFeeAccountId` is refused. Refund journals reverse the
refunded amount; a refunded application fee is reported by
`application_fee.refunded` for the host to book.

## Dispute accounting and recovery (#4262)

`TenantPaymentDispute` is a tenant-owned, command-written projection with no
generated API/CLI/MCP surface. Its retained snapshot records provider lifecycle
and all posted balance transaction evidence. A payment revision fence serializes
reconciliation before the authoritative provider read. Every new provider
balance transaction gets one deterministic, posted journal in the same database
transaction as the snapshot. A crash rolls back both; a crash saving the inbox
replays the snapshot safely. Duplicate event ids return `paymentId` too. A
redelivery whose historical outcome is `ignored` is reconciled and updates that
inbox outcome; other processed outcomes stay deduplicated.

Posts use provider integer minor units, never lifecycle status as money proof:
cash changes by `net`, receivables by `-amount`, dispute fee expense by `fee`.
For example, a 10,000 withdrawal with a 1,500 fee credits cash 11,500, debits AR
10,000 and expense 1,500. A reinstatement posts the opposite balances from its
own provider transaction. Configure `disputeFeeAccountId` on the settlement
accounts whenever fees occur. The provider's balance transaction must be an
`adjustment`, with optional category `dispute` or `dispute_reversal`, and in the
settlement currency. Unknown contracts fail closed until supported explicitly.

Original payment, invoice allocations, payouts, refund rows and settlement
journals remain historical evidence. Reconciliation records the resulting
receivable even when the invoice was already paid or a supplier payout confirmed;
it does not collect the debt, unwind an allocation, reverse a supplier remittance,
or send a provider refund. Hosts must show/recover that receivable operationally.
Lifecycle updates with no balance evidence record status and post no money.

Before deployment, run the normal commerce schema migration to add
`tenant_payment_disputes` and the webhook event's optional `paymentId` column.
Replay previously ignored deliveries by having the provider redeliver the original
signed Connect webhook to the updated endpoint (a fresh valid signature is
required; do not bypass signature validation or manually delete inbox history).
Ordering uses current provider state, so redelivering an older event after a
closed dispute cannot revert its postings. Retain the original connected account
mapping: relinking remains an explicit operation that strands old-account events.
The complete Payment/ledger contract runs on SQLite and PostgreSQL; the existing
DuckDB checkout-only lane does not support Payment's full FK closure.

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
  `charge.refunded`, `charge.refund.updated`, `charge.dispute.created`,
  `charge.dispute.updated`, `charge.dispute.closed`,
  `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`), per environment.
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

## Frozen fee-policy provenance (#4263)

At the authoritative price calculation, pass `feePolicyRef` to
`createConnectedCheckout`: an opaque immutable version reference (for example
`bakery-membership:version:1`). It is host-attested evidence, not a lookup or an
authorization grant; the host must resolve and authorize the policy within the
explicit tenant before calling. This command validates account ownership and
never reads another tenant's policy. Nonempty references cannot contain leading
or trailing whitespace. Omission stores the empty string for unversioned hosts.

The intent's server-managed `connectedFeePolicyRef` freezes **before** the
provider request, alongside price and fee, including when that request fails.
Every retry must repeat the original reference, even when a new agreement
version yields the same cents. A mismatch is refused before any provider call.
Keep `offeringRef` and `idempotencyKey` tied to the purchase; changing them to
encode an amendment would create another charge. Amendments to the account's
live `feePolicyRef` cannot rewrite a checkout. The reference follows settlement
to `Payment` and any command-created refunds and cannot be edited there.
Existing checkouts with no reference accept only an omitted reference on retry;
they are never retrospectively attributed to the current account policy.
