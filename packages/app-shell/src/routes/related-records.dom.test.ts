// Related records on the record page (jsdom): columns, order, empty state,
// singular Add, and table wrapping.
import { readFileSync } from 'node:fs';
import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecordList from '../lib/components/RecordList.svelte';
import RelatedRecords from '../lib/components/RelatedRecords.svelte';
import type { Description, RecordRow } from '../lib/ui/types.ts';
import { description } from '../test/draft-fixtures.ts';

vi.mock('$app/navigation', () => ({
  invalidate: vi.fn(async () => {}),
  goto: vi.fn(async () => {}),
}));

let container: HTMLDivElement;
let component: ReturnType<typeof mount>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  if (component) unmount(component);
  container.remove();
});

function shop(): Description {
  const d = description('live');
  d.models = {
    Customer: {
      ...d.models.Customer,
      label: 'Customers',
      fields: { name: { type: 'text' } },
    },
    Order: {
      ...d.models.Customer,
      label: 'Orders',
      className: 'Order',
      fields: {
        number: { type: 'text' },
        customer: { type: 'reference', ref: 'Customer' },
        placed: { type: 'date' },
        total: { type: 'money', money: { currency: 'CAD', scale: 2 } },
        status: { type: 'choice', choices: ['open', 'paid'] },
      },
    },
  };
  return d;
}
const ada: RecordRow = { id: 'c1', name: 'Ada Lovelace' };
const orders: RecordRow[] = [
  {
    id: 'o1',
    number: 'O-1',
    customer: 'c1',
    placed: '2026-01-05',
    total: 2800,
    status: 'open',
  },
  {
    id: 'o2',
    number: 'O-2',
    customer: 'c1',
    placed: '2026-03-05',
    total: 1500,
    status: 'paid',
  },
];

function related(records: RecordRow[]) {
  component = mount(RelatedRecords, {
    target: container,
    props: {
      model: 'Customer',
      description: shop(),
      record: ada,
      related: [
        {
          key: 'Order.customer',
          total: records.length,
          truncated: false,
          records,
        },
      ],
    },
  });
}

describe('related records', () => {
  it('hides the link-back column, adds Total and Status, and sorts newest first', async () => {
    related(orders);
    await tick();
    const heads = [...container.querySelectorAll('th')].map((t) =>
      t.textContent?.trim(),
    );
    expect(heads).toEqual(['Number', 'Placed', 'Total', 'Status']);
    const firstCells = [
      ...container.querySelectorAll('tbody tr td:first-child'),
    ].map((t) => t.textContent?.trim());
    expect(firstCells).toEqual(['O-2', 'O-1']);
    expect(container.textContent).toContain('Add order');
    expect(container.textContent).not.toContain('Add orders');
  });

  it('says there are no orders yet, with a singular Add, instead of a lone More tab', async () => {
    related([]);
    await tick();
    const empty = container.querySelector('[data-smrt-part="empty"]');
    expect(empty?.textContent?.replace(/\s+/g, ' ')).toContain(
      'No orders yet · Add order',
    );
    expect(
      [...container.querySelectorAll('button')].some(
        (b) => b.textContent?.trim() === 'More',
      ),
    ).toBe(false);
    expect(empty?.querySelector('a')?.getAttribute('href')).toBe(
      '/m/Order/new?with=customer%3Ac1',
    );
  });

  it('sorts a model list by its main date, newest first', async () => {
    component = mount(RecordList, {
      target: container,
      props: {
        model: 'Order',
        description: shop(),
        rows: orders,
        references: { Customer: [ada] },
      },
    });
    await tick();
    const numbers = [
      ...container.querySelectorAll('tbody tr td:first-child'),
    ].map((t) => t.textContent?.trim());
    expect(numbers).toEqual(['O-2', 'O-1']);
  });

  it('lets table cells break only between words', () => {
    const css = readFileSync('src/lib/ui/ui.css', 'utf8');
    const cells =
      /\.smrt-app-shell__table th,\s*\.smrt-app-shell__table td \{[^}]*\}/.exec(
        css,
      );
    expect(cells?.[0]).toContain('overflow-wrap: normal');
    expect(cells?.[0]).toContain('word-break: normal');
  });
});
