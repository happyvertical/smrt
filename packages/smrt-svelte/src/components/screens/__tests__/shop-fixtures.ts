import type { ScreenCollectionDefinition, ScreenRecord } from '../types.js';

/**
 * A commerce-shaped model set for the record page: a customer, its orders
 * (a document: number, status, party, money totals) with line items, and
 * payments. Hints are as smrt-commerce's manifest carries them: amounts
 * `ui.format: 'money'`, the currency code `ui.widget: 'currency'`.
 */
export const customers: ScreenCollectionDefinition = {
  name: 'customers',
  objectRef: '@acme/shop:Customer',
  className: 'Customer',
  fields: {
    id: { type: 'text' },
    createdAt: { type: 'datetime' },
    name: { type: 'text', required: true },
    email: { type: 'text', ui: { widget: 'email' } },
    status: { type: 'text', enum: ['active', 'inactive'] },
    phoneNumber: { type: 'text', ui: { widget: 'phone' } },
  },
  relationships: [],
};

export const orders: ScreenCollectionDefinition = {
  name: 'orders',
  objectRef: '@acme/shop:Order',
  className: 'Order',
  fields: {
    id: { type: 'text' },
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
    number: { type: 'text' },
    status: { type: 'text', enum: ['draft', 'sent', 'paid', 'cancelled'] },
    customerId: { type: 'foreignKey' },
    issuedAt: { type: 'datetime', ui: { format: 'date' } },
    subtotal: { type: 'integer', ui: { format: 'money' } },
    discountAmount: { type: 'integer', ui: { format: 'money' } },
    taxAmount: { type: 'integer', ui: { format: 'money' } },
    totalAmount: { type: 'integer', ui: { format: 'money' } },
    currency: { type: 'text', ui: { widget: 'currency' } },
    notes: { type: 'text', ui: { widget: 'textarea' } },
    shippingAddress: { type: 'json' },
  },
  relationships: [
    { field: 'customerId', kind: 'foreignKey', relatedCollection: 'customers' },
  ],
};

export const orderLines: ScreenCollectionDefinition = {
  name: 'order_lines',
  objectRef: '@acme/shop:OrderLine',
  className: 'OrderLine',
  fields: {
    id: { type: 'text' },
    createdAt: { type: 'datetime' },
    orderId: { type: 'foreignKey' },
    description: { type: 'text' },
    quantity: { type: 'decimal' },
    unitPrice: { type: 'integer', ui: { format: 'money' } },
    taxRate: { type: 'decimal' },
    amount: { type: 'integer', ui: { format: 'money' } },
  },
  relationships: [
    {
      field: 'orderId',
      kind: 'foreignKey',
      relatedCollection: 'orders',
      role: 'items',
    },
  ],
};

export const payments: ScreenCollectionDefinition = {
  name: 'payments',
  objectRef: '@acme/shop:Payment',
  className: 'Payment',
  fields: {
    id: { type: 'text' },
    createdAt: { type: 'datetime' },
    reference: { type: 'text' },
    status: { type: 'text', enum: ['pending', 'settled', 'failed'] },
    customerId: { type: 'foreignKey' },
    paidAt: { type: 'datetime' },
    amount: { type: 'integer', ui: { format: 'money' } },
  },
  relationships: [
    { field: 'customerId', kind: 'foreignKey', relatedCollection: 'customers' },
  ],
};

export const shopDefinitions = {
  customers,
  orders,
  order_lines: orderLines,
  payments,
};

export const orderRecord: ScreenRecord = {
  id: 'o-1',
  number: 'GRA-3159',
  status: 'sent',
  customerId: 'c-1',
  issuedAt: '2025-02-07T21:58:00.000Z',
  subtotal: 489000,
  discountAmount: 0,
  taxAmount: 24450,
  totalAmount: 513450,
  currency: 'USD',
  notes: '',
  shippingAddress: {},
  createdAt: '2025-02-07T21:58:00.000Z',
  updatedAt: '2025-02-07T21:58:00.000Z',
};
