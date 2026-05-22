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
- **PaymentIntent**: short-lived pre-payment commitment with multi-option semantics. Locks a USD price for a fixed window (default 15 minutes) and lists one or more `PaymentOption`s describing different rails (`backendId`, `currency`, `payTo`, `nativeAmount`, optional `chain` / `memo` / `x402Capable` / `expiresAt`). First option to receive payment wins; the others are implicitly retired. State machine `awaiting_payment → paid → (issued | retired)` plus `expired` and `cancelled`. Mutate via dedicated `markPaid` / `markIssued` / `expire` / `cancel` / `retire` helpers — direct status assignment bypasses the invariant checks. Idempotency via natural key `(tenant_id, offering_ref, licensee_email, idempotency_key)` and `PaymentIntentCollection.getOrCreateByIdempotencyKey()`.
- **Payout**: operator-to-supplier remittance. Distinct from Payment because direction, status machine, and chain semantics differ. Status machine `pending → sent → confirmed → failed` (failed is terminal but resettable via `resetFromFailed()` after fixing the underlying problem). References source `paymentId` (plain string) and destination `vendorId` (foreign key). Amount invariant `supplierNet === grossAmount - operatorFee` (1¢ rounding tolerance) enforced on save. `PayoutCollection.createFromPayment()` is the typical entry point; it pulls native amount / currency from the source Payment.
- **Fulfillment** / **FulfillmentLineItem**: shipment/delivery tracking.

## Ledger Integration

Dynamic import of `@happyvertical/smrt-ledgers` — optional dependency. Invoice stores `arJournalId` and `revenueJournalId` as string references. `recognizeRevenue()` returns null if ledgers not available.

## Cross-Package References

- `customerId` → `@foreignKey('Customer')` (hard reference within package)
- `profileId` → plain string to smrt-profiles
- `arJournalId`, `revenueJournalId` → plain string to smrt-ledgers
- `skuId` (on `PaymentIntent`, `LicenseSale`) → plain string to smrt-products
- `paymentId` (on `PaymentIntent`, `Payout`, `LicenseSale`) → plain string to `Payment` (same package, but kept as plain string for cross-model consistency)
- `vendorId` on `Payout` → `@foreignKey(Vendor)` (hard reference within package)

## Gotchas

- **Optional tenancy**: all models `@TenantScoped({ mode: 'optional' })` + nullable tenantId
- **Currency in decimal fields**: price, taxAmount, totalAmount (not integer cents like affiliates)
- **Invoice controls payment status**: not the Payment model — use `Invoice.updatePaymentStatus()`
- **Tax rate is external**: no tax rate field on Invoice — rate must be calculated externally
- **Profile linking**: separate `ProfileCollection.create()` needed to fetch actual Profile object
- **PaymentIntent natural key**: `conflictColumns: ['tenant_id', 'offering_ref', 'licensee_email', 'idempotency_key']` — a retried `create` with the same tuple upserts the existing row. Use `getOrCreateByIdempotencyKey()` to branch on `{ intent, created }`. Empty natural-key inputs (e.g. blank `idempotencyKey`) disable dedup by design.
- **Payout state-machine guards**: `markSent` requires a non-empty `backendTxRef`; `markConfirmed` only valid from `SENT`; `markFailed` only valid from `PENDING` / `SENT` (a confirmed payout can't fail — that path is a refund). `resetFromFailed()` is the dedicated escape hatch from `FAILED` back to `PENDING` after an operator fixes the underlying problem; it clears `backendTxRef` so the next attempt picks up a fresh one.
- **LicenseSale immutability**: rights snapshot freezes on save-with-status-ACCEPTED. The captured snapshot lives in a module-scoped `WeakMap<LicenseSale, string>` so it doesn't interact with the schema or round-trip through `_meta_data`. Drafts (status != ACCEPTED) remain mutable. To "change" an issued license: `revoke()` it, then issue a new `LicenseSale` row.
- **Vendor.payoutAddresses normalization**: the constructor accepts either a `Record<string, string>` or a pre-serialized JSON string. `initialize()` re-normalizes after the framework's option-override pass; `save()` re-normalizes defensively against direct field assignment. Non-string values inside the input map are silently dropped to preserve the typed invariant downstream.
