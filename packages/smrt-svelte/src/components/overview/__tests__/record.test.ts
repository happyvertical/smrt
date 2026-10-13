import { describe, expect, it } from 'vitest';
import type { ScreenRelation } from '../../screens/relations.js';
import { resolveOverview } from '../model.js';
import { recordOverview, recordOverviewId } from '../record.js';
import { createWidgetRegistry } from '../registry.js';
import { registerCoreWidgets } from '../widgets/core.js';

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
  it('declares one records panel per children relation', () => {
    const overview = recordOverview(customer, relations);
    expect(overview.id).toBe('detail:acme.shop.Customer');
    expect(overview.models).toEqual(['@acme/shop:Order', '@acme/shop:Address']);
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
    });
  });

  it('pairs a count metric with each panel when asked', () => {
    const overview = recordOverview(customer, relations, { metrics: true });
    expect(overview.defaults.map((w) => [w.id, w.type, w.span])).toEqual([
      ['count-Order-customerId', 'metric', 1],
      ['records-Order-customerId', 'records', 3],
      ['count-Address-customerId', 'metric', 1],
      ['records-Address-customerId', 'records', 3],
    ]);
    expect(overview.defaults[1].options).toEqual({
      title: 'Orders',
      model: '@acme/shop:Order',
      field: 'customerId',
      filter: 'parent',
      sort: 'createdAt',
      direction: 'desc',
      limit: 5,
    });
    expect(overview.defaults[0].options).toMatchObject({
      measure: 'count',
      field: 'customerId',
      filter: 'parent',
    });
  });

  it('keys each default by its relation, stable when a host narrows the set', () => {
    const narrowed = recordOverview(customer, [relations[1]]);
    expect(narrowed.defaults.map((w) => w.id)).toEqual([
      'records-Address-customerId',
    ]);
    // Two relations that fold to the same id stay distinct.
    const twin = recordOverview(customer, [
      relations[0],
      { ...relations[0], model: '@other/pkg:Order' },
    ]);
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

  it('validates against the core records and metric widgets', () => {
    const registry = createWidgetRegistry();
    registerCoreWidgets(registry, {
      metric: () => ({ value: 0 }),
      records: () => ({ rows: [] }),
    });
    const overview = recordOverview(customer, relations, { metrics: true });
    const resolved = resolveOverview(overview, null, registry);
    expect(resolved.issues).toEqual([]);
    expect(resolved.document.widgets).toHaveLength(4);
  });
});
