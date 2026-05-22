# @happyvertical/smrt-commerce

E-commerce with Contract STI hierarchy, invoice lifecycle, payment tracking, and optional ledger integration.

## Models

- **Customer** / **Vendor**: linked to Profile via string ID (not FK). Customer has creditLimit, paymentTerms, customerType (DTC / WHOLESALE / RETAIL). Vendor has leadTimeDays, minimumOrder.
- **Contract** (STI base → Estimate, Order, Lease, Agreement, PurchaseOrder, WholesaleOrder, ProductionOrder, Cart): 8 contract types sharing one table. Carries `channelId` (open-ended string — `dtc-web`, `wholesale-b2b`, `pos-store-N`, etc.) so the same model serves DTC checkout, B2B portals, and POS.
- **WholesaleOrder**: B2B order. Conventional pairing — customer has `customerType: 'wholesale'`, NET-30/60 terms, delivered via wholesale-portal channel.
- **ProductionOrder**: manufacturing equivalent of a PurchaseOrder — commission your factory to make finished goods. Consumes raw materials per BOM (`@happyvertical/smrt-manufacturing`) and produces SKU stock (`@happyvertical/smrt-inventory`).
- **Cart**: transient order-in-progress. Same shape as Order; the application promotes the row from `_meta_type: Cart` to `_meta_type: Order` at checkout instead of copying data between tables.
- **ContractLineItem**: items on contracts.
- **Invoice**: status machine `DRAFT → SENT → VIEWED → PARTIAL → PAID` (also OVERDUE, CANCELLED, WRITTEN_OFF). `recognizeRevenue()` creates balanced AR journal entry (DR: Accounts Receivable, CR: Revenue, CR: Tax Payable).
- **InvoiceLineItem**: line items on invoices.
- **Payment** / **PaymentAllocation**: tracks payments against invoices. Status controlled by `Invoice.updatePaymentStatus()`, not Payment model.
- **Fulfillment** / **FulfillmentLineItem**: shipment/delivery tracking.

## Ledger Integration

Dynamic import of `@happyvertical/smrt-ledgers` — optional dependency. Invoice stores `arJournalId` and `revenueJournalId` as string references. `recognizeRevenue()` returns null if ledgers not available.

## Cross-Package References

- `customerId` → `@foreignKey('Customer')` (hard reference within package)
- `profileId` → plain string to smrt-profiles
- `arJournalId`, `revenueJournalId` → plain string to smrt-ledgers

## Gotchas

- **Optional tenancy**: all models `@TenantScoped({ mode: 'optional' })` + nullable tenantId
- **Currency in decimal fields**: price, taxAmount, totalAmount (not integer cents like affiliates)
- **Invoice controls payment status**: not the Payment model — use `Invoice.updatePaymentStatus()`
- **Tax rate is external**: no tax rate field on Invoice — rate must be calculated externally
- **Profile linking**: separate `ProfileCollection.create()` needed to fetch actual Profile object
