import type { InvoiceFieldNames, InvoiceLineFieldNames } from './types.js';
/** Stable native header field defaults. */
export const invoiceFieldNames: InvoiceFieldNames = {
  customerId: 'customerId',
  issuedOn: 'issuedOn',
  dueOn: 'dueOn',
  currency: 'currency',
  paymentTerms: 'paymentTerms',
  taxRate: 'invoiceTaxRate',
  intent: 'intent',
};
/** Stable repeated native line field defaults. */
export const invoiceLineFieldNames: InvoiceLineFieldNames = {
  key: 'lineKey',
  description: 'lineDescription',
  sku: 'lineSku',
  quantity: 'lineQuantity',
  unitPrice: 'lineUnitPrice',
  discountType: 'lineDiscountType',
  discountValue: 'lineDiscountValue',
  taxMode: 'lineTaxMode',
  taxRate: 'lineTaxRate',
};
