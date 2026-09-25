# @happyvertical/smrt-commerce

Commerce models for the s-m-r-t framework. Covers customers, vendors, contracts (5 STI types), invoices with ledger integration, payments, and fulfillment tracking.

## Installation

```bash
pnpm add @happyvertical/smrt-commerce
```

## Usage

```typescript
import {
  Customer, CustomerCollection,
  Order, ContractCollection,
  Invoice, InvoiceCollection,
  Payment, PaymentCollection,
  ContractStatus, InvoiceStatus, PaymentMethod
} from '@happyvertical/smrt-commerce';

// Create a customer linked to a profile
const customers = await CustomerCollection.create({ db });
const customer = await customers.create({
  profileId: 'profile-uuid',
  creditLimit: 1000000, // $10,000.00 — money is integer minor units
  paymentTerms: 'Net 30',
});
await customer.save();

// Create an order (STI contract type)
const contracts = await ContractCollection.create({ db });
const order = await contracts.create({
  _meta_type: 'Order',
  customerId: customer.id,
  subtotal: 100000, // $1,000.00
  taxAmount: 5000, // $50.00
  totalAmount: 105000, // $1,050.00
  currency: 'CAD',
});
await order.save();

// Create an invoice for the order
const invoices = await InvoiceCollection.create({ db });
const invoiceNumber = await invoices.generateInvoiceNumber();
const invoice = await invoices.create({
  customerId: customer.id,
  contractId: order.id,
  invoiceNumber,
  subtotal: 100000, // $1,000.00
  taxAmount: 5000, // $50.00
  totalAmount: 105000, // $1,050.00
});
await invoice.save();

// Recognize revenue (creates balanced journal in smrt-ledgers)
await invoice.recognizeRevenue({
  arAccountId: 'ar-account-id',
  revenueAccountId: 'revenue-account-id',
  taxAccountId: 'tax-account-id',
});

// Record a payment
const payments = await PaymentCollection.create({ db });
const payment = await payments.create({
  contractId: order.id,
  customerId: customer.id,
  amount: 105000,
  method: PaymentMethod.CREDIT_CARD,
});
await payment.save();

// Record payment with ledger integration
await payment.recordPayment({
  ledgerId: 'ledger-id',
  receivablesAccountId: 'ar-account-id',
  cashAccountId: 'bank-account-id',
});
```

## API

### Models

| Export | Description |
|--------|------------|
| `Customer` | Customer record with creditLimit, paymentTerms, tax exemption, addresses |
| `Vendor` | Vendor/supplier with leadTimeDays, minimumOrderAmount, currency |
| `Contract` | STI base class for all commercial agreements |
| `Estimate` | Quote or proposal sent to a customer |
| `Order` | Customer purchase order |
| `Lease` | Rental or lease agreement |
| `Agreement` | Service or maintenance agreement |
| `PurchaseOrder` | Order sent to a vendor/supplier |
| `ContractLineItem` | Line item within a contract |
| `Invoice` | Billing document with status lifecycle and ledger integration |
| `InvoiceLineItem` | Individual invoice line item |
| `Payment` | Payment record with method, status, and optional ledger journal |
| `PaymentAllocation` | Payment-to-invoice allocation |
| `Fulfillment` | Shipment/delivery tracking with carrier and address |
| `FulfillmentLineItem` | Individual fulfillment line item |
| `BillingAccount` | A payer's account with a seller: customer, provider customer, terms, standing |
| `BillingPeriodClose` | One payer's invoice for one period and currency; also the billing job target |
| `BillingLineSource` | The claim that a charge or plan period is billed on exactly one close |

### Collections

`CustomerCollection`, `VendorCollection`, `ContractCollection`, `InvoiceCollection`, `InvoiceLineItemCollection`, `PaymentCollection`, `PaymentAllocationCollection`, `FulfillmentCollection`

### Enums

| Export | Values |
|--------|--------|
| `ContractType` | `estimate`, `order`, `lease`, `agreement`, `purchase_order` |
| `ContractStatus` | `draft`, `sent`, `accepted`, `declined`, `completed`, `cancelled` |
| `CustomerStatus` | `active`, `inactive`, `suspended` |
| `VendorStatus` | `active`, `inactive`, `suspended` |
| `InvoiceStatus` | `draft`, `sent`, `viewed`, `partial`, `paid`, `overdue`, `cancelled`, `written_off` |
| `PaymentMethod` | `cash`, `check`, `credit_card`, `bank_transfer`, `crypto`, `other` |
| `PaymentStatus` | `pending`, `completed`, `failed`, `refunded`, `cancelled` |
| `FulfillmentStatus` | `pending`, `processing`, `shipped`, `delivered`, `cancelled` |
| `FulfillmentType` | `shipment`, `delivery`, `pickup`, `digital`, `service` |

### Types and Constants

| Export | Description |
|--------|------------|
| `Address` | Shared address interface (street1, street2, city, state, postalCode, country) |
| `RecognizeRevenueOptions` | Account IDs for invoice revenue recognition |
| `RecordPaymentOptions` | Ledger and account IDs for payment recording |
| `InvoiceNumberOptions` | Options for `generateInvoiceNumber()` (prefix, format) |
| `UNPAID_STATUSES` | Array of invoice statuses considered unpaid (sent, viewed, partial, overdue) |
| `COMMERCE_MODULE_META` | UI module metadata |
| `COMMERCE_UI_SLOTS` | UI slot definitions |

### Ledger Integration

Invoice and Payment integrate with `@happyvertical/smrt-ledgers` via dynamic import (optional dependency). Invoice stores `arJournalId` and `revenueJournalId` as plain string references to ledger journals. `recognizeRevenue()` creates a balanced AR entry (DR: Accounts Receivable, CR: Revenue, CR: Tax Payable). `recordPayment()` creates a balanced cash receipt entry (DR: Cash, CR: Accounts Receivable). Both methods return null or throw if the ledgers package is not installed.

### Cross-Package References

Customer and Vendor link to `@happyvertical/smrt-profiles` via plain `profileId` string. Invoice and Payment reference `@happyvertical/smrt-ledgers` journals via plain string IDs (`arJournalId`, `revenueJournalId`, `journalId`). All models use `@TenantScoped({ mode: 'optional' })` with nullable `tenantId`.

## Billing-period close

`BillingRuntime` turns approved `@happyvertical/smrt-subscriptions` charges into
invoices for each billing owner, pushes them to a payment provider with
provider-calculated tax, posts revenue to the ledger, and applies the
provider's webhook events. Every provider call goes through
`@happyvertical/accounting`; `createStripeBillingProvider()` adapts its Stripe
provider to the `BillingProvider` port. Money crossing the port is integer
minor units.

```ts
import { getAccountingProvider } from '@happyvertical/accounting';
import {
  BillingRuntime,
  createStripeBillingProvider,
  enqueueBillingPeriodClose,
  registerBillingRuntime,
} from '@happyvertical/smrt-commerce';

const stripe = await getAccountingProvider({ type: 'stripe', secretKey });
const billing = await BillingRuntime.create({
  db,
  sellerTenantId: platformTenantId,
  kind: 'provider', // or 'reseller' to bill a reseller's children
  provider: createStripeBillingProvider({ stripe, webhookSecret }),
  billingRelationships, // smrt-tenancy BillingRelationshipService
  ledger: {
    arAccountId,
    revenueAccountId,
    taxAccountId,
    cashAccountId,
    prepaidCreditAccountId,
  },
  onPayerStanding: async ({ payerTenantId, standing, db }) => {
    // suspend or reinstate the payer; runs in the event transaction
  },
});

// One account per payer: its customer, tax location, and terms.
await billing.upsertAccount({
  payerTenantId,
  name: 'Network Co',
  email: 'billing@example.test',
  billingAddress: { country: 'CA', postalCode: 'T0L 0A0' },
});

// Optional: bill this payer from its activation date instead of calendar
// months, prorating flat plans added mid-period (see "Billing cycles").
await billing.upsertAccount({
  payerTenantId,
  name: 'Network Co',
  billingAnchorAt: activatedAt,
  prorateFlatPlans: true,
});

// Close each payer's last ended period — safe to run on every schedule tick.
registerBillingRuntime('platform', billing);
await enqueueBillingPeriodClose({ runtime: 'platform' });

// Webhook route: verify, enqueue, respond 2xx.
const intake = await billing.acceptWebhook(
  rawBody,
  request.headers.get('stripe-signature'),
);
if (intake.type?.endsWith(':unverified_credit_purchase')) {
  // alert: a paid checkout claimed to buy credit but failed verification
}
await billing.processEvents(); // or enqueueBillingEvents({ runtime: 'platform' })

// Prepaid credit through provider checkout.
const { url } = await billing.createCreditCheckout({
  spendingPolicyId,
  amount: 5000,
  purchaseId: cartId,
  successUrl,
  cancelUrl,
});
```

- **What is billed.** A `provider` runtime bills `ClientCharge`s (and their
  `BillingAdjustment`s) to the payer each charge names, plus monthly flat plans
  it owns, to each subscriber's billing owner. A `reseller` runtime bills the
  `RetailCharge`s its children owe it plus its own flat plans. Charges approved
  before the period end are billed once, whatever period that is; flat plans
  are billed in arrears for the payer's closed period (trials and
  provider-managed subscriptions are skipped). One invoice per payer and
  currency carries both kinds of lines.
- **Replay safety.** Close, invoice, and line ids are derived from the payer,
  currency, and period; each charge is claimed by exactly one close; the
  provider invoice uses the close id as its idempotency key; and every step is
  persisted before the next, so a retry resumes where it stopped. A lease stops
  two workers advancing the same close. A close without a period also resumes
  every unfinished close whose period has ended, even one the payer's current
  schedule no longer produces (#3116). A payer whose charges net to a credit
  gets no invoice; the credit is carried to its next invoice.
- **Billing cycles (#3116).** A payer's periods follow its account's
  `billingAnchorAt`. Unset (the default) they are UTC calendar months. Set,
  they run monthly from the anchor at its UTC time of day; a day the month
  lacks is clamped to its last day, always from the anchor itself (an anchor
  on Jan 31 bills Jan 31 → Feb 28 → Mar 31). Before the anchor the schedule is
  calendar months, and the anchor's own month ends at the anchor (a *stub*).
  `closePeriod()` / `enqueueBillingPeriodClose()` with no period close each
  payer's **last ended period on its own schedule**, so payers on different
  anchors are closed by the same daily tick. An explicit
  `{ periodStart, periodEnd }` closes that period for calendar payers (flat
  plans only when it is a calendar month, as before) and for anchored payers
  whose schedule has exactly that period. `billingPeriodFor(payer, at)` returns
  a payer's current period; `billingPeriodContaining()`,
  `lastEndedBillingPeriod()`, and `prorateMinorUnits()` are exported.
- **Proration.** A flat plan is priced `price × billed time / cycle length`,
  in integer minor units rounded half up (exact integer arithmetic; the
  cycle is the period's own month, so February prorates over 28 or 29 days).
  With `prorateFlatPlans` off (default) the billed time is the whole period
  whenever the subscription was active in it and out of trial at its start —
  the pre-#3116 behavior. With it on, the billed time is exactly the time the
  subscription was active and out of trial: a subscription starting, leaving
  trial, or canceled mid-period is billed pro rata. Proration happens before
  the account's flat discount. Split into parts, prorated amounts can differ
  from the full price by a minor unit.
- **First period.** *Anchor at signup* (set `billingAnchorAt` to the
  signup/activation instant): the first period is a full period from signup;
  nothing before it is billed. *Bill from signup to the next anchor* (keep a
  fixed anchor, or calendar months, and set `prorateFlatPlans`): the first
  period is billed pro rata from signup. Items added later are prorated to the
  payer's anchor when `prorateFlatPlans` is on and billed a full period
  otherwise.
- **Mid-period changes.** Billing is in arrears, so a cancellation needs no
  credit: with proration the canceled period is billed up to `canceledAt`,
  without it in full. A plan change is billed at the plan in effect at close
  for the whole window (no plan-change proration yet, #3119), and a cancellation
  back-dated into an already billed period is not credited — issue an
  adjustment.
- **No double billing across schedule changes.** Every flat-plan claim records
  the exact time it bills, and a subscription's claims are numbered, so only
  one worker can write the next claim and two can never claim the same time.
  Moving an account from calendar months to an anchor, moving an anchor, or
  moving a subscription to a payer on another schedule bills only time not yet
  billed, prorated. For example, calendar months through February and then an
  anchor on Mar 20 bills the Mar 1 → Mar 20 stub pro rata, then Mar 20 → Apr
  20. Time around an already billed window is billed as separate lines, each
  with its own service period. Stop workers running a pre-#3116 version
  before relying on this: they claim flat plans outside the numbering.
- **Service periods.** Each flat-plan invoice line carries its billed window
  as `periodStart`/`periodEnd`, down to the provider port. The Stripe adapter
  passes them on; `@happyvertical/accounting` does not send them to Stripe yet
  (happyvertical/sdk#1274).
- **Upgrading to #3116.** Additive schema only: `_smrt_billing_accounts` gains
  `billing_anchor_at` (nullable) and `prorate_flat_plans` (default false), and
  `_smrt_billing_line_sources` gains `chain_sequence` (default 0) and an index
  on `(line_key, chain_sequence)`; run `smrt db:migrate`.
  Existing accounts stay on calendar months, and claims written before the
  upgrade (`<subscriptionId>:<periodStart>`, number 0) count as billed
  coverage, so nothing is billed again after it.
- **Tax** comes from the provider (Stripe Tax) using the account customer's
  `defaultBillingAddress`; the invoice records it as `providerTaxAmount`.
- **Events** are verified, stored in smrt-jobs' durable delivery inbox, and
  applied against current provider state: paid invoices record a payment and
  allocation; failures and overdue notices mark the payer `past_due` and its
  flat-plan subscriptions `past_due`; payment reinstates them. Dunning is the
  provider's.
- **Prepaid credit** purchases credit a `period: 'balance'` spending policy
  once per checkout session, paid by the policy's tenant or, for a delegated
  balance, the parent that set it.

### Payment rails: BTC and other crypto (#3138)

A seller runtime can take payments on more than one **rail**. The issuing
`provider` (Stripe) still issues, taxes, and emails every invoice; extra rails
in `paymentProviders` let a payer choose, per payment, to pay an invoice or buy
prepaid credit another way. The crypto rail runs short-lived, fiat-priced
checkouts through `@happyvertical/payments`' provider-neutral
`CryptoCheckoutGateway` — BTCPay Server at launch — so another gateway can
replace BTCPay without changing this package or its consumers.

```ts
import {
  BillingRuntime,
  createBtcPayBillingProvider,
  createStripeBillingProvider,
} from '@happyvertical/smrt-commerce';

const btcpay = createBtcPayBillingProvider({
  baseUrl, apiKey, storeId,        // one BTCPay store per seller entity
  webhookSecret, metadataSecret,   // from the host's secret store, by name
  speedPolicy: 'LowSpeed',         // BTCPay settles after 0/1/2/6 confirmations
  rateSource: 'kraken',
  minimumAmount: { CAD: 500, USD: 500 },
});
const billing = await BillingRuntime.create({
  db, sellerTenantId, kind: 'provider',
  provider: createStripeBillingProvider({ stripe, webhookSecret }),
  paymentProviders: [btcpay],
  paymentPolicy: { latePaymentPolicy: 'review', refundBasis: 'original_native' },
  billingRelationships,
  ledger: { ...ledger, cryptoHoldingsAccountId, fxGainLossAccountId, feesAccountId },
});

// Prepaid credit or an issued invoice, paid with BTC:
await billing.createCreditCheckout({ ...purchase, provider: 'btcpay' });
await billing.createInvoicePayment({ invoiceId, provider: 'btcpay', purchaseId, successUrl, cancelUrl });

// Webhook route for the rail (BTCPay signs with its own header):
await billing.acceptWebhook(rawBody, '', { provider: 'btcpay', headers: request.headers });
await billing.processEvents();
```

- **Settlement is the gateway's.** Credit is granted and invoices are paid
  only when the gateway reports `settled` under its own confirmation policy;
  this package never counts confirmations. BTCPay offers 0, 1, 2 or 6
  confirmations (`LowSpeed` = 6 is the default because BTCPay has no 3).
- **Payment attempts.** Every rail checkout is a `BillingPaymentAttempt`
  recording the locked fiat price, fiat and native amounts received, rate and
  rate source, each payment's txid, rail and fee, a timeline of status changes,
  and what settlement produced. `listPaymentAttempts()` feeds "payment
  confirming" displays and operator queues; `refreshPaymentAttempts()` is the
  polling fallback for missed webhooks.
- **Dunning pauses** for an invoice while a payment for it is confirming
  (0-conf seen); if the payment then expires or is invalidated the payer's
  standing is re-applied.
- **Invoices paid on a rail** are closed at the issuer with
  `markInvoicePaidOutOfBand` (Stripe `paid_out_of_band`), so Stripe stops
  collecting; Stripe's own `paid` event then records nothing more.
  `createInvoicePayment` refuses when the issuing provider cannot do that.
- **Exceptions never auto-refund.** Underpaid, overpaid, late, manually marked
  (at the gateway), invalidated-after-settlement, and paid-twice attempts are
  flagged for an operator (`resolvePaymentAttempt`). Per-seller
  `paymentPolicy` sets under/overpayment tolerances (basis points), late
  payments (`review` | `accept`), manually marked checkouts, hold vs convert
  (`conversionHandler`), and the refund basis.
- **Ledger.** Receipts are booked at the locked fiat amount into
  `cryptoHoldingsAccountId` (default `cashAccountId`); money received above
  the price is booked as customer credit (prepaid-credit liability).
  `recordManualRefund()` refunds from that excess first, then from purchased
  credit (or an invoice payment kept as credit because the invoice was paid
  elsewhere) — capped cumulatively, once per reference; an invoice payment
  applied to its invoice is reversed at the issuer, not here.
  `recordCryptoConversion()` posts a conversion with FX gain/loss.
- **One live payment per invoice**, and the issuer's own `paid` event for an
  invoice closed out of band never records a payment: the rail does.
- **Entities.** Each legal entity is its own seller runtime with its own
  store, keys, and ledger. Inter-entity resale is ordinary reseller billing
  between two sellers, payable on any rail the selling entity offers.

See [`AGENTS.md`](./AGENTS.md#billing-period-close-3060) for invariants and
known limits.

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-tenancy` -- multi-tenant scoping
- `@happyvertical/smrt-subscriptions` -- charges, plans, and credit balances billed by period close
- `@happyvertical/smrt-jobs` -- period-close jobs and the provider event inbox
- `@happyvertical/accounting` -- payment-provider (Stripe) calls
- `@happyvertical/smrt-types` -- shared type definitions
- Peer: `@happyvertical/smrt-ledgers`, `@happyvertical/smrt-profiles`, `@happyvertical/smrt-svelte`

## Contributor guide

See [`AGENTS.md`](./AGENTS.md) for package architecture, invariants, validation,
and contributor guidance.
