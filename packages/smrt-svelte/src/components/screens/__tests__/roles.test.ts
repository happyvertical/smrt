import { describe, expect, it } from 'vitest';
import { deriveScreenFields, inputKindFor } from '../fields.js';
import {
  currencyCodeField,
  deriveFieldRoles,
  fieldsWithRole,
  fieldWithRole,
  hasLineItemRoles,
  isDocumentLike,
} from '../roles.js';
import type { ScreenCollectionDefinition } from '../types.js';
import { taskDefinition } from './fixtures.js';
import { customers, orderLines, orders, payments } from './shop-fixtures.js';

describe('deriveFieldRoles', () => {
  it('reads a document: identifier, status, party, date and the totals roles', () => {
    const roles = deriveFieldRoles(orders);
    expect(roles.number).toEqual(['identifier']);
    expect(roles.status).toEqual(['status']);
    expect(roles.customerId).toEqual(['party']);
    expect(roles.issuedAt).toEqual(['date']);
    expect(roles.createdAt).toEqual(['date']);
    expect(roles.subtotal).toEqual(['money', 'subtotal']);
    expect(roles.discountAmount).toEqual(['money', 'discount']);
    expect(roles.taxAmount).toEqual(['money', 'tax']);
    expect(roles.totalAmount).toEqual(['money', 'total']);
    // The currency CODE picker is not money.
    expect(roles.currency).toEqual([]);
    expect(roles.notes).toEqual([]);
  });

  it('reads line items: quantity and money, never a rate', () => {
    const roles = deriveFieldRoles(orderLines);
    expect(roles.quantity).toEqual(['quantity']);
    expect(roles.unitPrice).toEqual(['money']);
    expect(roles.amount).toEqual(['money']);
    expect(roles.taxRate).toEqual([]);
    expect(roles.orderId).toEqual([]);
    expect(hasLineItemRoles(roles)).toBe(true);
    expect(hasLineItemRoles(deriveFieldRoles(payments))).toBe(false);
  });

  it('gives the title to a display field, else the first name-like text field', () => {
    expect(fieldWithRole(deriveFieldRoles(customers), 'title')).toBe('name');
    const declared: ScreenCollectionDefinition = {
      ...customers,
      fields: { ...customers.fields, email: { type: 'text', display: true } },
    };
    expect(fieldsWithRole(deriveFieldRoles(declared), 'title')).toEqual([
      'email',
    ]);
    expect(fieldWithRole(deriveFieldRoles(orders), 'title')).toBeUndefined();
  });

  it('needs an enum for status and skips phone numbers as identifiers', () => {
    const roles = deriveFieldRoles({
      objectRef: 'x:Y',
      className: 'Y',
      fields: {
        status: { type: 'text' },
        phoneNumber: { type: 'text' },
        postalCode: { type: 'text' },
        orderNumber: { type: 'text' },
      },
    });
    expect(roles.status).toEqual([]);
    expect(roles.phoneNumber).toEqual([]);
    expect(roles.postalCode).toEqual([]);
    expect(roles.orderNumber).toEqual(['identifier']);
  });

  it('applies name heuristics to money only on integers', () => {
    const roles = deriveFieldRoles({
      objectRef: 'x:Y',
      className: 'Y',
      fields: {
        price: { type: 'decimal' },
        cost: { type: 'integer' },
        lineTotal: { type: 'integer' },
        creditLimit: { type: 'integer' },
        budget: { type: 'integer', ui: { widget: 'currency' } },
        rate: { type: 'decimal', format: 'percent' },
      },
    });
    expect(roles.price).toEqual([]);
    expect(roles.cost).toEqual(['money']);
    expect(roles.lineTotal).toEqual(['money']);
    expect(roles.creditLimit).toEqual([]);
    expect(roles.budget).toEqual(['money']);
    expect(roles.rate).toEqual([]);
  });

  it('treats an explicit role as authoritative but still adds format roles', () => {
    const roles = deriveFieldRoles({
      objectRef: 'x:Y',
      className: 'Y',
      fields: {
        totalAmount: { type: 'integer', role: 'quantity' },
        fee: { type: 'integer', role: ['total'], format: 'money' },
        due: { type: 'datetime', format: 'date' },
        bogus: { type: 'text', role: ['nope' as never] },
      },
    });
    expect(roles.totalAmount).toEqual(['quantity']);
    expect(roles.fee).toEqual(['money', 'total']);
    expect(roles.due).toEqual(['date']);
    expect(roles.bogus).toEqual([]);
  });

  it('finds a party through the relationship target as well as the name', () => {
    const roles = deriveFieldRoles({
      objectRef: 'x:Y',
      className: 'Y',
      fields: {
        billToId: { type: 'foreignKey' },
        tenantId: { type: 'crossPackageRef' },
      },
      relationships: [
        {
          field: 'billToId',
          kind: 'foreignKey',
          relatedCollection: 'customers',
        },
      ],
    });
    expect(roles.billToId).toEqual(['party']);
    expect(roles.tenantId).toEqual([]);
  });

  it('classifies documents and finds the currency code field', () => {
    expect(isDocumentLike(deriveFieldRoles(orders))).toBe(true);
    expect(isDocumentLike(deriveFieldRoles(customers))).toBe(false);
    expect(currencyCodeField(orders)).toBe('currency');
    expect(currencyCodeField(customers)).toBeUndefined();
    expect(
      currencyCodeField({
        objectRef: 'x:Y',
        className: 'Y',
        fields: { currencyCode: { type: 'text' } },
      }),
    ).toBe('currencyCode');
  });
});

describe('deriveScreenFields with roles', () => {
  it('makes an enum a select and money from roles', () => {
    const fields = deriveScreenFields(orders, null, { mode: 'edit' });
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.status.kind).toBe('select');
    expect(byName.status.options).toEqual([
      'draft',
      'sent',
      'paid',
      'cancelled',
    ]);
    expect(byName.totalAmount.kind).toBe('money');
    expect(byName.totalAmount.roles).toEqual(['money', 'total']);
    expect(byName.currency.kind).toBe('text');
    expect(byName.number.options).toBeUndefined();
  });

  it('keeps the legacy currency widget and roles-free inputKindFor', () => {
    expect(inputKindFor({ type: 'integer', ui: { format: 'money' } })).toBe(
      'money',
    );
    expect(inputKindFor({ type: 'integer' }, ['money'])).toBe('money');
    expect(
      inputKindFor({ type: 'integer', ui: { widget: 'currency' } }, []),
    ).toBe('integer');
    expect(inputKindFor({ type: 'text', enum: ['a'] })).toBe('select');
    expect(inputKindFor({ type: 'text', enum: [] })).toBe('text');
    const task = deriveScreenFields(taskDefinition, null, { mode: 'view' });
    expect(task.find((f) => f.name === 'budget')?.kind).toBe('money');
  });
});
