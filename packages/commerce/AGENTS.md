# @happyvertical/smrt-commerce

E-commerce with Contract STI hierarchy, invoice lifecycle, payment tracking, payout remittance, and optional ledger integration.

## Models

- **Customer** / **Vendor**: linked to Profile via string ID (not FK). `contacts` (JSON) is written via [`savePartyContacts()`](agents/customer-vendor-ui.md#contact-rows-3501). Customer has creditLimit, paymentTerms, customerType (DTC / WHOLESALE / RETAIL). Vendor has leadTimeDays, minimumOrder, and `payoutAddresses: Record<string, string>` — a flat map from payout-rail-qualified currency code (`USDC-base`, `BTC`, `USD-stripe`, ...) to destination string (EVM address, BTC address, Stripe Connect account id, IBAN). Use `getPayoutAddress(currency)` for a `Map.get`-style lookup; missing entries return `undefined` (caller decides skip-vs-error).
- **Contract**: concrete STI base. Abstract **SalesContract** owns `customerId`; **PurchaseContract** owns `vendorId`. `channelId` is open-ended. Before upgrade, run `preflightCommercePartyLinks(db)` and repair linked base rows, stray parties, and wrong-branch links. See [README](README.md).
- **WholesaleOrder**: B2B order. Conventional pairing — customer has `customerType: 'wholesale'`, NET-30/60 terms, delivered via wholesale-portal channel.
- **ProductionOrder**: manufacturing equivalent of a PurchaseOrder — commission your factory to make finished goods. Consumes raw materials per BOM (`@happyvertical/smrt-manufacturing`) and produces SKU stock (`@happyvertical/smrt-inventory`).
- **Cart**: transient order-in-progress. Same shape as Order; the application promotes the row from `_meta_type: Cart` to `_meta_type: Order` at checkout instead of copying data between tables.
- **LicenseSale**: industry-neutral licensing primitive. Carries an *immutable* rights snapshot (`rightsMedium`, `rightsDistributionScope`, `rightsExclusivity`, `rightsDuration`, `rightsTerritory`, `rightsSublicensing`, `rightsDerivatives` — typed `Meta<T>` fields), licensee identity (`licenseeEmail`, optional `licenseeLegalEntity` / `licenseeJurisdiction`), and a signed-PDF reference (`pdfUrl`, `pdfHash`, optional `onChainHashRegistryRef`). Once saved at `ContractStatus.ACCEPTED`, the rights snapshot is frozen — mutating any of the seven rights fields and re-saving throws. The only legal transition out of ACCEPTED is `revoke()` (moves to CANCELLED without touching rights). Useful for stock media, music licensing, code-asset marketplaces, license keys, anywhere rights are sold for a fee.
- **ContractLineItem**: items on contracts.
- **Invoice**: status machine `DRAFT → SENT → VIEWED → PARTIAL → PAID` (also OVERDUE, CANCELLED, WRITTEN_OFF). `recognizeRevenue()` creates balanced AR journal entry (DR: Accounts Receivable, CR: Revenue, CR: Tax Payable).
- **InvoiceLineItem**: fractional-quantity line items with safe minor-unit validation/recalculation on save; the existing-column migration is documented in [invoice quantity persistence](agents/invoice-quantity.md).
- **Payment** / **PaymentAllocation**: tracks payments against invoices (status: see Gotchas). Carries optional backend-adapter fields for PaymentBackend-routed flows: `backendId` (rail adapter id — `base-usdc`, `btc`, `stripe`, distinct from `externalProvider` which names an accounting sync destination), `backendTxRef` (chain tx hash or gateway settlement id), `nativeAmount` / `nativeCurrency` (what actually arrived), `usdAtQuote` / `usdAtConfirmation` (drift accounting for volatile-currency rails). `Payment.usdDrift()` returns the confirmation - quote delta, or `0` when either side is unset.
- **PaymentInstrument**: reusable saved payment method ("card on file"). Stores only provider references and non-sensitive display metadata (`providerCustomerId`, `providerPaymentMethodId`, brand / last4 / expiry), never raw card data. `isDefault` is domain-managed, not API-writable: `PaymentInstrumentCollection.setDefaultForCustomer(customerId, instrumentId)` validates the target and clears the customer's other defaults (one per customer).
- **PaymentIntent**: short-lived pre-payment commitment with multi-option semantics. Locks a USD price for a fixed window (default 15 minutes) and lists one or more `PaymentOption`s describing different rails (`backendId`, `currency`, `payTo`, `nativeAmount`, optional `chain` / `memo` / `x402Capable` / `expiresAt`). First option to receive payment wins; the others are implicitly retired. State machine `awaiting_payment → paid → (issued | retired)` plus `expired` and `cancelled`. Mutate via dedicated `markPaid` / `markIssued` / `expire` / `cancel` / `retire` helpers — direct status assignment bypasses the invariant checks. Idempotency: see the natural-key Gotcha.
- **Payout**: operator-to-supplier remittance. Distinct from Payment because direction, status machine, and chain semantics differ. Status machine `pending → sent → confirmed → failed` (failed is terminal but resettable via `resetFromFailed()` after fixing the underlying problem). References source `paymentId` (plain string) and destination `vendorId` (foreign key). Amount invariant `supplierNet === grossAmount - operatorFee` enforced exactly on save (integer minor units, no tolerance — #2401). `PayoutCollection.createFromPayment()` is the typical entry point; it pulls native amount / currency from the source Payment.
- **Fulfillment** / **FulfillmentLineItem**: shipment/delivery tracking.

## Recipes (#3590)

`src/recipes.ts` declares four minimal `SmrtRecipe`s, emitted into the built
`manifest.json` and `smrt-knowledge.json` `recipes`: `commerce.customers`
(Customer), `commerce.vendors` (Vendor), `commerce.sales` (Order, requires
customers), `commerce.purchases` (PurchaseOrder, requires vendors). Headers
only; line items, fulfilment, invoices, and payments are later recipes. Each
has user-facing help in `src/<name>.recipe.md` (#3591), and the fields those
recipes show carry `@field({ description })` text; keep both in plain
language for end users and update them when a recipe's fields change. See
[core recipes](../core/agents/recipes.md).

See [payment allocation integrity](agents/payment-allocations.md) for atomic splits,
retry identity, parent corrections and supported dialects.
See [tax codes](agents/tax-codes.md) for tenant-owned rate components, default codes,
and legacy-rate migration.
See [document money persistence](agents/document-money.md) for the per-tenant
legacy/v2 gate, atomic aggregate writes, issued snapshots, and frozen fields.
A tenant's first `TaxSettings` row starts on `v2` unless Invoice/Contract rows
already exist (#4009); never decide the model anywhere else. Host bootstrap is
`ensureCommerceTenant(db, tenantId, { cookbook })`; billing seller tenants use
`{ moneyModel: 'legacy' }` until #4013. See [initial model](agents/document-money.md#initial-model-4009).
See [Contract money persistence](agents/contract-money.md) for the Contract
aggregate, purchase recoverability, and migration-only materialization boundary.

## Ledger Integration

`@happyvertical/smrt-ledgers` is a regular dependency, loaded lazily via dynamic `import()` (never a static import) so the package graph stays a DAG (#1582). Invoice stores `arJournalId` and `revenueJournalId` as string references. `recognizeRevenue()` creates a balanced AR journal entry; `getArJournal()` returns null when no journal has been recognized yet.

## Billing-period close (#3060)

`src/billing/` closes periods from smrt-subscriptions charges; see the README
for usage.

- **Port, not provider.** Period close, events, and credit checkout call only
  the `BillingProvider` port (integer minor units). `stripe.ts` adapts
  `@happyvertical/accounting`, which takes currency *major* units; convert with
  `units.ts` and never hand-roll a Stripe call here. `units.ts` exponents are
  an explicit ISO 4217 table matching the SDK's, never `Intl` display digits
  (CLDR differs for IQD, MGA, … and drifts by ICU release). The SDK's
  `*Minor` fields are already ISO minor units. Capabilities a rail may lack
  (`chargeSavedPaymentMethod`, `createSetupCheckout`, `getCheckout`,
  `setDefaultPaymentMethod`, `markInvoiceUncollectible`) are optional port
  methods: detect them by presence, and keep additions optional (#3139).
  `sendAndReconcile` refuses a provider invoice whose subtotal or total
  disagrees with the local invoice.
- **Replay safety is identity.** Close, invoice, line, payment, allocation,
  and claim ids are `deterministicId()`s; `BillingLineSource` (conflict key
  `source_type, source_id`) is the only double-billing guard, so never bill a
  source without claiming it, and never widen that key. Each close step is
  persisted before the next; `acquireCloseLease()` serializes workers. A
  close that nets to a credit keeps its claims and ends `carried_forward`;
  its subtotal is a `credit_carry_forward` source for the payer's next billed
  close, which marks the carried close `completed`.
- **Cycles and flat-plan coverage (#3116).** `cycles.ts` is the schedule
  (pure; `BillingAccount.billingAnchorAt`, null = calendar months). A close
  with no period closes each payer's `lastEndedBillingPeriod()`. Flat-plan
  claims are the exception to "id from the source": their `sourceId` is
  `<subscriptionId>:seq:<chainSequence>` and their `periodStart/End` is the
  exact time they bill. `claimFlatWindow()` reads the last number, then the
  coverage (claims ending after the window start), claims one gap as number
  n + 1, and retries on conflict; reading in that order is what makes it
  safe. That numbering, not the period, stops overlaps when schedules or
  payers change — never claim a flat plan outside it, and keep both reads
  bounded (no whole-history scans). Each numbered claim is its own invoice
  line keyed `lineKey|periodStart` (a function of the claim alone, so a
  resumed close rebuilds the same line ids). Proration is
  `prorateMinorUnits()` (half up, BigInt) against the period's full cycle.
- **System tables.** `BillingAccount`, `BillingPeriodClose`, and
  `BillingLineSource` are not tenant-scoped and have no generated surface.
  Collections stay unexported; models are root exports (#3082). Invoices,
  payments, and journals are written in the seller's tenant; payer-owned
  subscriptions and credit grants in a system context, only after
  verification.
- **Events** use smrt-jobs' delivery inbox under provider
  `<name>-billing:<sellerTenantId>` and a provider-filtered
  `ForgeProjectionRuntime`, so a runtime never claims another seller's
  events; any other runtime sharing the inbox must pass `providers` too. Only
  events this package acts on are stored: foreign checkouts are `ignored`,
  and only `smrt_*` checkout metadata is kept; it is
  HMAC-signed with the webhook secret at creation (empty values are omitted:
  Stripe drops them), so another integration on the same account cannot forge
  a credit purchase or a card setup; credit is granted only when the
  collected total equals it plus provider tax. Checkout amounts come from the
  re-read session (`getCheckout()`), never the Stripe event, whose amounts are
  in Stripe's unit. Rotating the webhook secret strands in-flight checkouts
  (up to 24 h). `observe()` re-reads provider state, so ordering never depends
  on delivery order; the only provider writes in `observe()` are idempotent
  (making a saved card the default). The standing hook runs inside the event
  transaction and must be idempotent.
- **Card on file and top-ups (#3139).** A saved card is the payer customer's
  default `PaymentInstrument` (seller tenant, id from the provider method).
  `autoChargeInvoices` bills such payers `charge_automatically`, decided once
  and saved as `Invoice.collectionMethod` before the first push, which every
  retry reuses (never recompute it: a lost push response would record a
  method the provider was not asked for, #3190); activation follows `paid`, never send. An auto top-up attempt
  is a `PENDING` `Payment` (`reference` `auto-top-up:<policyId>`, id from the
  policy and `count()` of its attempts) inserted before the charge, so racing
  evaluations derive one id and one charge; the charge key is derived from
  that id. `applyAutoTopUpOutcome()` must run in a transaction and starts with
  a conditional `UPDATE … WHERE status = 'pending'` row lock, so the hook and
  the `payment` webhook settle once; the grant is keyed by the charge key.
  Never settle an attempt outside that function. Taxed accounts are charged
  with provider tax by default (#3194): the attempt row holds the credit
  (the charge subtotal), the tax is journaled to tax payable at settlement,
  and the attempt's tax decision is recorded in its `notes` so a re-drive
  repeats the same charge request (the provider refuses a key reused with
  different tax). `claimAttempt()` is the only place that decides a
  skip and reports it (`onAutoTopUpSkipped`); `cardOnFile()` and period close
  use `defaultCardInstrument()` — never copy that predicate. A provider write-off moves the local invoice to
  `WRITTEN_OFF` (a later payment, by card or on a rail (#3188), is recorded
  and reinstates the payer; the status stays, so "paid in full" for a
  written-off invoice is read from its allocations).
- **`Invoice.providerTaxAmount`** is added to line-item tax; it is
  server-managed (not API-writable). `toAccountingInput()` emits major units.
- **Payment rails (#3138).** A runtime has one issuing `provider` and any
  number of `paymentProviders` (unique names, one inbox namespace each; a
  provider with `capabilities.issuesInvoices === false` can never issue).
  `observe()` resolves the provider from the delivery namespace, never the
  payload. Crypto rails implement the port over `@happyvertical/payments`'
  `CryptoCheckoutGateway`; never call BTCPay (or any gateway) from here.
  Settlement is decided by the pure `decideAttempt()` from gateway state and
  `paymentPolicy` — the gateway's `settled` is authoritative and nothing here
  counts confirmations. A `BillingPaymentAttempt` (`(provider, checkout_id)`
  deterministic id) records every state and settles once; grants and payments
  are keyed by checkout id. Invoice payments close the issuer's invoice out of
  band in `observe()` (idempotent) before `project()` records the payment, and
  `settlePaidInvoice` skips (records nothing for) a `paidOutOfBand` invoice
  the rail latched with `outOfBandRequestedAt`; other out-of-band closes are
  recorded as `OTHER` payments. Rails never save cards or charge tax: a taxed
  credit purchase on a rail needs an explicit `automaticTax: false`. Exceptions are flags for operators;
  nothing reverses or refunds automatically.
- **Known limits**: write-offs post no bad-debt journal (AR stays until paid
  or journaled by an operator); discounts still reach Stripe as negative lines (the SDK's
  line `discount` would change the lines a replayed push reconciles, so it
  needs its own migration); `RetailCharge` has no adjustment ledger. Flat
  plans are monthly, in arrears; plan changes are not prorated (#3119).

## Cross-Package References

- `customerId` → `@foreignKey('Customer')` (hard reference within package)
- `vendorId` → `@foreignKey('Vendor')` on PurchaseContract only
- `profileId` → plain string to smrt-profiles
- `arJournalId`, `revenueJournalId` → plain string to smrt-ledgers
- `skuId` (on `PaymentIntent`, `LicenseSale`) → plain string to smrt-products
- `paymentId` (on `PaymentIntent`, `Payout`, `LicenseSale`) → plain string to `Payment` (same package, but kept as plain string for cross-model consistency)
- `vendorId` on `Payout` → `@foreignKey(Vendor)` (hard reference within package)
- Billing records reference tenants with `@crossPackageRef('@happyvertical/smrt-users:Tenant')` and charges, plan periods, and adjustments by plain `sourceId`

## Gotchas

- **Optional tenancy**: all models `@TenantScoped({ mode: 'optional' })` + nullable tenantId
- **Money units and arithmetic**: money fields use signed integer minor units; rates and quantities remain decimal where their contracts require them. Exact rounding, tax-code resolution, legacy adapters, safe-integer validation, and journal units are defined in the [commercial money model](agents/money-model.md) and [money calculator](agents/money-calculator.md). Do not reintroduce floating-point tolerances on money paths.
- **Tenant money migration**: the [tenant line-amount migration](agents/line-amount-migration.md) is authoritative for preflight, the durable journal, tenant barrier, marker activation, issued snapshots, verification, and checksum-guarded rollback. It is distinct from the compatibility behavior described in [document money](agents/document-money.md).
- **Asset-native amounts stay outside line migration**: `Payment.nativeAmount` and `PaymentIntent.paymentOptions[].nativeAmount` are per-asset values identified by `nativeCurrency`; normalize each asset to its own minor unit before any type conversion, and never apply the commerce ×100 line-money rescale to them.
- **Invoice controls payment status**: not the Payment model — use `Invoice.updatePaymentStatus()`
- **Tax rate is external**: no tax rate field on Invoice — rate must be calculated externally
- **Profile linking**: separate `ProfileCollection.create()` needed to fetch actual Profile object
- **PaymentIntent natural key**: `conflictColumns: ['tenant_id', 'offering_ref', 'licensee_email', 'idempotency_key']` — a retried `create` with the same tuple upserts the existing row. Use `PaymentIntentCollection.getOrCreateByIdempotencyKey()` to branch on `{ intent, created }`. Empty natural-key inputs (e.g. blank `idempotencyKey`) disable dedup by design.
- **Payout state-machine guards**: `markSent` requires a non-empty `backendTxRef`; `markConfirmed` only valid from `SENT`; `markFailed` only valid from `PENDING` / `SENT` (a confirmed payout can't fail — that path is a refund). `resetFromFailed()` is the dedicated escape hatch from `FAILED` back to `PENDING` after an operator fixes the underlying problem; it clears `backendTxRef` so the next attempt picks up a fresh one.
- **LicenseSale immutability**: rights snapshot freezes on save-with-status-ACCEPTED. The captured snapshot lives in a module-scoped `WeakMap<LicenseSale, string>` so it doesn't interact with the schema or round-trip through `_meta_data`. Drafts (status != ACCEPTED) remain mutable. To "change" an issued license: `revoke()` it, then issue a new `LicenseSale` row.
- **Vendor.payoutAddresses normalization**: the constructor accepts either a `Record<string, string>` or a pre-serialized JSON string. `initialize()` re-normalizes after the framework's option-override pass; `save()` re-normalizes defensively against direct field assignment. Non-string values inside the input map are silently dropped to preserve the typed invariant downstream.

## Commercial UI

`CustomerSelect`/`VendorSelect` are the registered selectors for Customer and
Vendor (`selects` in `src/ui.ts`); models carry `ui.widget` / `ui.format` hints. See
[customer/vendor UI](agents/customer-vendor-ui.md#selectors-3602).

See [commercial UI composition](agents/commercial-ui.md) for native form recovery, amount compatibility and backend ownership. Package-owned guides under `agents/` ship with the package.

## Quote and estimate UI

`src/svelte/quote-types.ts` separates unparsed draft strings from explicit
minor-unit revision DTOs. Native row submitters, caller-owned retry identity and
extension conventions are documented in [agents/quote-ui.md](agents/quote-ui.md).

## Purchasing UI

`PurchaseOrderEditor` preserves allocation IDs and explicit zeroes, including
retained reduction rows; the server validates review fingerprints before recording.
See [agents/purchasing-ui.md](agents/purchasing-ui.md) for caller responsibilities.

## Exact cost billing

Pure signed cost billing and explicit tax rounding are available through the
independent `cost-billing` subpath; see [contract](agents/cost-billing.md).
