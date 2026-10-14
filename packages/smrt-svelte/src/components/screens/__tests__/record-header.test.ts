import { describe, expect, it } from 'vitest';
import { deriveScreenFields } from '../fields.js';
import {
  deriveRecordHeader,
  recordTotals,
  totalsFields,
} from '../record-header.js';
import { deriveFieldRoles } from '../roles.js';
import type { ScreenPolicy } from '../types.js';
import { customers, orderRecord, orders } from './shop-fixtures.js';

const view = (definition: typeof orders, policy?: ScreenPolicy) =>
  deriveScreenFields(definition, policy ?? null, { mode: 'view' });

describe('deriveRecordHeader', () => {
  it('leads a document with its kind and identifier, then status and facts', () => {
    const header = deriveRecordHeader(
      orders,
      view(orders),
      orderRecord,
      deriveFieldRoles(orders),
    );
    expect(header.heading).toBe('Order GRA-3159');
    expect(header.headingIdentifier).toBe(true);
    expect(header.identifier?.value).toBe('GRA-3159');
    expect(header.status?.value).toBe('sent');
    expect(header.facts.map((f) => [f.kind, f.field.name])).toEqual([
      ['party', 'customerId'],
      ['date', 'issuedAt'],
      ['money', 'totalAmount'],
    ]);
    expect(header.shown).toEqual([
      'number',
      'status',
      'customerId',
      'issuedAt',
      'totalAmount',
    ]);
  });

  it('titles a non-document by its title field and adds contacts', () => {
    const record = {
      id: 'c-1',
      name: 'Ridgeline Construction',
      email: 'ops@ridgeline.test',
      status: 'active',
      phoneNumber: '',
    };
    const header = deriveRecordHeader(
      customers,
      view(customers),
      record,
      deriveFieldRoles(customers),
    );
    expect(header.heading).toBe('Ridgeline Construction');
    expect(header.headingIdentifier).toBe(false);
    expect(header.facts.map((f) => f.field.name)).toEqual(['email']);
    expect(header.shown).toEqual(['name', 'status', 'email']);
  });

  it('honours an explicit title, skips empty values and never reads fields the policy omits', () => {
    const policy: ScreenPolicy = {
      objectRef: orders.objectRef,
      fields: {
        number: { visibility: 'basic' },
        status: { visibility: 'basic' },
      },
    };
    const header = deriveRecordHeader(
      orders,
      view(orders, policy),
      { ...orderRecord, status: '' },
      deriveFieldRoles(orders),
      { title: 'Custom' },
    );
    expect(header.heading).toBe('Custom');
    expect(header.status).toBeUndefined();
    expect(header.facts).toEqual([]);
    expect(
      deriveRecordHeader(orders, [], {}, deriveFieldRoles(orders)).heading,
    ).toBe('Order');
  });
});

describe('record totals', () => {
  it('reads the totals roles and lists their fields', () => {
    const roles = deriveFieldRoles(orders);
    expect(recordTotals(orderRecord, roles)).toEqual({
      subtotal: 489000,
      discount: 0,
      tax: 24450,
      total: 513450,
    });
    expect(recordTotals({ subtotal: '12' }, roles).subtotal).toBeNull();
    // A totals field the policy omits is never read.
    const policy: ScreenPolicy = {
      objectRef: orders.objectRef,
      fields: { number: { visibility: 'basic' } },
    };
    expect(recordTotals(orderRecord, roles, view(orders, policy))).toEqual({});
    expect(totalsFields(roles)).toEqual([
      'subtotal',
      'discountAmount',
      'taxAmount',
      'totalAmount',
    ]);
  });
});
