# @happyvertical/smrt-commerce

E-commerce with Contract STI hierarchy, invoice lifecycle, payment tracking, and optional ledger integration.

## Models

- **Customer** / **Vendor**: linked to Profile via string ID (not FK). Customer has creditLimit, paymentTerms. Vendor has leadTimeDays, minimumOrder.
- **Contract** (STI base → Estimate, Order, Lease, Agreement, PurchaseOrder): 5 contract types sharing one table.
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
