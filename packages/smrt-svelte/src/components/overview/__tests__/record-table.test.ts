import { describe, expect, it } from 'vitest';
import {
  customers,
  orderLines,
  orders,
  payments,
} from '../../screens/__tests__/shop-fixtures.js';
import { deriveFieldRoles } from '../../screens/roles.js';
import {
  formatColumnsOption,
  formatRecordCell,
  lineItemColumns,
  parseColumnsOption,
  readRecordRows,
  relatedColumns,
  resolveRecordColumns,
  statusLabel,
  statusTone,
} from '../widgets/record-table.js';

describe('columns option', () => {
  it('parses a comma list of identifiers, dropping junk and repeats', () => {
    expect(
      parseColumnsOption(' number, status ,,9bad,status,issuedAt '),
    ).toEqual(['number', 'status', 'issuedAt']);
    expect(parseColumnsOption(undefined)).toEqual([]);
    expect(parseColumnsOption('a,b,c,d,e,f,g')).toHaveLength(6);
    expect(formatColumnsOption(['number', 'status'])).toBe('number,status');
  });
});

describe('relatedColumns', () => {
  it('picks identifier, status, lead date and amount for a document', () => {
    expect(
      relatedColumns(orders, deriveFieldRoles(orders), {
        exclude: ['customerId'],
      }),
    ).toEqual([
      { key: 'number', label: 'Number', role: 'identifier' },
      { key: 'status', label: 'Status', role: 'status' },
      { key: 'issuedAt', label: 'Issued at', role: 'date' },
      { key: 'totalAmount', label: 'Total amount', role: 'money' },
    ]);
  });

  it('keeps a party column when it is not the parent link', () => {
    expect(
      relatedColumns(orders, deriveFieldRoles(orders)).map((c) => c.key),
    ).toEqual(['number', 'status', 'issuedAt', 'customerId']);
    expect(
      relatedColumns(payments, deriveFieldRoles(payments), {
        exclude: ['customerId'],
      }).map((c) => c.key),
    ).toEqual(['reference', 'status', 'paidAt', 'amount']);
  });

  it('falls back to the title when there is no identifier', () => {
    expect(
      relatedColumns(customers, deriveFieldRoles(customers)).map((c) => c.key),
    ).toEqual(['name', 'status', 'createdAt']);
  });
});

describe('lineItemColumns', () => {
  it('reads item, quantity, unit price and amount', () => {
    expect(
      lineItemColumns(orderLines, deriveFieldRoles(orderLines), {
        exclude: ['orderId'],
      }),
    ).toEqual([
      { key: 'description', label: 'Description' },
      { key: 'quantity', label: 'Quantity', role: 'quantity' },
      { key: 'unitPrice', label: 'Unit price', role: 'money' },
      { key: 'amount', label: 'Amount', role: 'money' },
    ]);
  });
});

describe('cells and status', () => {
  it('formats cells by role, dates in UTC unless told otherwise', () => {
    const ctx = { currency: 'USD', locale: 'en-US' };
    expect(formatRecordCell({ role: 'money' }, 489000, ctx)).toBe('$4,890.00');
    expect(
      formatRecordCell({ role: 'date' }, '2025-02-07T23:30:00.000Z', ctx),
    ).toBe('Feb 7, 2025');
    expect(
      formatRecordCell({ role: 'date' }, '2025-02-07T23:30:00.000Z', {
        ...ctx,
        timeZone: 'Asia/Tokyo',
      }),
    ).toBe('Feb 8, 2025');
    expect(formatRecordCell({ role: 'date' }, '7 Feb', ctx)).toBe('7 Feb');
    expect(formatRecordCell({ role: 'quantity' }, 1.5, ctx)).toBe('1.5');
    expect(formatRecordCell({ role: 'status' }, 'written_off', ctx)).toBe(
      'Written off',
    );
    expect(formatRecordCell({}, null, ctx)).toBe('');
    expect(formatRecordCell({}, 'Ridgeline', ctx)).toBe('Ridgeline');
    expect(statusLabel('')).toBe('');
  });

  it('tones status values from a mapping, the defaults, else neutral', () => {
    expect(statusTone('paid')).toBe('success');
    expect(statusTone('Written off')).toBe('default');
    expect(statusTone('overdue')).toBe('warning');
    expect(statusTone('quoted')).toBe('default');
    expect(statusTone('quoted', { quoted: 'info' })).toBe('info');
    expect(statusTone(3)).toBe('default');
  });
});

describe('untrusted data', () => {
  it('reads rows with cells and resolves column labels and roles', () => {
    expect(
      readRecordRows({
        rows: [null, { cells: { a: 1 } }, { id: 'x', title: 'X', cells: 'no' }],
      }),
    ).toEqual([
      { id: '0', title: '', cells: { a: 1 } },
      { id: 'x', title: 'X' },
    ]);
    expect(
      resolveRecordColumns(
        ['amount', 'note'],
        [
          { key: 'amount', label: 'Amount', role: 'money' },
          { key: 'bad key' },
          { key: 'x', role: 'nope' },
        ],
      ),
    ).toEqual([
      { key: 'amount', label: 'Amount', role: 'money' },
      { key: 'note', label: 'Note' },
    ]);
    expect(resolveRecordColumns([], [{ key: 'x', role: 'nope' }])).toEqual([
      { key: 'x', label: 'X' },
    ]);
  });
});
