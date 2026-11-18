import { describe, expect, it } from 'vitest';
import {
  arrangeTabs,
  countLabel,
  filteredHref,
  matchLink,
  parseLinkParam,
  prefilledNewHref,
  relatedColumns,
  reverseRelations,
} from './related.ts';
import type { ModelInfo } from './types.ts';

const models = {
  Client: { label: 'Client', fields: { name: { type: 'text' } } },
  Invoice: {
    label: 'Invoice',
    fields: {
      number: { type: 'text' },
      client: { type: 'reference', ref: 'Client' },
      billedTo: { type: 'reference', ref: 'Client', label: 'Billed to' },
      total: { type: 'money' },
      notes: { type: 'json' },
      secret: { type: 'reference', ref: 'Client', hidden: true },
    },
  },
  Walk: {
    label: 'Walk',
    fields: {
      day: { type: 'date' },
      client: { type: 'reference', ref: 'Client' },
    },
  },
  Dog: {
    label: 'Dog',
    fields: { owner: { type: 'reference', ref: 'Person' } },
  },
} as unknown as Record<string, ModelInfo>;

describe('reverseRelations', () => {
  const rels = reverseRelations(models, 'Client');
  it('finds link fields back to the model, skipping hidden and other targets', () => {
    expect(rels.map((r) => r.key)).toEqual([
      'Invoice.client',
      'Invoice.billedTo',
      'Walk.client',
    ]);
  });
  it('names tabs by model, adding the field only to disambiguate', () => {
    expect(rels.map((r) => r.tabLabel)).toEqual([
      'Invoice (Client)',
      'Invoice (Billed to)',
      'Walk',
    ]);
  });
  it('is empty when nothing points at the model', () => {
    expect(reverseRelations(models, 'Walk')).toEqual([]);
  });
});

describe('arrangeTabs', () => {
  it('orders by count, caps tabs and moves empty and overflow under More', () => {
    const out = arrangeTabs([
      { key: 'a', count: 1 },
      { key: 'b', count: 9 },
      { key: 'c', count: 0 },
      { key: 'd', count: 4 },
      { key: 'e', count: 4 },
      { key: 'f', count: 2 },
    ]);
    expect(out.tabs).toEqual(['b', 'd', 'e', 'f']);
    expect(out.more).toEqual(['a', 'c']);
  });
  it('has no tabs when every relation is empty', () => {
    expect(arrangeTabs([{ key: 'a', count: 0 }])).toEqual({
      tabs: [],
      more: ['a'],
    });
  });
});

describe('relatedColumns', () => {
  it('drops the back link, hidden and json fields, and caps', () => {
    expect(
      relatedColumns(models.Invoice, 'client', 3).map((c) => c.name),
    ).toEqual(['number', 'billedTo', 'total']);
  });
});

describe('relatedColumns choice', () => {
  const order = {
    fields: {
      number: { type: 'text' as const },
      customer: { type: 'reference' as const, ref: 'Customer' },
      note: { type: 'text' as const },
      placed: { type: 'date' as const },
      total: { type: 'money' as const },
      status: { type: 'choice' as const, choices: ['open', 'paid'] },
    },
  };

  it('keeps Total and Status and never the link back', () => {
    const names = relatedColumns(order, 'customer').map((c) => c.name);
    expect(names).toEqual(['number', 'placed', 'total', 'status']);
    expect(names).not.toContain('customer');
  });

  it('leads with the name column even when it is declared later', () => {
    const cols = relatedColumns(
      {
        fields: {
          day: { type: 'date' },
          client: { type: 'reference', ref: 'Client' },
          title: { type: 'text' },
        },
      },
      'client',
    ).map((c) => c.name);
    expect(cols).toEqual(['title', 'day']);
  });
});

describe('link params', () => {
  it('parses only link fields with plain ids', () => {
    expect(parseLinkParam('client:abc-1', models.Invoice)).toEqual({
      field: 'client',
      id: 'abc-1',
      ref: 'Client',
    });
    expect(parseLinkParam('number:abc', models.Invoice)).toBeNull();
    expect(parseLinkParam('secret:abc', models.Invoice)).toBeNull();
    expect(parseLinkParam('client:a b', models.Invoice)).toBeNull();
    expect(parseLinkParam('constructor:a', models.Invoice)).toBeNull();
    expect(parseLinkParam(null, models.Invoice)).toBeNull();
  });
  it('builds filtered and prefilled links', () => {
    expect(filteredHref('Invoice', 'client', 'c1')).toBe(
      '/m/Invoice?where=client%3Ac1',
    );
    expect(prefilledNewHref('Invoice', 'client', 'c1')).toBe(
      '/m/Invoice/new?with=client%3Ac1',
    );
  });
});

describe('matchLink', () => {
  it('returns the first rows and the full count', () => {
    const rows = [
      { id: '1', client: 'c1' },
      { id: '2', client: 'c2' },
      { id: '3', client: 'c1' },
      { id: '4', client: 'c1' },
    ];
    const out = matchLink(rows, 'client', 'c1', 2);
    expect(out.total).toBe(3);
    expect(out.records.map((r) => r.id)).toEqual(['1', '3']);
  });
});

describe('countLabel', () => {
  it('marks a count from a partial scan as a lower bound', () => {
    expect(countLabel(3, false)).toBe('3');
    expect(countLabel(0, true)).toBe('0+');
    expect(countLabel(12, true)).toBe('12+');
  });
});
