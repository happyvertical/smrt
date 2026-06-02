/**
 * @happyvertical/smrt-commerce
 *
 * Commerce models for the SMRT framework - contracts, fulfillments, payments.
 *
 * Key concepts:
 * - Customer/Vendor link to Profile (from smrt-profiles)
 * - Contract uses STI for different types (Estimate, Order, Lease, etc.)
 * - Payment integrates with smrt-ledgers for journal entries
 *
 * @example
 * ```typescript
 * import {
 *   Customer,
 *   CustomerCollection,
 *   Order,
 *   ContractCollection,
 *   Payment,
 *   PaymentCollection,
 * } from '@happyvertical/smrt-commerce';
 *
 * // Create collections
 * const customers = await CustomerCollection.create({
 *   persistence: { type: 'sql', url: 'commerce.db' }
 * });
 *
 * // Create a customer linked to a profile
 * const customer = await customers.create({
 *   profileId: 'profile-uuid',
 *   creditLimit: 10000,
 *   paymentTerms: 'Net 30'
 * });
 * await customer.save();
 *
 * // Create an order
 * const contracts = await ContractCollection.create(customer.options);
 * const order = await contracts.create({
 *   _meta_type: 'Order',
 *   customerId: customer.id,
 *   totalAmount: 1500.00
 * });
 * await order.save();
 *
 * // Record payment with ledger integration
 * const payments = await PaymentCollection.create(order.options);
 * const payment = await payments.create({
 *   contractId: order.id,
 *   customerId: customer.id,
 *   amount: 1500.00
 * });
 * await payment.save();
 *
 * await payment.recordPayment({
 *   ledgerId: ledger.id,
 *   receivablesAccountId: arAccount.id,
 *   cashAccountId: bankAccount.id
 * });
 * ```
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

// Collections
export {
  ContractCollection,
  type CreatePayoutFromPaymentArgs,
  CustomerCollection,
  FulfillmentCollection,
  InvoiceCollection,
  InvoiceLineItemCollection,
  type InvoiceNumberOptions,
  PaymentAllocationCollection,
  PaymentCollection,
  PaymentIntentCollection,
  type PaymentIntentIdempotencyArgs,
  type PaymentIntentSeed,
  PayoutCollection,
  UNPAID_STATUSES,
  VendorCollection,
} from './collections/index.js';
// Models
export {
  Agreement,
  Cart,
  Contract,
  ContractLineItem,
  Customer,
  Estimate,
  Fulfillment,
  FulfillmentLineItem,
  Invoice,
  InvoiceLineItem,
  Lease,
  type LicenseRightsSnapshot,
  LicenseSale,
  Order,
  Payment,
  PaymentAllocation,
  PaymentIntent,
  Payout,
  ProductionOrder,
  PurchaseOrder,
  Vendor,
  WholesaleOrder,
} from './models/index.js';

// Types
export {
  type Address,
  ContractStatus,
  ContractType,
  CustomerStatus,
  CustomerType,
  FulfillmentStatus,
  FulfillmentType,
  InvoiceStatus,
  PaymentIntentStatus,
  PaymentMethod,
  type PaymentOption,
  PaymentStatus,
  PayoutStatus,
  type RecognizeRevenueOptions,
  type RecordPaymentOptions,
  VendorStatus,
} from './types/index.js';

// UI metadata (no Svelte dependency - import ./svelte for components)
export { COMMERCE_MODULE_META, COMMERCE_UI_SLOTS } from './ui.js';
