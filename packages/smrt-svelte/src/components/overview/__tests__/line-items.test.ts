import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { shopDefinitions } from '../../screens/__tests__/shop-fixtures.js';
import { deriveScreenRelations } from '../../screens/relations.js';
import type { OverviewOptions, WidgetLoadContext } from '../types.js';
import LineItemsWidget from '../widgets/LineItemsWidget.svelte';
import { lineItemTotals, sumLineAmounts } from '../widgets/line-totals.js';
import {
  createLineItemsLoader,
  lineItemsRelation,
} from '../widgets/record-loaders.js';

describe('lineItemTotals', () => {
  it('shows the record figures as they are when they agree with the lines', () => {
    expect(
      lineItemTotals(
        { subtotal: 489000, discount: 0, tax: 24450, total: 513450 },
        489000,
      ),
    ).toEqual({
      lines: [
        { key: 'subtotal', value: 489000, computed: false },
        { key: 'tax', value: 24450, computed: false },
        { key: 'total', value: 513450, computed: false },
      ],
      lineSum: 489000,
      mismatch: null,
    });
  });

  it('computes what the record lacks: subtotal from the lines, total = subtotal - discount + tax', () => {
    expect(lineItemTotals({ discount: 1000, tax: 500 }, 10000).lines).toEqual([
      { key: 'subtotal', value: 10000, computed: true },
      { key: 'discount', value: 1000, computed: false },
      { key: 'tax', value: 500, computed: false },
      { key: 'total', value: 9500, computed: true },
    ]);
    expect(lineItemTotals(undefined, null).lines).toEqual([]);
  });

  it('flags a disagreement instead of overriding the record', () => {
    const result = lineItemTotals({ subtotal: 489000, total: 489000 }, 490000);
    expect(result.lines[0]).toEqual({
      key: 'subtotal',
      value: 489000,
      computed: false,
    });
    expect(result.mismatch).toEqual({
      field: 'subtotal',
      recorded: 489000,
      lines: 490000,
    });
    expect(lineItemTotals({ total: 5000, tax: 100 }, 4000).mismatch).toEqual({
      field: 'total',
      recorded: 5000,
      lines: 4100,
    });
    // A partial page of lines is never compared.
    expect(lineItemTotals({ subtotal: 1 }, null).mismatch).toBeNull();
  });

  it('sums minor units exactly and refuses non-integers', () => {
    expect(sumLineAmounts([100, null, '', 250])).toBe(350);
    expect(sumLineAmounts([1.5])).toBeNull();
    expect(sumLineAmounts([Number.MAX_SAFE_INTEGER, 1])).toBeNull();
  });
});

const ctx: WidgetLoadContext = {
  overviewId: 'detail:acme.shop.Order',
  signal: new AbortController().signal,
  locale: 'en-US',
  record: { model: '@acme/shop:Order', id: 'o-1' },
};

describe('line-items loader', () => {
  const relations = deriveScreenRelations(shopDefinitions, '@acme/shop:Order');

  it('classifies the items relation and loads it in line order with the parent totals', async () => {
    expect(relations[0]).toMatchObject({
      kind: 'items',
      model: '@acme/shop:OrderLine',
      field: 'orderId',
      sort: 'createdAt',
    });
    expect(lineItemsRelation(relations, 'OrderLine-orderId')?.kind).toBe(
      'items',
    );
    expect(lineItemsRelation(relations, 'Nope-x')).toBeUndefined();
    const records = vi.fn((_options: OverviewOptions) => ({
      rows: [
        {
          id: 'l1',
          title: 'Labour',
          cells: { description: 'Labour', amount: 54000 },
        },
      ],
    }));
    const load = createLineItemsLoader({
      relations,
      records,
      totals: () => ({ subtotal: 54000, total: 54000 }),
      currency: () => 'CAD',
    });
    const data = await load({}, ctx);
    expect(records.mock.calls[0]?.[0]).toEqual({
      title: 'Order lines',
      model: '@acme/shop:OrderLine',
      field: 'orderId',
      filter: 'parent',
      sort: 'createdAt',
      direction: 'asc',
      limit: 50,
      columns: 'description,quantity,unitPrice,amount',
    });
    expect(data).toMatchObject({
      total: 1,
      totals: { subtotal: 54000, total: 54000 },
      currency: 'CAD',
    });
    expect(data.columns.find((c) => c.key === 'unitPrice')?.summarize).toBe(
      false,
    );
  });

  it('is empty without an items relation', async () => {
    const load = createLineItemsLoader({
      relations: [],
      records: () => ({ rows: [] }),
    });
    expect(await load({}, ctx)).toEqual({ rows: [], columns: [] });
  });

  it('a child with quantity and money is items even without the edge role', () => {
    const { order_lines, ...rest } = shopDefinitions;
    const unmarked = {
      ...rest,
      order_lines: {
        ...order_lines,
        relationships: [
          {
            field: 'orderId',
            kind: 'foreignKey' as const,
            relatedCollection: 'orders',
          },
        ],
      },
    };
    expect(deriveScreenRelations(unmarked, '@acme/shop:Order')[0]?.kind).toBe(
      'items',
    );
  });
});

const columns = [
  { key: 'description', label: 'Item' },
  { key: 'quantity', label: 'Qty', role: 'quantity' },
  { key: 'unitPrice', label: 'Unit price', role: 'money', summarize: false },
  { key: 'amount', label: 'Amount', role: 'money' },
];
const rows = [
  {
    id: 'l1',
    title: 'Labour',
    cells: {
      description: 'Labour',
      quantity: 2,
      unitPrice: 27000,
      amount: 54000,
    },
  },
  {
    id: 'l2',
    title: 'Shingles',
    cells: {
      description: 'Shingles',
      quantity: 1.5,
      unitPrice: 10000,
      amount: 15000,
    },
  },
];
const base = {
  id: 'w1',
  options: {},
  span: 4,
  title: 'Line items',
  locale: 'en-US',
};

describe('LineItemsWidget', () => {
  it('renders lines, a footer without a unit-price sum, and the record totals', async () => {
    const { container } = render(LineItemsWidget, {
      props: {
        ...base,
        data: {
          rows,
          columns,
          totals: { subtotal: 69000, tax: 3450, total: 72450 },
        },
      },
    });
    const foot = container.querySelector('tfoot') as HTMLElement;
    expect(foot).toHaveTextContent('2 in total');
    expect(foot).toHaveTextContent('3.5');
    expect(foot).toHaveTextContent('$690.00');
    expect(foot).not.toHaveTextContent('$370.00');
    const totals = container.querySelector('dl') as HTMLElement;
    expect(totals).toHaveTextContent('Subtotal $690.00');
    expect(totals).toHaveTextContent('Tax $34.50');
    expect(totals).toHaveTextContent('Total $724.50');
    expect(totals).not.toHaveTextContent('from the lines');
    expect(screen.queryByText(/Lines add up to/)).toBeNull();
    await expectNoA11yViolations(container);
  });

  it('computes missing totals and flags a mismatch visibly', async () => {
    const computed = render(LineItemsWidget, {
      props: { ...base, data: { rows, columns } },
    });
    expect(computed.container.querySelector('dl')).toHaveTextContent(
      'Subtotal (from the lines) $690.00',
    );
    computed.unmount();
    const { container } = render(LineItemsWidget, {
      props: {
        ...base,
        data: { rows, columns, totals: { subtotal: 50000, total: 50000 } },
      },
    });
    expect(screen.getByText('Lines add up to $690.00.')).toBeInTheDocument();
    expect(container).toHaveTextContent('The recorded subtotal is $500.00.');
    await expectNoA11yViolations(container);
  });

  it('shows the empty state but keeps the record totals', () => {
    render(LineItemsWidget, {
      props: { ...base, data: { rows: [], columns, totals: { total: 100 } } },
    });
    expect(screen.getByText('No line items.')).toBeInTheDocument();
    expect(screen.getByText('$1.00')).toBeInTheDocument();
  });
});
