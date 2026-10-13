import { describe, expect, it } from 'vitest';
import { deriveScreenRelations } from '../relations.js';
import type { ScreenCollectionDefinition } from '../types.js';

const customers: ScreenCollectionDefinition = {
  name: 'customers',
  objectRef: '@acme/shop:Customer',
  className: 'Customer',
  fields: { id: { type: 'text' }, name: { type: 'text' } },
  relationships: [],
};
const orders: ScreenCollectionDefinition = {
  name: 'orders',
  objectRef: '@acme/shop:Order',
  className: 'Order',
  fields: {
    id: { type: 'text' },
    customerId: { type: 'foreignKey' },
    approverId: { type: 'foreignKey' },
    tagId: { type: 'crossPackageRef' },
  },
  relationships: [
    { field: 'customerId', kind: 'foreignKey', relatedCollection: 'customers' },
    { field: 'approverId', kind: 'foreignKey', relatedCollection: 'customers' },
    { field: 'tagId', kind: 'crossPackageRef', relatedCollection: 'tags' },
    { field: 'lines', kind: 'oneToMany', relatedCollection: 'order_lines' },
  ],
};
const addresses: ScreenCollectionDefinition = {
  name: 'addresses',
  objectRef: '@acme/shop:Address',
  className: 'Address',
  fields: { id: { type: 'text' }, customerId: { type: 'foreignKey' } },
  relationships: [
    { field: 'customerId', kind: 'foreignKey', relatedCollection: 'customers' },
  ],
};
const definitions = { customers, orders, addresses };

describe('deriveScreenRelations', () => {
  it('lists children (sorted, disambiguated per FK) before references', () => {
    expect(deriveScreenRelations(definitions, '@acme/shop:Customer')).toEqual([
      {
        model: '@acme/shop:Address',
        field: 'customerId',
        label: 'Addresses',
        kind: 'children',
      },
      {
        model: '@acme/shop:Order',
        field: 'approverId',
        label: 'Orders (Approver)',
        kind: 'children',
      },
      {
        model: '@acme/shop:Order',
        field: 'customerId',
        label: 'Orders (Customer)',
        kind: 'children',
      },
    ]);
  });

  it('skips unknown targets and non-FK edges, and accepts a collection key as the model', () => {
    expect(deriveScreenRelations(definitions, 'orders')).toEqual([
      {
        model: '@acme/shop:Customer',
        field: 'customerId',
        label: 'Customer',
        kind: 'reference',
      },
      {
        model: '@acme/shop:Customer',
        field: 'approverId',
        label: 'Approver',
        kind: 'reference',
      },
    ]);
  });

  it('resolves a related collection by name when the map key differs', () => {
    const keyed = { c: customers, o: orders };
    expect(
      deriveScreenRelations(keyed, '@acme/shop:Customer').map((r) => r.label),
    ).toEqual(['Orders (Approver)', 'Orders (Customer)']);
  });

  it('returns nothing for an unknown model or definitions without edges', () => {
    expect(deriveScreenRelations(definitions, '@acme/shop:Nope')).toEqual([]);
    expect(
      deriveScreenRelations(
        { customers: { ...customers, relationships: undefined } },
        '@acme/shop:Customer',
      ),
    ).toEqual([]);
  });
});
