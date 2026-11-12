/** Loaded after package models, with their existing physical tables. */
import { smrt } from '@happyvertical/smrt-core';
import { HistoricalCustomerFunds as BaseHistoricalCustomerFunds } from '../models/HistoricalCustomerFunds.js';
import { HistoricalCustomerFundsAllocation as BaseHistoricalCustomerFundsAllocation } from '../models/HistoricalCustomerFundsAllocation.js';
import { HistoricalSalesLine as BaseHistoricalSalesLine } from '../models/HistoricalSalesLine.js';
import { InvoiceLineItem as BaseInvoiceLineItem } from '../models/InvoiceLineItem.js';
import { Payment as BasePayment } from '../models/Payment.js';
import { PaymentAllocation as BasePaymentAllocation } from '../models/PaymentAllocation.js';
import { Payout as BasePayout } from '../models/Payout.js';
import { PurchasePriceObservation as BasePurchasePriceObservation } from '../models/PurchasePriceObservation.js';
@smrt({ packageName: '@local/issue4931-commerce', tableName: 'payouts' })
export class Payout extends BasePayout {}
@smrt({
  packageName: '@local/issue4931-commerce',
  tableName: 'invoice_line_items',
})
export class InvoiceLineItem extends BaseInvoiceLineItem {}
@smrt({ packageName: '@local/issue4931-commerce', tableName: 'payments' })
export class Payment extends BasePayment {}
@smrt({
  packageName: '@local/issue4931-commerce',
  tableName: 'payment_allocations',
})
export class PaymentAllocation extends BasePaymentAllocation {}
@smrt({
  packageName: '@local/issue4931-commerce',
  tableName: 'historical_customer_funds',
})
export class HistoricalCustomerFunds extends BaseHistoricalCustomerFunds {}
@smrt({
  packageName: '@local/issue4931-commerce',
  tableName: 'historical_customer_funds_allocations',
})
export class HistoricalCustomerFundsAllocation extends BaseHistoricalCustomerFundsAllocation {}
@smrt({
  packageName: '@local/issue4931-commerce',
  tableName: 'historical_sales_lines',
})
export class HistoricalSalesLine extends BaseHistoricalSalesLine {}
@smrt({
  packageName: '@local/issue4931-commerce',
  tableName: 'purchase_price_observations',
})
export class PurchasePriceObservation extends BasePurchasePriceObservation {}
