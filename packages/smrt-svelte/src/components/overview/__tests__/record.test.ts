import { describe, expect, it } from 'vitest';
import type { ScreenRelation } from '../../screens/relations.js';
import { resolveOverview } from '../model.js';
import { recordOverview, recordOverviewId } from '../record.js';
import { createWidgetRegistry } from '../registry.js';
import { registerCoreWidgets } from '../widgets/core.js';
import { registerRecordWidgets } from '../widgets/record-widgets.js';

const customer = {
  objectRef: '@acme/shop:Customer',
  className: 'Customer',
  fields: { id: { type: 'text' as const } },
};
const relations: ScreenRelation[] = [
  {
    model: '@acme/shop:Order',
    field: 'customerId',
    label: 'Orders',
    kind: 'children',
  },
  {
    model: '@acme/shop:Address',
    field: 'customerId',
    label: 'Addresses',
    kind: 'children',
  },
  {
    model: '@acme/shop:Region',
    field: 'regionId',
    label: 'Region',
    kind: 'reference',
  },
];

describe('recordOverviewId', () => {
  it('folds a qualified model id into an overview id', () => {
    expect(recordOverviewId('@acme/shop:Customer')).toBe(
      'detail:acme.shop.Customer',
    );
    expect(recordOverviewId('shop:Customer')).toBe('detail:shop.Customer');
    expect(recordOverviewId('Customer')).toBe('detail:Customer');
    expect(recordOverviewId('@@/')).toBe('detail:record');
  });
});

describe('recordOverview', () => {
  const withColumns: ScreenRelation[] = [
    {
      ...relations[0],
      columns: [
        { key: 'number', label: 'Number', role: 'identifier' },
        { key: 'totalAmount', label: 'Total', role: 'money' },
      ],
    },
    relations[1],
    relations[2],
  ];
  const lines: ScreenRelation = {
    model: '@acme/shop:OrderLine',
    field: 'orderId',
    label: 'Order lines',
    kind: 'items',
  };

  it('declares a summary strip, then one tabbed related widget', () => {
    const overview = recordOverview(customer, withColumns);
    expect(overview.id).toBe('detail:acme.shop.Customer');
    expect(overview.models).toEqual(['@acme/shop:Order', '@acme/shop:Address']);
    expect(overview.defaults.map((w) => [w.id, w.type, w.span])).toEqual([
      ['count-Order-customerId', 'metric', 1],
      ['sum-Order-customerId', 'metric', 1],
      ['count-Address-customerId', 'metric', 1],
      ['related', 'related', 4],
    ]);
    expect(overview.defaults[0].options).toEqual({
      title: 'Orders',
      model: '@acme/shop:Order',
      measure: 'count',
      field: 'customerId',
      filter: 'parent',
    });
    expect(overview.defaults[1].options).toEqual({
      title: 'Orders · Total',
      model: '@acme/shop:Order',
      measure: 'sum',
      field: 'totalAmount',
      filter: 'parent',
      parentField: 'customerId',
    });
    expect(overview.defaults[3].options).toEqual({ limit: 5 });
  });

  it('puts the line items before related records and caps the strip', () => {
    const overview = recordOverview(customer, [lines, ...withColumns], {
      maxMetrics: 1,
    });
    expect(overview.defaults.map((w) => [w.id, w.type])).toEqual([
      ['count-Order-customerId', 'metric'],
      ['items-OrderLine-orderId', 'line-items'],
      ['related', 'related'],
    ]);
    expect(overview.defaults[1].options).toEqual({
      title: 'Order lines',
      relation: 'OrderLine-orderId',
    });
    expect(overview.models).toContain('@acme/shop:OrderLine');
  });

  it('keeps one records panel per relation with role columns when asked', () => {
    const overview = recordOverview(customer, withColumns, {
      metrics: false,
      related: 'panels',
    });
    expect(overview.defaults.map((w) => [w.id, w.type, w.span])).toEqual([
      ['records-Order-customerId', 'records', 2],
      ['records-Address-customerId', 'records', 2],
    ]);
    expect(overview.defaults[0].options).toEqual({
      title: 'Orders',
      model: '@acme/shop:Order',
      field: 'customerId',
      filter: 'parent',
      sort: 'createdAt',
      direction: 'desc',
      limit: 5,
      columns: 'number,totalAmount',
    });
  });

  it('keys each default by its relation, stable when a host narrows the set', () => {
    const narrowed = recordOverview(customer, [relations[1]], {
      related: 'panels',
    });
    expect(narrowed.defaults.map((w) => w.id)).toEqual([
      'count-Address-customerId',
      'records-Address-customerId',
    ]);
    // Two relations that fold to the same id stay distinct.
    const twin = recordOverview(
      customer,
      [relations[0], { ...relations[0], model: '@other/pkg:Order' }],
      { metrics: false, related: 'panels' },
    );
    expect(twin.defaults.map((w) => w.id)).toEqual([
      'records-Order-customerId',
      'records-Order-customerId-2',
    ]);
  });

  it('takes an explicit id and is empty without children', () => {
    const overview = recordOverview(customer, [relations[2]], {
      id: 'customers.detail',
    });
    expect(overview.id).toBe('customers.detail');
    expect(overview.defaults).toEqual([]);
    expect(overview.models).toBeUndefined();
  });

  it('validates against the core and record widgets', () => {
    const registry = createWidgetRegistry();
    registerCoreWidgets(registry, {
      metric: () => ({ value: 0 }),
      records: () => ({ rows: [] }),
    });
    registerRecordWidgets(registry, {
      relations: [lines, ...withColumns],
      records: () => ({ rows: [] }),
    });
    const overview = recordOverview(customer, [lines, ...withColumns]);
    const resolved = resolveOverview(overview, null, registry);
    expect(resolved.issues).toEqual([]);
    expect(resolved.document.widgets).toHaveLength(5);
    const panels = recordOverview(customer, withColumns, { related: 'panels' });
    expect(resolveOverview(panels, null, registry).issues).toEqual([]);
  });
});
