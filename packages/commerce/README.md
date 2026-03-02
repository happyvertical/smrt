# @happyvertical/smrt-commerce

Commerce models for the SMRT framework. Covers customers, vendors, contracts (5 STI types), invoices with ledger integration, payments, and fulfillment tracking.

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
const customers = new CustomerCollection(db);
const customer = await customers.create({
  profileId: 'profile-uuid',
  creditLimit: 10000.00,
  paymentTerms: 'Net 30',
});
await customer.save();

// Create an order (STI contract type)
const contracts = new ContractCollection(db);
const order = await contracts.create({
  _meta_type: 'Order',
  customerId: customer.id,
  subtotal: 1000.00,
  taxAmount: 50.00,
  totalAmount: 1050.00,
  currency: 'CAD',
});
await order.save();

// Create an invoice for the order
const invoices = new InvoiceCollection(db);
const invoiceNumber = await invoices.generateInvoiceNumber();
const invoice = await invoices.create({
  customerId: customer.id,
  contractId: order.id,
  invoiceNumber,
  subtotal: 1000.00,
  taxAmount: 50.00,
  totalAmount: 1050.00,
});
await invoice.save();

// Recognize revenue (creates balanced journal in smrt-ledgers)
await invoice.recognizeRevenue({
  arAccountId: 'ar-account-id',
  revenueAccountId: 'revenue-account-id',
  taxAccountId: 'tax-account-id',
});

// Record a payment
const payments = new PaymentCollection(db);
const payment = await payments.create({
  contractId: order.id,
  customerId: customer.id,
  amount: 1050.00,
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

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-tenancy` -- multi-tenant scoping
- `@happyvertical/smrt-types` -- shared type definitions
- Peer: `@happyvertical/smrt-ledgers`, `@happyvertical/smrt-profiles`, `@happyvertical/smrt-svelte`
