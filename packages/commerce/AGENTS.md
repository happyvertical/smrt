# @happyvertical/smrt-commerce

E-commerce with Contract STI hierarchy, invoice lifecycle, payment tracking, payout remittance, and optional ledger integration.

## Models

- **Customer** / **Vendor**: linked to Profile via string ID (not FK). Customer has creditLimit, paymentTerms, customerType (DTC / WHOLESALE / RETAIL). Vendor has leadTimeDays, minimumOrder, and `payoutAddresses: Record<string, string>` — a flat map from payout-rail-qualified currency code (`USDC-base`, `BTC`, `USD-stripe`, ...) to destination string (EVM address, BTC address, Stripe Connect account id, IBAN). Use `getPayoutAddress(currency)` for a `Map.get`-style lookup; missing entries return `undefined` (caller decides skip-vs-error).
- **Contract** (STI base → Estimate, Order, Lease, Agreement, PurchaseOrder, WholesaleOrder, ProductionOrder, Cart, LicenseSale): 9 contract types sharing one table. Carries `channelId` (open-ended string — `dtc-web`, `wholesale-b2b`, `pos-store-N`, etc.) so the same model serves DTC checkout, B2B portals, and POS.
- **WholesaleOrder**: B2B order. Conventional pairing — customer has `customerType: 'wholesale'`, NET-30/60 terms, delivered via wholesale-portal channel.
- **ProductionOrder**: manufacturing equivalent of a PurchaseOrder — commission your factory to make finished goods. Consumes raw materials per BOM (`@happyvertical/smrt-manufacturing`) and produces SKU stock (`@happyvertical/smrt-inventory`).
- **Cart**: transient order-in-progress. Same shape as Order; the application promotes the row from `_meta_type: Cart` to `_meta_type: Order` at checkout instead of copying data between tables.
- **LicenseSale**: industry-neutral licensing primitive. Carries an *immutable* rights snapshot (`rightsMedium`, `rightsDistributionScope`, `rightsExclusivity`, `rightsDuration`, `rightsTerritory`, `rightsSublicensing`, `rightsDerivatives` — typed `Meta<T>` fields), licensee identity (`licenseeEmail`, optional `licenseeLegalEntity` / `licenseeJurisdiction`), and a signed-PDF reference (`pdfUrl`, `pdfHash`, optional `onChainHashRegistryRef`). Once saved at `ContractStatus.ACCEPTED`, the rights snapshot is frozen — mutating any of the seven rights fields and re-saving throws. The only legal transition out of ACCEPTED is `revoke()` (moves to CANCELLED without touching rights). Useful for stock media, music licensing, code-asset marketplaces, license keys, anywhere rights are sold for a fee.
- **ContractLineItem**: items on contracts.
- **Invoice**: status machine `DRAFT → SENT → VIEWED → PARTIAL → PAID` (also OVERDUE, CANCELLED, WRITTEN_OFF). `recognizeRevenue()` creates balanced AR journal entry (DR: Accounts Receivable, CR: Revenue, CR: Tax Payable).
- **InvoiceLineItem**: line items on invoices.
- **Payment** / **PaymentAllocation**: tracks payments against invoices. Status controlled by `Invoice.updatePaymentStatus()`, not Payment model. Carries optional backend-adapter fields for PaymentBackend-routed flows: `backendId` (rail adapter id — `base-usdc`, `btc`, `stripe`, distinct from `externalProvider` which names an accounting sync destination), `backendTxRef` (chain tx hash or gateway settlement id), `nativeAmount` / `nativeCurrency` (what actually arrived), `usdAtQuote` / `usdAtConfirmation` (drift accounting for volatile-currency rails). `Payment.usdDrift()` returns the confirmation - quote delta, or `0` when either side is unset.
- **PaymentInstrument**: reusable saved payment method ("card on file"). Stores only provider references and non-sensitive display metadata (`providerCustomerId`, `providerPaymentMethodId`, brand / last4 / expiry), never raw card data. Use `PaymentInstrumentCollection.setDefaultForCustomer()` to change the default so the single-default-per-customer invariant is enforced; generated create/update routes cannot write `isDefault` directly.
- **PaymentIntent**: short-lived pre-payment commitment with multi-option semantics. Locks a USD price for a fixed window (default 15 minutes) and lists one or more `PaymentOption`s describing different rails (`backendId`, `currency`, `payTo`, `nativeAmount`, optional `chain` / `memo` / `x402Capable` / `expiresAt`). First option to receive payment wins; the others are implicitly retired. State machine `awaiting_payment → paid → (issued | retired)` plus `expired` and `cancelled`. Mutate via dedicated `markPaid` / `markIssued` / `expire` / `cancel` / `retire` helpers — direct status assignment bypasses the invariant checks. Idempotency via natural key `(tenant_id, offering_ref, licensee_email, idempotency_key)` and `PaymentIntentCollection.getOrCreateByIdempotencyKey()`.
- **Payout**: operator-to-supplier remittance. Distinct from Payment because direction, status machine, and chain semantics differ. Status machine `pending → sent → confirmed → failed` (failed is terminal but resettable via `resetFromFailed()` after fixing the underlying problem). References source `paymentId` (plain string) and destination `vendorId` (foreign key). Amount invariant `supplierNet === grossAmount - operatorFee` enforced exactly on save (integer minor units, no tolerance — #2401). `PayoutCollection.createFromPayment()` is the typical entry point; it pulls native amount / currency from the source Payment.
- **Fulfillment** / **FulfillmentLineItem**: shipment/delivery tracking.

## Ledger Integration

`@happyvertical/smrt-ledgers` is a regular dependency, loaded lazily via dynamic `import()` so the coupling stays runtime-only (no hard static import; the package graph stays a DAG — see #1582). Invoice stores `arJournalId` and `revenueJournalId` as string references. `recognizeRevenue()` creates a balanced AR journal entry; `getArJournal()` returns null when no journal has been recognized yet.

## Billing-period close (#3060)

`src/billing/` closes periods from smrt-subscriptions charges; see the README
for usage.

- **Port, not provider.** Period close, events, and credit checkout call only
  the `BillingProvider` port (integer minor units). `stripe.ts` adapts
  `@happyvertical/accounting`, which takes currency *major* units; convert with
  `units.ts` (ISO 4217 exponent) and never hand-roll a Stripe call here.
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
  a credit purchase; credit is granted only when the collected total equals
  it. Rotating the webhook secret strands in-flight checkouts (up to 24 h). `observe()` re-reads provider state, so
  ordering never depends on delivery order. The standing hook runs inside the
  event transaction and must be idempotent.
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
  `settlePaidInvoice` waits for the rail instead of recording a second
  payment for a `paidOutOfBand` invoice. Exceptions are flags for operators;
  nothing reverses or refunds automatically.
- **Known limits** (each tracked upstream): provider customer creation is not
  idempotent (happyvertical/sdk#1268); credit checkouts are untaxed and
  two-decimal only (sdk#1269); `autoTopUp` cannot charge a saved card
  (sdk#1270); Stripe line discounts and uncollectible status are worked around
  as negative lines and event types (sdk#1271). `RetailCharge` has no
  adjustment ledger. Flat plans are monthly, in arrears; plan changes are not
  prorated (#3119). The Stripe adapter passes line service periods but
  the accounting SDK does not send them to Stripe yet (happyvertical/sdk#1274).

## Cross-Package References

- `customerId` → `@foreignKey('Customer')` (hard reference within package)
- `profileId` → plain string to smrt-profiles
- `arJournalId`, `revenueJournalId` → plain string to smrt-ledgers
- `skuId` (on `PaymentIntent`, `LicenseSale`) → plain string to smrt-products
- `paymentId` (on `PaymentIntent`, `Payout`, `LicenseSale`) → plain string to `Payment` (same package, but kept as plain string for cross-model consistency)
- `vendorId` on `Payout` → `@foreignKey(Vendor)` (hard reference within package)
- Billing records reference tenants with `@crossPackageRef('@happyvertical/smrt-users:Tenant')` and charges, plan periods, and adjustments by plain `sourceId`

## Gotchas

- **Optional tenancy**: all models `@TenantScoped({ mode: 'optional' })` + nullable tenantId
- **Currency is integer minor units** (cents, satoshis) — `$19.99` is `1999`, like affiliates. Money is exact, so money fields initialize `= 0`, never `= 0.0`: the integer literal is what maps them to INTEGER columns (BIGINT on fresh PostgreSQL/DuckDB databases). Writing a fractional major-unit value is the bug — the model rejects it via `assertIntegerMinorUnits` on `Invoice`/`Payment`/`PaymentAllocation`/`Payout`/`Contract` before the database sees it, because PostgreSQL would reject it with `22P02` while SQLite's affinity silently stores it. `pnpm --filter @happyvertical/smrt-commerce test:postgres` is the lane that holds the line (#2361, #2401, #2373).
- **Rates are the opposite**: `InvoiceLineItem.taxRate` and `ContractLineItem.taxRate` are inherently fractional and must initialize `= 0.0`. INTEGER would truncate every rate to 0. `ContractLineItem.quantity` is decimal for the same reason (contracts price fractional hours/weight/bandwidth); `InvoiceLineItem.quantity` is an integer count.
- **Rounding happens where a rate meets money, and nowhere else**: `InvoiceLineItem.getTaxAmount()` and `ContractLineItem.calculateAmount()` `Math.round()` the fractional product to whole minor units. Everything downstream is exact integer arithmetic, which is why **there are no `EPSILON` tolerances left on any money path** (#2401). `Invoice`, `PaymentAllocation`, `Payout` and `PaymentIntent` compare with `===` / `>` / `>=`. Do not reintroduce a tolerance: against integers it forgives a real one-cent discrepancy rather than float fuzz. (`FulfillmentLineItem`'s quantity epsilon is unrelated — quantities are genuinely decimal there.)
- **Migrating an existing database to minor units**: `preflightCommerceMoneyMinorUnits(db)` reports, per column, whether it still holds major units and which rows would be rounded or exceed JavaScript's safe-integer range; `migrateCommerceMoneyToMinorUnits(db)` converts them. Both are exported from the package root. The rescale is idempotent via a `_smrt_backfills` marker, changes the column type in place on PostgreSQL/DuckDB (`ALTER … TYPE BIGINT USING round(col * 100)`), and on SQLite rescales values only — SQLite cannot alter a declared type in place, so those columns come back in `declaredTypeChangePending` and need the table-rebuild path (#2370).
- **`Payment.nativeAmount` is NOT in that migration, and must not be.** Its minor unit is a property of the *row's asset*: satoshis on a BTC rail (×1e8), cents on a fiat or stablecoin rail (×1e2), in one column discriminated only by `nativeCurrency`. A blanket ×100 turns 0.00713 BTC into `1` instead of `713000` sats, and a round 0.01 BTC even passes the preflight's integrality check while being wrong by six orders of magnitude. Convert it in two deliberate steps — normalise each row to its own asset's minor units while the column is still floating-point, then `rescaleMoneyColumnsToMinorUnits(db, COMMERCE_NATIVE_UNIT_COLUMNS, { scale: 1, … })` for the type change. `COMMERCE_NATIVE_UNIT_COLUMNS` is exported with a worked example; step one is deliberately the deployment's to write, because only it knows which `nativeCurrency` values it has used.
- **`PaymentIntent.paymentOptions[].nativeAmount` has the same per-asset problem inside a JSON column and is likewise not migrated.** An intent's price lock defaults to 15 minutes, so the supported answer is to let open intents expire and be re-quoted: an unconverted option fails the exact `!==` reconciliation against the payment that arrives, which is a loud failure rather than a silently mis-scaled quote.
- **Range and existing deployments**: fresh PostgreSQL/DuckDB INTEGER columns are BIGINT, and the runtime rejects values outside JavaScript's safe-integer range rather than rounding them. Existing PostgreSQL `int4` columns do not self-repair; widen them through the explicit migration tracked in #2424.
- **Journals posted from commerce carry minor units**: `Payment.recordPayment()` and `Invoice.recognizeRevenue()` write `amount` / `totalAmount` straight into smrt-ledgers entries. smrt-ledgers is unit-agnostic (its `BALANCE_EPSILON` only checks debits === credits), and integer entries balance exactly, so this is strictly tighter than the major-unit journals commerce used to post.
- **Invoice controls payment status**: not the Payment model — use `Invoice.updatePaymentStatus()`
- **Tax rate is external**: no tax rate field on Invoice — rate must be calculated externally
- **Profile linking**: separate `ProfileCollection.create()` needed to fetch actual Profile object
- **PaymentIntent natural key**: `conflictColumns: ['tenant_id', 'offering_ref', 'licensee_email', 'idempotency_key']` — a retried `create` with the same tuple upserts the existing row. Use `getOrCreateByIdempotencyKey()` to branch on `{ intent, created }`. Empty natural-key inputs (e.g. blank `idempotencyKey`) disable dedup by design.
- **Payout state-machine guards**: `markSent` requires a non-empty `backendTxRef`; `markConfirmed` only valid from `SENT`; `markFailed` only valid from `PENDING` / `SENT` (a confirmed payout can't fail — that path is a refund). `resetFromFailed()` is the dedicated escape hatch from `FAILED` back to `PENDING` after an operator fixes the underlying problem; it clears `backendTxRef` so the next attempt picks up a fresh one.
- **PaymentInstrument defaults**: `isDefault` is domain-managed, not API-writable. Call `setDefaultForCustomer(customerId, instrumentId)` so the target is validated and the customer's other instruments are cleared.
- **LicenseSale immutability**: rights snapshot freezes on save-with-status-ACCEPTED. The captured snapshot lives in a module-scoped `WeakMap<LicenseSale, string>` so it doesn't interact with the schema or round-trip through `_meta_data`. Drafts (status != ACCEPTED) remain mutable. To "change" an issued license: `revoke()` it, then issue a new `LicenseSale` row.
- **Vendor.payoutAddresses normalization**: the constructor accepts either a `Record<string, string>` or a pre-serialized JSON string. `initialize()` re-normalizes after the framework's option-override pass; `save()` re-normalizes defensively against direct field assignment. Non-string values inside the input map are silently dropped to preserve the typed invariant downstream.
