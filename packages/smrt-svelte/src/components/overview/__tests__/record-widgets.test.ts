import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { shopDefinitions } from '../../screens/__tests__/shop-fixtures.js';
import { deriveScreenRelations } from '../../screens/relations.js';
import { createWidgetRegistry } from '../registry.js';
import type { OverviewOptions, WidgetLoadContext } from '../types.js';
import RelatedWidget from '../widgets/RelatedWidget.svelte';
import {
  createRelatedLoader,
  relatedRelations,
  relatedTabOptions,
} from '../widgets/record-loaders.js';
import { registerRecordWidgets } from '../widgets/record-widgets.js';

const relations = deriveScreenRelations(shopDefinitions, '@acme/shop:Customer');
const ctx: WidgetLoadContext = {
  overviewId: 'detail:acme.shop.Customer',
  signal: new AbortController().signal,
  locale: 'en-US',
  record: { model: '@acme/shop:Customer', id: 'c-1' },
};

describe('related loader (one records load per tab)', () => {
  it('loads each children relation through the records loader with the parent filter', async () => {
    const records = vi.fn((options: OverviewOptions) => {
      if (options.model === '@acme/shop:Order') {
        return {
          rows: [
            {
              id: 'o1',
              title: 'GRA-3159',
              cells: {
                number: 'GRA-3159',
                status: 'paid',
                totalAmount: 489000,
              },
            },
          ],
          total: 6,
          summaries: { totalAmount: 1200000 },
          href: '/orders?customer=c-1',
        };
      }
      return { rows: [] };
    });
    const load = createRelatedLoader({
      relations,
      records,
      viewAllHref: (r) =>
        r.model.endsWith('Payment') ? '/payments' : undefined,
    });
    const data = await load({ limit: 3 }, ctx);
    expect(records).toHaveBeenCalledWith(
      {
        title: 'Orders',
        model: '@acme/shop:Order',
        field: 'customerId',
        filter: 'parent',
        sort: 'createdAt',
        direction: 'desc',
        limit: 3,
        columns: 'number,status,issuedAt,totalAmount',
      },
      ctx,
    );
    expect(data.tabs.map((t) => [t.key, t.total, t.href])).toEqual([
      ['Order-customerId', 6, '/orders?customer=c-1'],
      ['Payment-customerId', 0, '/payments'],
    ]);
    expect(data.tabs[0]?.summaries).toEqual({ totalAmount: 1200000 });
    expect(data.tabs[0]?.columns[3]).toEqual({
      key: 'totalAmount',
      label: 'Total amount',
      role: 'money',
    });
  });

  it('lists the named relations only, drops a failed tab, and fails only when all do', async () => {
    expect(
      relatedRelations(relations, ['Payment-customerId']).map((r) => r.label),
    ).toEqual(['Payments']);
    expect(relatedTabOptions(relations[0] as never, 5).filter).toBe('parent');
    const partly = createRelatedLoader({
      relations,
      records: (options) => {
        if (options.model === '@acme/shop:Order') throw new Error('boom');
        return { rows: [{ id: 'p', title: 'P' }] };
      },
    });
    expect((await partly({}, ctx)).tabs.map((t) => t.key)).toEqual([
      'Payment-customerId',
    ]);
    const broken = createRelatedLoader({
      relations,
      records: () => Promise.reject(new Error('down')),
    });
    await expect(broken({}, ctx)).rejects.toThrow('down');
  });

  it('registers the related widget', () => {
    const registry = createWidgetRegistry();
    const dispose = registerRecordWidgets(registry, {
      relations,
      records: () => ({ rows: [] }),
    });
    expect(registry.get('related')?.defaultSpan).toBe(4);
    dispose();
    expect(registry.get('related')).toBeUndefined();
  });
});

const base = {
  id: 'w1',
  options: {},
  span: 4,
  title: 'Related records',
  locale: 'en-US',
};

describe('RelatedWidget', () => {
  const data = {
    tabs: [
      {
        key: 'Order-customerId',
        label: 'Orders',
        total: 2,
        columns: [
          { key: 'number', label: 'Number', role: 'identifier' },
          { key: 'totalAmount', label: 'Total', role: 'money' },
        ],
        rows: [
          {
            id: 'o1',
            title: 'A',
            href: '/o/1',
            cells: { number: 'GRA-1', totalAmount: 1000 },
          },
          {
            id: 'o2',
            title: 'B',
            cells: { number: 'GRA-2', totalAmount: 2500 },
          },
        ],
        href: '/orders',
      },
      {
        key: 'Estimate-customerId',
        label: 'Estimates',
        total: 0,
        columns: [],
        rows: [],
      },
      {
        key: 'Payment-customerId',
        label: 'Payments',
        total: 1,
        columns: [{ key: 'amount', label: 'Amount', role: 'money' }],
        rows: [{ id: 'p1', title: 'P', cells: { amount: 7130 } }],
      },
    ],
  };

  it('shows a tab per non-empty relation with its count, a totals footer and one View all', async () => {
    const { container } = render(RelatedWidget, { props: { ...base, data } });
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent?.replace(/\s+/g, ' ').trim())).toEqual(
      ['Orders 2', 'Payments 1'],
    );
    expect(container.querySelector('tfoot')).toHaveTextContent('$35.00');
    expect(container.querySelector('tfoot')).toHaveTextContent('2 in total');
    expect(screen.getAllByRole('link', { name: 'View all' })).toHaveLength(1);
    await expectNoA11yViolations(container);
    await userEvent.click(screen.getByRole('tab', { name: /Payments/ }));
    expect(container.querySelector('tfoot')).toHaveTextContent('$71.30');
    expect(screen.queryByRole('link', { name: 'View all' })).toBeNull();
  });

  it('says so once when every relation is empty', () => {
    render(RelatedWidget, {
      props: { ...base, data: { tabs: [data.tabs[1]] } },
    });
    expect(screen.getByText('No related records yet.')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});
