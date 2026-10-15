import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { shopDefinitions } from '../../screens/__tests__/shop-fixtures.js';
import { deriveScreenRelations } from '../../screens/relations.js';
import type { OverviewOptions, WidgetLoadContext } from '../types.js';
import LineItemsWidget from '../widgets/LineItemsWidget.svelte';
import {
  groupStoredTaxComponents,
  lineItemTotals,
  sumLineAmounts,
} from '../widgets/line-totals.js';
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

  it('accepts tax-inclusive line amounts that add up to the total', () => {
    // smrt-commerce lines: amount = qty x price - discount + tax.
    const taxed = lineItemTotals(
      { subtotal: 10000, tax: 500, total: 10500 },
      10500,
    );
    expect(taxed.mismatch).toBeNull();
    expect(taxed.lines.map((l) => [l.key, l.value])).toEqual([
      ['subtotal', 10000],
      ['tax', 500],
      ['total', 10500],
    ]);
    // A missing subtotal is backed out of the total, not the line sum.
    const noSubtotal = lineItemTotals({ tax: 500, total: 10500 }, 10500);
    expect(noSubtotal.mismatch).toBeNull();
    expect(noSubtotal.lines[0]).toEqual({
      key: 'subtotal',
      value: 10000,
      computed: true,
    });
  });

  describe('document-money records (#4010)', () => {
    // commerce document-money.test.ts: qty 1 x 100, discount 10, GST 5%,
    // exclusive. Line amount 90 (net), subtotal 90, discountTotal 10, tax 5,
    // total 95.
    const v2 = {
      subtotal: 90,
      discount: 10,
      tax: 5,
      total: 95,
      lineAmountType: 'exclusive' as const,
    };

    it('shows the discount as included and never subtracts it again', () => {
      expect(lineItemTotals(v2, 90)).toEqual({
        lines: [
          { key: 'subtotal', value: 90, computed: false },
          { key: 'discount', value: 10, computed: false, included: true },
          { key: 'tax', value: 5, computed: false },
          { key: 'total', value: 95, computed: false },
        ],
        lineSum: 90,
        mismatch: null,
      });
    });

    it('computes a missing subtotal from the net lines without a false flag', () => {
      const result = lineItemTotals({ ...v2, subtotal: null }, 90);
      expect(result.mismatch).toBeNull();
      expect(result.lines[0]).toEqual({
        key: 'subtotal',
        value: 90,
        computed: true,
      });
    });

    it('computes a missing total as subtotal + tax', () => {
      const result = lineItemTotals({ ...v2, total: undefined }, 90);
      expect(result.mismatch).toBeNull();
      expect(result.lines.at(-1)).toEqual({
        key: 'total',
        value: 95,
        computed: true,
      });
      // Neither subtotal nor total recorded: both from the lines.
      expect(
        lineItemTotals({ discount: 10, tax: 5, lineAmountType: 'none' }, 90)
          .lines,
      ).toEqual([
        { key: 'subtotal', value: 90, computed: true },
        { key: 'discount', value: 10, computed: false, included: true },
        { key: 'tax', value: 5, computed: false },
        { key: 'total', value: 95, computed: true },
      ]);
    });

    it('backs the net out of gross lines on an inclusive document', () => {
      // Inclusive: unit price 105 incl. 5% GST, discount 10.5 -> line 95 gross.
      const inclusive = { tax: 5, discount: 10, lineAmountType: 'inclusive' };
      const full = lineItemTotals(
        { ...inclusive, subtotal: 90, total: 95 } as const,
        95,
      );
      expect(full.mismatch).toBeNull();
      expect(full.lines.map((l) => [l.key, l.value])).toEqual([
        ['subtotal', 90],
        ['discount', 10],
        ['tax', 5],
        ['total', 95],
      ]);
      const noSubtotal = lineItemTotals(
        { ...inclusive, total: 95 } as const,
        95,
      );
      expect(noSubtotal.mismatch).toBeNull();
      expect(noSubtotal.lines[0]).toEqual({
        key: 'subtotal',
        value: 90,
        computed: true,
      });
      const noTotal = lineItemTotals(
        { ...inclusive, subtotal: 90 } as const,
        95,
      );
      expect(noTotal.mismatch).toBeNull();
      expect(noTotal.lines.at(-1)).toEqual({
        key: 'total',
        value: 95,
        computed: true,
      });
    });

    it('still flags net lines that disagree with the record', () => {
      expect(lineItemTotals(v2, 100).mismatch).toEqual({
        field: 'subtotal',
        recorded: 90,
        lines: 100,
      });
      expect(lineItemTotals({ ...v2, subtotal: null }, 100).mismatch).toEqual({
        field: 'total',
        recorded: 95,
        lines: 105,
      });
    });

    it('treats an unavailable tax as unknown, not zero', () => {
      // Inclusive, tax hidden by policy: gross lines give no net, so nothing
      // is compared against the subtotal.
      const hidden = lineItemTotals(
        { subtotal: 100, total: 105, lineAmountType: 'inclusive' },
        105,
      );
      expect(hidden.mismatch).toBeNull();
      expect(hidden.lines.map((l) => [l.key, l.value])).toEqual([
        ['subtotal', 100],
        ['total', 105],
      ]);
      // No subtotal either: no subtotal is invented from gross lines.
      expect(
        lineItemTotals({ total: 105, lineAmountType: 'inclusive' }, 105).lines,
      ).toEqual([{ key: 'total', value: 105, computed: false }]);
      // Exclusive, tax hidden: the net subtotal still comes from the lines,
      // but no total is computed or compared.
      const exclusive = lineItemTotals({ lineAmountType: 'exclusive' }, 90);
      expect(exclusive.lines).toEqual([
        { key: 'subtotal', value: 90, computed: true },
      ]);
      expect(
        lineItemTotals({ total: 95, lineAmountType: 'exclusive' }, 90).mismatch,
      ).toBeNull();
    });

    it('accepts legacy tax-inclusive lines read through the v2 columns', () => {
      // A legacy commerce invoice: lines are net + tax, the default
      // lineAmountType reads exclusive, discountTotal is 0.
      const legacy = lineItemTotals(
        {
          subtotal: 90,
          discount: 0,
          tax: 5,
          total: 95,
          lineAmountType: 'exclusive',
        },
        95,
      );
      expect(legacy.mismatch).toBeNull();
      expect(legacy.lines.map((l) => [l.key, l.value])).toEqual([
        ['subtotal', 90],
        ['tax', 5],
        ['total', 95],
      ]);
    });

    it('keeps generic records on discount-on-top semantics', () => {
      // No lineAmountType (or an unknown one): unchanged behaviour.
      for (const lineAmountType of [undefined, null, 'gross']) {
        expect(
          lineItemTotals(
            {
              discount: 1000,
              tax: 500,
              lineAmountType,
            } as unknown as Parameters<typeof lineItemTotals>[0],
            10000,
          ).lines,
        ).toEqual([
          { key: 'subtotal', value: 10000, computed: true },
          { key: 'discount', value: 1000, computed: false },
          { key: 'tax', value: 500, computed: false },
          { key: 'total', value: 9500, computed: true },
        ]);
      }
    });
  });

  it('sums minor units exactly and refuses non-integers', () => {
    expect(sumLineAmounts([100, null, '', 250])).toBe(350);
    expect(sumLineAmounts([1.5])).toBeNull();
    expect(sumLineAmounts([Number.MAX_SAFE_INTEGER, 1])).toBeNull();
  });

  it('groups a stored component only when its id, name, and percent agree', () => {
    expect(
      groupStoredTaxComponents([
        {
          taxComponentId: 'gst',
          name: 'GST',
          percent: '5',
          taxable: 81000,
          tax: 4050,
        },
        {
          taxComponentId: 'gst',
          name: 'GST',
          percent: '5',
          taxable: 33498,
          tax: 1675,
        },
        {
          taxComponentId: 'gst-alt',
          name: 'GST',
          percent: '5',
          taxable: 1,
          tax: 0,
        },
      ]),
    ).toEqual([
      {
        taxComponentId: 'gst',
        name: 'GST',
        percent: '5',
        taxable: 114498,
        tax: 5725,
      },
      {
        taxComponentId: 'gst-alt',
        name: 'GST',
        percent: '5',
        taxable: 1,
        tax: 0,
      },
    ]);
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

    const stored = createLineItemsLoader({
      relations,
      records,
      storedTotals: () => ({
        subtotal: 54000,
        discount: 0,
        tax: 2700,
        total: 56700,
        lineAmountType: 'exclusive',
        roundingScope: 'line',
        taxes: [
          {
            taxComponentId: 'gst',
            name: 'GST',
            percent: '5',
            taxable: 54000,
            tax: 2700,
          },
        ],
      }),
    });
    expect((await stored({}, ctx)).storedTotals?.total).toBe(56700);
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

  it('shows a document-money discount as included, not subtracted (#4010)', () => {
    const { container } = render(LineItemsWidget, {
      props: {
        ...base,
        data: {
          rows,
          columns,
          totals: {
            discount: 1000,
            tax: 3450,
            total: 72450,
            lineAmountType: 'exclusive',
          },
        },
      },
    });
    const totals = container.querySelector('dl') as HTMLElement;
    expect(totals).toHaveTextContent('Subtotal (from the lines) $690.00');
    expect(totals).toHaveTextContent('Includes discounts of $10.00');
    expect(totals).not.toHaveTextContent('−$10.00');
    expect(totals).toHaveTextContent('Total $724.50');
    expect(container.querySelector('.smrt-line-items__flag')).toBeNull();
  });

  it('shows the empty state but keeps the record totals', () => {
    render(LineItemsWidget, {
      props: { ...base, data: { rows: [], columns, totals: { total: 100 } } },
    });
    expect(screen.getByText('No line items.')).toBeInTheDocument();
    expect(screen.getByText('$1.00')).toBeInTheDocument();
  });

  it('renders A–E frozen snapshots from stored values without tax recalculation', () => {
    const frozen = {
      A: {
        subtotal: 114498,
        discount: 9000,
        tax: 8070,
        total: 122568,
        lineAmountType: 'exclusive' as const,
        roundingScope: 'document' as const,
        taxes: [
          {
            taxComponentId: 'gst',
            name: 'GST',
            percent: '5',
            taxable: 81000,
            tax: 4050,
          },
          {
            taxComponentId: 'gst',
            name: 'GST',
            percent: '5',
            taxable: 33498,
            tax: 1675,
          },
          {
            taxComponentId: 'pst',
            name: 'PST',
            percent: '7',
            taxable: 33498,
            tax: 2345,
          },
        ],
        expected: [
          'Subtotal CA$1,144.98',
          'Includes discounts of CA$90.00',
          'GST 5% on CA$1,144.98 CA$57.25',
          'PST 7% on CA$334.98 CA$23.45',
          'Rounded per document',
          'Total CA$1,225.68',
        ],
      },
      B: {
        subtotal: 107052,
        discount: 9000,
        tax: 7446,
        total: 114498,
        lineAmountType: 'inclusive' as const,
        roundingScope: 'line' as const,
        showNetSubtotal: true,
        taxes: [
          {
            taxComponentId: 'gst',
            name: 'GST',
            percent: '5',
            taxable: 107052,
            tax: 5352,
          },
          {
            taxComponentId: 'pst',
            name: 'PST',
            percent: '7',
            taxable: 29909,
            tax: 2094,
          },
        ],
        expected: [
          'Total CA$1,144.98',
          'Includes GST 5% of CA$53.52',
          'Includes PST 7% of CA$20.94',
          'Subtotal (excl. tax) CA$1,070.52',
        ],
      },
      C: {
        subtotal: 114498,
        discount: 9000,
        tax: 0,
        total: 114498,
        lineAmountType: 'exclusive' as const,
        roundingScope: 'line' as const,
        taxes: [],
        expected: [
          'Subtotal CA$1,144.98',
          'Includes discounts of CA$90.00',
          'Total CA$1,144.98',
        ],
      },
      D: {
        subtotal: 114498,
        discount: 9000,
        tax: 0,
        total: 114498,
        lineAmountType: 'inclusive' as const,
        roundingScope: 'document' as const,
        showNetSubtotal: true,
        taxes: [],
        expected: ['Subtotal CA$1,144.98', 'Total CA$1,144.98'],
      },
      E: {
        subtotal: 30,
        discount: 0,
        tax: 4,
        total: 34,
        lineAmountType: 'exclusive' as const,
        roundingScope: 'document' as const,
        taxes: [
          {
            taxComponentId: 'gst',
            name: 'GST',
            percent: '5',
            taxable: 30,
            tax: 2,
          },
          {
            taxComponentId: 'pst',
            name: 'PST',
            percent: '7',
            taxable: 30,
            tax: 2,
          },
        ],
        expected: [
          'Subtotal CA$0.30',
          'GST 5% on CA$0.30 CA$0.02',
          'PST 7% on CA$0.30 CA$0.02',
          'Rounded per document',
          'Total CA$0.34',
        ],
      },
    };
    for (const [name, storedTotals] of Object.entries(frozen)) {
      const view = render(LineItemsWidget, {
        props: {
          ...base,
          data: { rows: [], columns, currency: 'CAD', storedTotals },
        },
      });
      const text =
        (
          view.container.querySelector(
            '[data-money-snapshot="stored"]',
          ) as HTMLElement
        ).textContent ?? '';
      const compact = text.replace(/\s+/g, '');
      for (const value of storedTotals.expected) {
        expect(compact).toContain(value.replace(/\s+/g, ''));
      }
      expect(compact).not.toContain('TaxCA$');
      if (name === 'D') expect(compact).not.toContain('Subtotal(excl.tax)');
      view.unmount();
    }
  });
});
