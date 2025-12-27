# @happyvertical/smrt-commerce

Commerce models for the SMRT framework - contracts, fulfillments, and payments with automatic ledger integration.

## Purpose

This package provides SMRT-wrapped models for commerce operations:

- **Customer**: Customer role linked to Profile with credit/payment terms
- **Vendor**: Vendor/supplier role linked to Profile with lead times
- **Contract**: STI base for Estimate, Order, Lease, Agreement, PurchaseOrder
- **ContractLineItem**: Individual items on contracts
- **Fulfillment**: Shipment/delivery tracking
- **FulfillmentLineItem**: Which items were fulfilled
- **Payment**: Payment tracking with ledger integration

## Architecture

```
Profile (smrt-profiles)
   ↑
   ├── Customer (profileId + creditLimit, paymentTerms)
   └── Vendor (profileId + leadTimeDays, minimumOrder)
         ↓
Contract (STI: Estimate, Order, Lease, etc.)
   → customerId / vendorId
   → ContractLineItem[]
         ↓
Fulfillment
   → FulfillmentLineItem[]
         ↓
Payment
   → recordPayment() → Journal (smrt-ledgers)
```

## Key Concepts

### Customer and Vendor Link to Profile

One Profile can have BOTH a Customer and Vendor record:

```typescript
// A company you both buy from and sell to
const sharedProfileId = 'company-abc';

const customer = await customers.create({
  profileId: sharedProfileId,
  creditLimit: 10000,
  paymentTerms: 'Net 30'
});

const vendor = await vendors.create({
  profileId: sharedProfileId,
  leadTimeDays: 14,
  paymentTerms: 'Net 60'
});
```

### Contract STI Types

Contract uses Single Table Inheritance for different contract types:

| Type | Use Case |
|------|----------|
| Estimate | Quote/proposal to customer |
| Order | Customer purchase order |
| Lease | Rental/lease agreement |
| Agreement | Service/maintenance contract |
| PurchaseOrder | Order to vendor/supplier |

```typescript
// Create an estimate
const estimate = await contracts.create({
  _meta_type: 'Estimate',
  customerId: customer.id,
  totalAmount: 5000,
  expiryDate: new Date('2024-12-31')
});

// Create a purchase order
const po = await contracts.create({
  _meta_type: 'PurchaseOrder',
  vendorId: vendor.id,
  totalAmount: 10000,
  reference: 'PO-2024-001'
});
```

### Payment with Ledger Integration

Payments integrate with `@happyvertical/smrt-ledgers` to create balanced journal entries:

```typescript
const payment = await payments.create({
  contractId: order.id,
  customerId: customer.id,
  amount: 1500,
  method: PaymentMethod.CREDIT_CARD
});
await payment.save();

// Record payment with automatic journal entry
const journal = await payment.recordPayment({
  ledgerId: '',
  cashAccountId: bankAccount.id,        // Debit: Cash increases
  receivablesAccountId: arAccount.id    // Credit: AR decreases
});

// Payment is now completed
console.log(payment.status);     // 'completed'
console.log(payment.journalId);  // Links to journal
```

## Usage

### Basic Setup

```typescript
import {
  Customer,
  CustomerCollection,
  Contract,
  ContractCollection,
  Payment,
  PaymentCollection,
  ContractType,
  ContractStatus,
  PaymentMethod,
} from '@happyvertical/smrt-commerce';

// Create collections with database
const customers = await CustomerCollection.create({
  persistence: { type: 'sql', url: 'commerce.db' }
});

const contracts = await ContractCollection.create({
  persistence: { type: 'sql', url: 'commerce.db' }
});

const payments = await PaymentCollection.create({
  persistence: { type: 'sql', url: 'commerce.db' }
});
```

### Creating a Customer Order

```typescript
// 1. Create/get customer
const customer = await customers.getOrCreateForProfile('profile-id', {
  creditLimit: 10000,
  paymentTerms: 'Net 30'
});

// 2. Create order
const order = await contracts.create({
  _meta_type: 'Order',
  customerId: customer.id,
  status: ContractStatus.DRAFT
});
await order.save();

// 3. Add line items (using SmrtCollection for ContractLineItem)
const lineItem = await lineItems.create({
  contractId: order.id,
  description: 'Widget Pro',
  quantity: 10,
  unitPrice: 49.99,
  taxRate: 0.08
});
await lineItem.save();

// 4. Update totals
order.subtotal = lineItem.amount;
order.taxAmount = lineItem.amount * 0.08;
order.totalAmount = order.subtotal + order.taxAmount;
await order.save();

// 5. Accept the order
order.status = ContractStatus.ACCEPTED;
await order.save();
```

### Fulfilling an Order

```typescript
import {
  Fulfillment,
  FulfillmentCollection,
  FulfillmentType,
} from '@happyvertical/smrt-commerce';

const fulfillments = await FulfillmentCollection.create(options);

// Create shipment
const fulfillment = await fulfillments.create({
  contractId: order.id,
  fulfillmentType: FulfillmentType.SHIPMENT,
  shippingAddress: customer.defaultShippingAddress
});
await fulfillment.save();

// Mark as shipped
fulfillment.markShipped('UPS-123456', 'UPS');
await fulfillment.save();

// Mark as delivered
fulfillment.markDelivered();
await fulfillment.save();
```

### Recording Payment

```typescript
// Without ledger integration
const payment = await payments.create({
  contractId: order.id,
  customerId: customer.id,
  amount: order.totalAmount,
  method: PaymentMethod.CREDIT_CARD,
  transactionId: 'stripe_pi_xxx'
});
await payment.save();

// Mark as completed manually
payment.status = PaymentStatus.COMPLETED;
payment.paidAt = new Date();
await payment.save();

// OR with ledger integration
await payment.recordPayment({
  ledgerId: '',
  cashAccountId: cashAccount.id,
  receivablesAccountId: arAccount.id
});
// This automatically:
// 1. Creates balanced journal entry
// 2. Posts the journal
// 3. Updates payment status to COMPLETED
// 4. Sets paidAt timestamp
// 5. Links journalId
```

## Models Reference

### Customer

| Field | Type | Description |
|-------|------|-------------|
| profileId | string | Link to smrt-profiles Profile |
| creditLimit | number | Maximum credit extended |
| paymentTerms | string | e.g., "Net 30" |
| taxExempt | boolean | Tax exemption status |
| taxId | string | Tax identification number |
| defaultShippingAddress | Address | Default shipping |
| defaultBillingAddress | Address | Default billing |
| status | CustomerStatus | active, inactive, suspended |

### Vendor

| Field | Type | Description |
|-------|------|-------------|
| profileId | string | Link to smrt-profiles Profile |
| leadTimeDays | number | Typical lead time |
| minimumOrderAmount | number | Minimum order value |
| paymentTerms | string | Payment terms |
| currency | string | Default currency |
| defaultContactEmail | string | Order contact email |
| defaultContactPhone | string | Order contact phone |
| status | VendorStatus | active, inactive, suspended |

### Contract

| Field | Type | Description |
|-------|------|-------------|
| contractType | ContractType | STI discriminator |
| status | ContractStatus | draft, sent, accepted, etc. |
| customerId | foreignKey | Customer (for sales) |
| vendorId | foreignKey | Vendor (for purchases) |
| subtotal | number | Before tax |
| taxAmount | number | Tax amount |
| totalAmount | number | Including tax |
| currency | string | Currency code |
| issueDate | Date | Issue date |
| dueDate | Date | Payment due date |
| expiryDate | Date | Quote expiry (estimates) |
| reference | string | External reference |

### Payment

| Field | Type | Description |
|-------|------|-------------|
| contractId | foreignKey | Parent contract |
| customerId | foreignKey | Who paid |
| amount | number | Payment amount |
| currency | string | Currency code |
| method | PaymentMethod | cash, check, credit_card, etc. |
| status | PaymentStatus | pending, completed, failed, etc. |
| transactionId | string | External processor ID |
| reference | string | Internal reference |
| journalId | string | Link to smrt-ledgers Journal |
| paidAt | Date | Completion timestamp |

## Collections

All collections extend `SmrtCollection` and provide:

- `findByCustomer(customerId)`: Query by customer
- `findByVendor(vendorId)`: Query by vendor
- `findByContract(contractId)`: Query by contract
- `findByProfile(profileId)`: Query Customer/Vendor by Profile
- `findByStatus(status)`: Query by status
- Status helpers: `findPending()`, `findCompleted()`, etc.

## Testing

```bash
# Generate manifest and run tests
pnpm run test

# Or run manually
pnpm run generate:test
npx vitest run
```

## Dependencies

- `@happyvertical/smrt-core`: SMRT framework
- `@happyvertical/smrt-ledgers` (peer): Ledger integration
- `@happyvertical/smrt-profiles` (peer): Profile linking

## Environment Variables

No specific environment variables required.

Configuration via smrt.config:

```javascript
// smrt.config.js
export default {
  modules: {
    'smrt-commerce': {
      // Module-specific config
    }
  }
}
```
