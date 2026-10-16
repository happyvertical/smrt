# @happyvertical/smrt-commerce

Commerce models for the s-m-r-t framework. Covers customers, vendors, contracts (10 STI types), invoices with ledger integration, payments, and fulfillment tracking.

## Installation

```bash
pnpm add @happyvertical/smrt-commerce
```

## Usage

```typescript
import { withTenant } from '@happyvertical/smrt-tenancy';
import {
  CustomerCollection,
  ContractCollection,
  InvoiceCollection,
  InvoiceLineItemCollection,
  PaymentCollection,
  PaymentMethod,
  ensureCommerceTenant,
} from '@happyvertical/smrt-commerce';

// Once per tenant, after the host creates it: tax settings and standard codes.
await ensureCommerceTenant(db, tenantId);

// Money documents (invoices, contracts, and their lines) belong to a tenant.
await withTenant({ tenantId }, async () => {
  // Create a customer linked to a profile
  const customers = await CustomerCollection.create({ db });
  const customer = await customers.create({
    profileId: 'profile-uuid',
    creditLimit: 1000000, // $10,000.00 — money is integer minor units
    paymentTerms: 'Net 30',
  });

  // Create an order (STI contract type)
  const contracts = await ContractCollection.create({ db });
  const order = await contracts.create({
    _meta_type: 'Order',
    customerId: customer.id,
    currency: 'CAD',
  });

  // Create an invoice. The server resolves each line's tax code and computes
  // line tax and the header totals; header amounts are never inputs.
  const invoices = await InvoiceCollection.create({ db });
  const invoice = await invoices.create({
    customerId: customer.id,
    contractId: order.id,
    invoiceNumber: await invoices.generateInvoiceNumber(),
    currency: 'CAD',
  });
  const lines = await InvoiceLineItemCollection.create({ db });
  await lines.create({
    invoiceId: invoice.id,
    description: 'Consulting',
    quantity: 10,
    unitPrice: 10000, // $100.00
  });

  // Issuing freezes the money snapshot; then recognize revenue (creates a
  // balanced journal in smrt-ledgers from the frozen facts).
  const issued = await invoices.get({ id: invoice.id }, { cache: false });
  issued.markSent();
  await issued.save();
  await issued.recognizeRevenue({
    arAccountId: 'ar-account-id',
    revenueAccountId: 'revenue-account-id',
    taxAccountId: 'tax-account-id',
    bookCurrency: 'CAD', // must equal the invoice currency
  });

  // Record a payment with ledger integration
  const payments = await PaymentCollection.create({ db });
  const payment = await payments.create({
    contractId: order.id,
    customerId: customer.id,
    amount: issued.totalAmount,
    method: PaymentMethod.CREDIT_CARD,
  });
  await payment.recordPayment({
    ledgerId: 'ledger-id',
    receivablesAccountId: 'ar-account-id',
    cashAccountId: 'bank-account-id',
  });
});
```

## Commercial money calculator

The public `/money` entry is a pure calculator for line amounts, discounts,
component tax, document rounding, and totals. It consumes and returns integer
minor-unit money values; tax and discount percentages are exact text (`'5'`
means 5%). It does not persist or load documents.

```ts
import { calculateMoneyDocument } from '@happyvertical/smrt-commerce/money';

const totals = calculateMoneyDocument({
  currency: 'CAD',
  lineAmountType: 'exclusive',
  roundingScope: 'line',
  lines: [{
    id: 'consulting', quantity: 1, unitPrice: 10000,
    discount: { kind: 'none' },
    taxCode: {
      id: 'gst', kind: 'taxable',
      components: [{ taxComponentId: 'gst', percent: '5', compound: false }],
    },
  }],
});
```

`resolveLineTaxCode()` resolves caller-loaded codes without I/O, and the
Svelte `InvoiceEditor` renders the money controls from its required `money`
prop. Frozen editor documents render a supplied stored snapshot without
recalculation. See the [commerce money calculator guide](../../docs/content/commerce-money.md)
for pricing modes, rounding, input and result types, the native-form editor
contract, and the boundaries this package does not define.

### Tenant tax catalogue and defaults

The package root also exports tenant-scoped `TaxComponent`, `TaxCode`, and
`TaxSettings` models and their collections. Components hold exact percentage
rates and optional liability accounts; codes combine compatible components; the
one settings row per tenant supplies sales/purchase defaults, amount mode,
rounding scope, and labelled registration numbers. A referenced component rate
is immutable: archive it and create a replacement for a rate change.

`ensureTenantTaxCodes(db, tenantId)` idempotently creates the standard
non-taxable codes, `exempt`, `zero-rated`, and `out-of-scope`
(`STANDARD_TAX_CODES`). `applyTaxCodeExamplePack(db, tenantId)` installs illustrative
regional examples for review, and `applyCommerceCookbookSettings(db, tenantId,
cookbook)` explicitly materializes a validated cookbook's defaults after schema
setup and authentication establish the tenant. See the [commerce money
calculator guide](../../docs/content/commerce-money.md#tenant-tax-catalogue) for
the supported kinds, seed behavior, and cookbook rate units.

### Persisted Invoice money

Commerce has one money model. Tax codes resolve each line's tax: the line's
override, else `exempt` for an exempt customer, else the product's code, the
customer's code, then the tenant default. The server computes line
`taxAmount` and the header totals and ignores any client total. Every Invoice
and Contract money write needs a tenant; without one it fails with
`MoneyValidationError` `INVALID_MONEY_INPUT`.
`ensureCommerceTenant(db, tenantId, { cookbook })` is the one bootstrap call a
host makes after creating a tenant. It seeds the tenant's tax settings, the
standard codes, and the cookbook's defaults, and returns `{ tenantId }`.

Issuing an Invoice (leaving `DRAFT`) or assigning `arJournalId` freezes its
money snapshot. Header and line money changes then fail with `FROZEN_DOCUMENT`,
while later lifecycle and payment updates retain the snapshot. Provider tax
stays separate in `providerTaxAmount` and contributes to the Invoice headers
without creating an application tax code.
`InvoiceLineItemCollection.getTotalForInvoice()` sums line amounts for
compatibility; use persisted `Invoice.totalAmount` for the amount due.
`recognizeRevenue()` and `cancelWithRevenueReversal()` require a `bookCurrency`
equal to the invoice currency, and `toAccountingInput({ mapping })` requires
explicit QuickBooks realm mapping. The
[commerce money calculator guide](../../docs/content/commerce-money.md#persisted-invoice-money)
and [document-money contract](agents/document-money.md) cover persisted Invoice
semantics, credits, refunds, and posting. The materialized Invoice tax-report
descriptor and tenant-safe drilldown are documented in
[tax-summary contract](agents/tax-summary.md). Contract money persistence,
PurchaseContract tax contributors, and the materialized tax-summary host and
drilldown are available. Applications opt in by registering
`createTaxSummaryMaterializedReportHost()` in their server-only report-host
registry; the route binds the authenticated tenant and read permission. See the
tax-summary contract for registration details.

### Upgrading money data from an earlier version

Commerce refuses money data written by an earlier version with
`COMMERCE_DATA_NEEDS_UPGRADE` instead of reading it. That is a schema that
still has the earlier money columns or the `commerce_money_migration_documents` table,
an invoice or contract without a tenant, or a tenant with invoices or contracts but no tax settings row or with
documents in the earlier format. `smrt db:status`
reports it, so `smrt app doctor` reports `migration-required`. Run the normal
schema migration, then upgrade once:

```sh
smrt db:upgrade-commerce-money --check   # report only
smrt db:upgrade-commerce-money           # every tenant
```

Each tenant converts in its own transaction. Stored rates become tax codes,
issued documents keep every stored total, and drafts are recomputed. The
earlier columns are dropped once no tenant needs the upgrade. See
[money data upgrade](agents/money-upgrade.md) and the
[CLI guide](../cli/agents/commerce-money-upgrade.md).

## API

### Models

#### Supplier quotations

`SupplierQuote` extends `PurchaseContract`, requires `vendorId`, and has
`ContractType.SUPPLIER_QUOTE`. Create it through `PurchaseContractCollection`
(or `ContractCollection`) with `_meta_type:
'@happyvertical/smrt-commerce:SupplierQuote'`. It inherits `expiryDate`,
`reference`, `notes`, and `terms`; it has no customer relationship. Purchase
branch reads include quotes and sales branch reads exclude them.

Keep received quote revisions and shared quote identity in your application.
Awarding a quote creates a separate `PurchaseOrder`; accepting or saving a
quote never converts its identity into an order. Quotes use purchase-side
money calculation and frozen snapshots, but never contribute incurred purchase
tax to reports, regardless of status. Existing Estimate and PurchaseOrder
report eligibility is unchanged.

#### Upgrading contract parties (#3898)

`Contract` no longer declares `customerId` or `vendorId`. Narrow a contract to
`SalesContract` to read `customerId`, or to `PurchaseContract` to read `vendorId`.
The existing leaf qualified names and the `contracts` table stay the same; a
`db:migrate --dry-run` against a v0.55.19 schema reports no DDL changes on
SQLite or PostgreSQL. Sales leaves no longer accept `vendorId`; purchase leaves
no longer accept `customerId`. `Order`, `Estimate`, `Agreement`, `Lease`, and
`WholesaleOrder` require a customer on save. `PurchaseOrder` and `SupplierQuote`
require a vendor.
`Cart`, `LicenseSale`, and `ProductionOrder` retain optional parties on their side.

Before upgrading existing data, run the read-only
`preflightCommercePartyLinks(db)` and inspect its stray party links, missing
required parties, base-typed rows, discriminator mismatches, and invalid
document references. Its `unqualifiedDiscriminatorRows` lists legacy simple
`_meta_type` values such as `Order` and `PurchaseOrder`; retype them to the
qualified class name before upgrading, since branch collections cannot read
them. The report checks invoice, payment, fulfillment, ad group,
and expense links when those tables exist. A linked base-typed or wrong-branch
contract blocks the next save of its document even when the link is unchanged.
Registered custom descendants of either contract branch are accepted in link
checks; load those model classes before running the preflight.
Tenant-owned documents linked to global or other-tenant contracts are also
reported because the save-time lookup is tenant-scoped. Retype the contract to
the correct leaf, assign it to the document's tenant, or repair the link before
deployment. The deprecated `ContractCollection` party finders now return the
appropriate branch
only, so retype legacy base rows with party links before relying on those
finders. Clear stray party columns and fill required parties before deploying
writers that save affected rows. Missing required parties remain readable but
fail their next save. Regenerate cached manifests, planner catalogs, and
generated screens after upgrading.
This preflight never edits rows; an operator chooses the data correction.

| Export | Description |
|--------|------------|
| `Customer` | Customer record with creditLimit, paymentTerms, tax exemption, addresses, contacts |
| `Vendor` | Vendor/supplier with leadTimeDays, minimumOrderAmount, currency, contacts |
| `Contract` | STI base class for all commercial agreements |
| `SalesContract` | Abstract customer-side Contract branch; owns `customerId` |
| `PurchaseContract` | Abstract supplier-side Contract branch; owns `vendorId` |
| `Estimate` | Quote or proposal sent to a customer |
| `Order` | Customer purchase order |
| `Lease` | Rental or lease agreement |
| `Agreement` | Service or maintenance agreement |
| `SupplierQuote` | Quotation received from a vendor; distinct from an awarded purchase order |
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

`CustomerCollection`, `VendorCollection`, `ContractCollection`, `SalesContractCollection`, `PurchaseContractCollection`, `InvoiceCollection`, `InvoiceLineItemCollection`, `PaymentCollection`, `PaymentAllocationCollection`, `FulfillmentCollection`

`PaymentAllocationCollection.allocatePayment()` splits a payment across invoices
in one transaction using stable allocation IDs for retries. Direct allocation
saves also enforce matching owners, customers and currencies and both balance
caps. Read [payment allocation integrity](agents/payment-allocations.md) for
replay, parent revision refresh and compatibility requirements.


### Enums

| Export | Values |
|--------|--------|
| `ContractType` | `estimate`, `order`, `lease`, `agreement`, `supplier_quote`, `purchase_order`, `wholesale_order`, `production_order`, `cart`, `license_sale` |
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

`Payment.recordPayment()` claims the payment revision and commits the journal,
entries, and completed payment in one database transaction. A failed completion
rolls back the posting and restores the instance's settlement fields for retry.
The claimed persisted status is authoritative even if a caller locally resets
status or marks the instance failed without saving. Concurrent or stale instances
fail instead of posting twice; reload the payment
and retry only if it is still pending. An already completed payment retains the
`Payment already recorded` error. A caller's enclosing transaction remains the
owner: if it rolls back after settlement returns, reload the payment before retry.
These guarantees cover new postings, not orphaned journals written by older
versions. The returned journal uses the caller's database executor.
Both payment and refund journal lines retain the payment's explicit currency and
exact amount; posting does not convert currencies or fall back to USD. When
reporting accounts that contain different currencies, use the public
`listPostedMovements` currency filter rather than combining their amounts.

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
import { SpendingPolicyEvaluator } from '@happyvertical/smrt-subscriptions';
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
    bookCurrency: 'USD', // ISO 4217; must equal the billing currency
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

// Prepaid credit through provider checkout: tax is added on top when the
// payer's account is taxed; `savePaymentMethod` keeps the card for top-ups.
const { url } = await billing.createCreditCheckout({
  spendingPolicyId,
  amount: 5000,
  purchaseId: cartId,
  savePaymentMethod: true,
  successUrl,
  cancelUrl,
});

// Card on file at signup: a setup checkout that charges nothing. Its
// completion event makes the card the payer's default and adopts the billing
// address collected at checkout as the tax location.
const setup = await billing.createCardSetupCheckout({
  payerTenantId,
  currency: 'CAD',
  setupId: signupId,
  successUrl,
  cancelUrl,
});

// Automatic top-ups: charge the saved card when a balance would run out.
// Accounts are taxed by default (`automaticTax`); a taxed account is charged
// the credit plus provider-calculated tax (#3194).
const evaluator = await SpendingPolicyEvaluator.create({
  db,
  autoTopUp: billing.autoTopUpHook({ amount: () => 2500 }),
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
  as `periodStart`/`periodEnd`, down to the provider port and on to Stripe's
  invoice item `period`.
- **Upgrading to #3116.** Additive schema only: `_smrt_billing_accounts` gains
  `billing_anchor_at` (nullable) and `prorate_flat_plans` (default false), and
  `_smrt_billing_line_sources` gains `chain_sequence` (default 0) and an index
  on `(line_key, chain_sequence)`; run `smrt db:migrate`.
  Existing accounts stay on calendar months, and claims written before the
  upgrade (`<subscriptionId>:<periodStart>`, number 0) count as billed
  coverage, so nothing is billed again after it.
- **Tax** comes from the provider (Stripe Tax) using the account customer's
  `defaultBillingAddress`; the invoice records it as `providerTaxAmount` in the
  save that issues it. Billing invoices are ordinary money-model invoices in
  the seller's tenant; period close seeds its standard codes if needed. Every
  billing line is an explicit override to the seller's `out-of-scope` code, so
  the seller's default code never taxes it a second time. Charges are written
  before credits, so the running subtotal never goes negative. Revenue posting
  uses `ledger.bookCurrency` and is idempotent.
- **Events** are verified, stored in smrt-jobs' durable delivery inbox, and
  applied against current provider state: paid invoices record a payment and
  allocation; failures and overdue notices mark the payer `past_due` and its
  flat-plan subscriptions `past_due`; an invoice written off at the provider
  (`markInvoiceUncollectible(invoiceId)`, or in Stripe) is written off
  locally and marks the payer `uncollectible` (no bad-debt journal is
  posted; AR stays until it is paid or an operator journals it); payment
  reinstates them, including a late payment of the written-off invoice. Dunning is the provider's.
  Subscribe the webhook endpoint to `invoice.*`, `customer.subscription.*`,
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  and `payment_intent.*`.
- **Prepaid credit** purchases credit a `period: 'balance'` spending policy
  once per checkout session, paid by the policy's tenant or, for a delegated
  balance, the parent that set it. Amounts are ISO 4217 minor units in any
  currency the provider supports. When the payer's account is taxed
  (`automaticTax`, not tax-exempt; override per call), provider tax is
  charged on top and collected at checkout with the buyer's address: the
  credit is the amount bought, the payment is the total collected, and the
  tax is booked to the tax account. For a payer with a provider customer but
  no local tax location, the address collected at checkout becomes its tax
  location. `savePaymentMethod` requires a provider that can re-read the
  checkout and set a default payment method, and is refused otherwise.
- **Card on file (#3139).** `createCardSetupCheckout()` (or a credit purchase
  with `savePaymentMethod`) saves the payer's card without charging it. On
  completion the card becomes the provider customer's default and the
  payer's default `PaymentInstrument`. When the checkout collected the billing
  address (a taxed payer with no tax location), it becomes the payer's tax
  location. `cardOnFile(payerTenantId)` returns `{ onFile, savedAt? }` from
  the same check automatic charges use (a default card with the account's
  provider customer), for "card on file" displays and signup activation;
  the payer or a system context may call it (#3187).
- **Automatically charged invoices.** With `autoChargeInvoices: true` on the
  runtime, a payer with a default card is invoiced `charge_automatically`:
  the provider charges the card after the invoice is sent, on its own
  schedule, and retries failures. Each pushed invoice records the method in
  `Invoice.collectionMethod` (`charge_automatically` or `send_invoice`; empty
  for invoices pushed before #3190). Do not offer another payment rail on a
  `charge_automatically` invoice the provider is still collecting.
  Upgrading adds the `collection_method` column to `invoices` (run
  `smrt db:migrate`). Activate service on the `current` standing
  from the `paid` event, not on send; a failure marks the payer `past_due`.
- **Automatic top-ups.** Taxed accounts (the default: `automaticTax` on, not
  tax-exempt) are charged the credit plus provider-calculated tax (#3194):
  the balance is credited the credit, the payment records the credit, and
  the tax is booked to the tax account. `taxedAccounts: 'skip'` does not top
  them up, and `'charge_untaxed'` charges them without tax. A taxed payer
  without a tax location is not charged. A location Stripe rejects fails the
  attempt with `failureCode: 'customer_tax_location_invalid'`
  (`onAutoTopUpFailed`), and it is retried only after `retryAfterMs`. Pass
  `onAutoTopUpSkipped` to learn when a needed top-up will not be charged
  because of the payer's account. Its `reason` is `taxed_account`, `no_card`,
  `no_account`, or `tax_location_invalid`, and more may be added. Use it, for
  example, to ask the payer to top up by hand or to add a billing address; it is not called while a charge is processing, while a
  declined card waits out `retryAfterMs`, or when the top-up is no longer
  needed or `amount` declines it (#3189).
  `billing.autoTopUpHook()` is the `autoTopUp` hook for
  `SpendingPolicyEvaluator`: when a balance would run out it charges the
  payer's saved card off-session (the delegating parent's, for a delegated
  balance) and credits the balance only when the charge succeeds. A charge
  still processing is credited from its `payment_intent.succeeded` event; a
  decline or an authentication requirement credits nothing, closes the
  attempt, and calls the runtime's `onAutoTopUpFailed` (ask the payer to
  re-save their card with a setup checkout). One attempt runs per policy at a
  time, retries of a declined card wait `retryAfterMs` (default one hour),
  and the credit is granted exactly once however the outcome arrives.
- **Product tax codes (#3194).** `taxCodes: { credit, invoice }` on the
  runtime classifies prepaid credit (checkout purchases and taxed top-ups)
  and billing-period invoice lines for Stripe Tax (`txcd_...`). Without it,
  the Stripe account's default product tax code applies.
- **Upgrading to #3194.** Requires `@happyvertical/accounting` 0.96 or later.
  No schema change. Taxed accounts are now topped up with tax. To keep the
  previous behaviour, pass `taxedAccounts: 'skip'`.
- **Upgrading to #3139.** Requires `@happyvertical/accounting` 0.92 or later.
  No schema change. Credit checkouts are now taxed for taxed accounts (pass
  `automaticTax: false` to keep them untaxed), and Stripe customers are
  created idempotently.

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
  speedPolicy: 'LowMediumSpeed',   // settle after 2 confirmations (BTCPay offers 0/1/2/6)
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

- **Refusals are typed (#3185).** `createInvoicePayment()` and
  `createCreditCheckout()` throw `BillingPaymentRefusedError` for requests the
  payer can correct, with a stable `code`: `not_found`, `not_payable`,
  `payment_in_progress`, `nothing_due`, `invalid_amount`, `below_minimum`
  (under the rail's `minimumAmount`), or `no_account`. Show its message as a
  4xx; any other error is a server failure, and `TenantIsolationError` still
  means the caller is not the payer. Treat an unknown code like
  `not_payable`.
- **Settlement is the gateway's.** Credit is granted and invoices are paid
  only when the gateway reports `settled` under its own confirmation policy;
  this package never counts confirmations. BTCPay offers 0, 1, 2 or 6
  confirmations; the default is `LowMediumSpeed` (2 confirmations).
- **Payment attempts.** Every rail checkout is a `BillingPaymentAttempt`
  recording the locked fiat price, fiat and native amounts received, rate and
  rate source, each payment's txid, rail and fee, a timeline of status changes,
  and what settlement produced. `listPaymentAttempts()` feeds "payment
  confirming" displays and operator queues; every filter applies before its
  `limit` and `offset`, so paging through `{ unresolved: true }` lists every
  open exception (flagged, not yet resolved) however old. `refreshPaymentAttempts()` is the polling
  fallback for missed webhooks.
- **Dunning pauses** for an invoice while a payment for it is confirming
  (0-conf seen); if the payment then expires or is invalidated the payer's
  standing is re-applied.
- **Invoices paid on a rail** are closed at the issuer with
  `markInvoicePaidOutOfBand` (Stripe `paid_out_of_band`), so Stripe stops
  collecting; Stripe's own `paid` event then records nothing more.
  `createInvoicePayment` refuses when the issuing provider cannot do that.
  A written-off (uncollectible) invoice with an amount due can be paid on a
  rail too, as it can by card at Stripe (#3188): the payment is recorded,
  Stripe's invoice is closed out of band, and the payer returns to `current`;
  the invoice keeps its `WRITTEN_OFF` status (its `amountPaid` shows the
  recovery).
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
- **Upgrading.** Additive schema: `_smrt_billing_payment_attempts` (run
  `smrt db:migrate`). A runtime without `paymentProviders` never reads it.
- **One live payment per invoice.** The issuer's own `paid` event for an
  invoice a rail closed out of band records nothing (the rail records it); an
  out-of-band close made by someone else (wire, cheque) is recorded as an
  `OTHER`-method payment; a real card payment made while a rail payment
  confirms is recorded and the rail money is flagged `invoice_already_paid`.
  An issuer close whose rail payment never settles is flagged
  `out_of_band_without_settlement`: reopen the invoice at the issuer, then
  `resolvePaymentAttempt()` it, after which a later out-of-band close is
  recorded normally.
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

## Pricing version UI

`PricingVersionSummary` and `PricingVersionDecision` compose the quote revision
contract without adding a pricing ledger. Compare versions using
`QuoteRevisionComparison`; the application owns every decision and native form
action. See [pricing version presentation](agents/pricing-versions.md).

## Commercial UI composition

Customer addresses and vendor/quote currencies use the shared localized code
selectors while preserving native field names and rejected raw drafts. See
[commercial UI contracts and backend boundaries](agents/commercial-ui.md) for
native forms, recovery, amount units and consumer adoption, plus the focused
[customer/vendor](agents/customer-vendor-ui.md) and
[quotation](agents/quote-ui.md) contracts for selector restrictions.

## Customer and vendor contacts

`Customer.contacts` and `Vendor.contacts` hold the people to reach at a party
(`PartyContact`: `id`, `name`, `label`, `email`, `phone`, `address`) as a JSON
column; existing databases need `smrt db:migrate` for the new `contacts`
columns. The form's contact rows are written with `savePartyContacts()`:

```typescript
import {
  applyPartyContactIntent,
  PartyContactValidationError,
  readPartyContactRows,
  savePartyContacts,
} from '@happyvertical/smrt-commerce';

const form = await request.formData();
// Throws PartyContactPayloadError when the form's contactCount marker is absent
// (block not rendered, or fieldNames differ), so a save never deletes by accident.
const rows = readPartyContactRows(form); // pass the form's fieldNames if overridden
const { contacts, handled } = applyPartyContactIntent(rows, String(form.get('intent')));
if (handled) return { values: { ...values, contacts } }; // add/remove round trip, no save
try {
  await savePartyContacts(vendors, vendorId, rows, { expectedTenantId });
} catch (error) {
  if (error instanceof PartyContactValidationError)
    return fail(400, { values: { ...values, contacts: rows }, errors: { contacts: toMessages(error.errors) } });
  throw error;
}
```

`savePartyContacts` also accepts the `FormData` itself (with `fieldNames`) and
reads it the same way. The rows replace the party's contacts: posted ids are kept, new rows get an
id, unposted rows are removed, blank rows are dropped. See
[customer/vendor UI](agents/customer-vendor-ui.md#contact-rows-3501).

## Customer and vendor selectors

`CustomerSelect` and `VendorSelect` from `@happyvertical/smrt-commerce/svelte`
are searchable, field-sized pickers for a customer or vendor relation field.
They are registered in `COMMERCE_UI_SLOTS` with `selects:
'@happyvertical/smrt-commerce:Customer'` / `':Vendor'`, so generic forms (via
`findSelectorFor` over the manifest's `uiSelectors`) use them for any
`@foreignKey` or `@crossPackageRef` field targeting those models.

They are presentation only. The caller owns the data: `search(query)` returns
the existing party DTOs (`CustomerDisplayData` / `VendorDisplayData`, whose
`profile.name` is the label), and `resolve(id)` returns the record behind the
current value. Each row shows the profile name with status (and customer type).
The committed id, never the name, posts under `name`. Pass `onCreate` to offer a
"New customer" / "New vendor" action; it receives the searched text, and a
returned record is selected.

```svelte
<CustomerSelect
  name="customerId"
  bind:value={customerId}
  search={(query) => customers.search(query)}
  resolve={(id) => customers.byId(id)}
  onCreate={(query) => openCustomerDialog(query)}
/>
```

The same models carry `@field({ ui: { widget } })` hints in the manifest:
`textarea` on `Contract` (and subclass) `terms` and `notes`, `Customer`/`Vendor`
`notes`, and `Invoice` notes and terms; `currency` (an ISO 4217 code picker) on
`Contract`, `Vendor`, `Invoice` and `Payment` `currency`; `email`/`phone` on
`Vendor.defaultContactEmail`/`defaultContactPhone`. See
[customer and vendor selectors](agents/customer-vendor-ui.md#selectors-3602).

## Invoice preparation UI

`InvoiceEditor` from `@happyvertical/smrt-commerce/svelte` is the invoice form,
built on the commercial money model, v2, which is the only invoice money model.
It requires a `money` prop (`MoneyEditorProps`): a lossless draft with
descriptions, fractional quantities, unit prices, percentage or amount
discounts and a tax code per line (inherited or overridden), plus the
authorized tax codes. Its previews run the same exact calculator the server
uses, and the server re-resolves tax codes and recomputes every stored amount.
An issued document renders only its frozen stored snapshot.
`InvoiceAllocationFields` and `InvoiceReview` add caller-owned sources and
approvals. See [the editor contract](agents/invoice-preparation.md), the
[line calculation helper](agents/invoice-calculations.md), and the
[existing-database storage migration](agents/invoice-quantity.md).

## Exact cost billing

The independent `@happyvertical/smrt-commerce/cost-billing` entry point provides
exact signed reimbursement/fee calculations, ordered generic markup provenance,
and explicit line or invoice tax rounding. Its opt-in ordered tax calculator
supports subset compounding with caller-selected signed invoice allocation.
See [the cost billing contract](agents/cost-billing.md).
It does not alter Invoice persistence, editor defaults or settlement behavior.

### Purchase-order header editing

Import `PurchaseOrderHeaderForm` from `@happyvertical/smrt-commerce/svelte` for a
native POST of vendor, reference, notes, expected date and ship-to fields. Pass
`action`, `vendors` and raw `values`; return canonical field `errors` and the same
`hiddenFields` after server validation. This header-only form leaves purchase
allocations and totals unchanged. `PurchaseOrder` stores `expectedDate` and
`shipTo` in existing STI metadata. See [the purchasing contract](agents/purchasing-ui.md#purchase-order-header)
for validation, retained values and transport details.

### Invoice retention and release

`configureInvoiceRetention` freezes an explicit retained minor-unit amount on an
unpaid draft. Supply tenant, invoice, currency, expected invoice revision,
request identity, actor, reason, evidence reference, and versioned host policy.
The supported `creditPolicy: 'retained-first'` is an explicit caller choice:
issued credits reduce unreleased retention first, then current payable. Hosts
must choose and authorize their regional policy; Commerce supplies no legal
percentage or release date default. Configuration cannot be overwritten; replace
an unissued draft to change the original agreement.

`releaseInvoiceRetention` appends evidence under the invoice's transaction lock.
It cannot release more than the currently retained remainder. Exact request
replays are safe; changed payloads or stale revisions fail. Both commands retain
caller transaction affinity. Original gross, tax, line snapshots and approved
configuration stay unchanged. Credits and credit cancellation derive remaining
retention without rewriting release history.

`invoice.getPayableFacts()` separates `grossBalanceMinor`,
`retainedRemainingMinor`, `currentlyDueMinor`, and `allocationCapMinor`. The
allocation API enforces the current cap. `getAmountDue()` returns current due;
`getBalance()` remains the signed gross balance. An invoice with paid current
due and unreleased retention is not fully paid or overdue. Display gross and
current payable separately; pass explicit current due and remaining holdback to
the exact retained invoice UI props rather than treating gross as payable.
Stored money facts include `payable` for retained invoices; MCP projection honors
field visibility for every source of the payable alias.

Provider-controlled imports/automatic collection cannot acquire retention.
Accounting export refuses unreleased retention until the provider has an
explicit payable representation; it never silently requests collection of
gross. Fully released invoices use the existing gross accounting contract.
