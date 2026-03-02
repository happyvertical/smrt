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
  Invoice, InvoiceCollection,
  Payment, PaymentCollection,
  Contract, ContractCollection,
  InvoiceStatus, PaymentMethod
} from '@happyvertical/smrt-commerce';

// Create a customer
const customers = new CustomerCollection(db);
const customer = await customers.create({
  name: 'Acme Corp',
  status: 'active',
});
await customer.save();

// Create an invoice
const invoices = new InvoiceCollection(db);
const invoice = await invoices.create({
  customerId: customer.id,
  status: InvoiceStatus.Draft,
  total: 500.00,
});
await invoice.save();

// Record a payment
const payments = new PaymentCollection(db);
await payments.create({
  invoiceId: invoice.id,
  amount: 500.00,
  method: PaymentMethod.BankTransfer,
  status: 'completed',
});
```

## API

### Models

| Export | Description |
|--------|------------|
| `Customer` | Customer record with status and contact info |
| `Vendor` | Vendor/supplier record |
| `Contract` | Base contract (STI base) |
| `Agreement` | Agreement contract type (STI) |
| `Estimate` | Estimate contract type (STI) |
| `Lease` | Lease contract type (STI) |
| `Order` | Order contract type (STI) |
| `PurchaseOrder` | Purchase order contract type (STI) |
| `ContractLineItem` | Line item within a contract |
| `Invoice` | Invoice with status lifecycle and totals |
| `InvoiceLineItem` | Individual invoice line item |
| `Payment` | Payment record with method and status |
| `PaymentAllocation` | Payment-to-invoice allocation |
| `Fulfillment` | Fulfillment/delivery tracking |
| `FulfillmentLineItem` | Individual fulfillment line item |

### Collections

`CustomerCollection`, `VendorCollection`, `ContractCollection`, `InvoiceCollection`, `InvoiceLineItemCollection`, `PaymentCollection`, `PaymentAllocationCollection`, `FulfillmentCollection`

### Enums

| Export | Description |
|--------|------------|
| `ContractType` | Contract STI discriminator types |
| `ContractStatus` | Contract lifecycle status |
| `CustomerStatus` | Customer lifecycle status |
| `VendorStatus` | Vendor lifecycle status |
| `InvoiceStatus` | Invoice lifecycle status |
| `PaymentMethod` | Payment method types |
| `PaymentStatus` | Payment lifecycle status |
| `FulfillmentStatus` | Fulfillment lifecycle status |
| `FulfillmentType` | Fulfillment type classification |

### Constants

`UNPAID_STATUSES`, `COMMERCE_MODULE_META`, `COMMERCE_UI_SLOTS`

## Dependencies

- `@happyvertical/smrt-core` — ORM and code generation
- `@happyvertical/smrt-tenancy` — multi-tenant scoping
- `@happyvertical/smrt-types` — shared type definitions
- Peer: `@happyvertical/smrt-ledgers`, `@happyvertical/smrt-profiles`, `@happyvertical/smrt-svelte`
