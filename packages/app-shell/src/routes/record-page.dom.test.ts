// The record page: title, read view, singular labels, select labels, related
// empty state and table wrapping (jsdom).
import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FieldInput from '../lib/components/FieldInput.svelte';
import RecordList from '../lib/components/RecordList.svelte';
import { fieldSpec } from '../lib/ui/fields.ts';
import type { Description, RecordRow } from '../lib/ui/types.ts';
import { description } from '../test/draft-fixtures.ts';
import RecordPage from './m/[model]/[id]/+page.svelte';
import NewPage from './m/[model]/new/+page.svelte';

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
  vi.unstubAllGlobals();
});

function shop(): Description {
  const d = description('live');
  d.models = {
    Customer: {
      ...d.models.Customer,
      label: 'Customers',
      fields: {
        code: { type: 'text', label: 'Customer #' },
        name: { type: 'text' },
      },
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
const ada: RecordRow = { id: 'c1', code: 'C003', name: 'Ada Lovelace' };

function page(data: Record<string, unknown>) {
  component = mount(RecordPage, {
    target: container,
    props: { data: { description: shop(), ...data } } as never,
  });
}
const buttons = () => [...container.querySelectorAll('button')];
const byText = (text: string) =>
  buttons().find((b) => b.textContent?.trim() === text);

describe('record page', () => {
  it('titles the page by the name, shows a read view, and Edit opens the form', async () => {
    page({
      model: 'Customer',
      record: ada,
      references: {},
      related: [
        { key: 'Order.customer', total: 0, truncated: false, records: [] },
      ],
      relatedReferences: {},
    });
    await tick();
    expect(container.querySelector('h1')?.textContent).toBe('Ada Lovelace');
    expect(container.querySelector('.smrt-app-shell__sub')?.textContent).toBe(
      'Customer',
    );
    expect(container.querySelector('dl')?.textContent).toContain('C003');
    expect(container.querySelector('form')).toBeNull();
    byText('Edit')?.click();
    await tick();
    expect(container.querySelector('form')).not.toBeNull();
    expect(container.querySelector('dl')).toBeNull();
    byText('Cancel')?.click();
    await tick();
    expect(container.querySelector('form')).toBeNull();
  });
});

describe('singular buttons and select labels', () => {
  it('says New order, not New orders, on the list and the new page', async () => {
    const d = shop();
    component = mount(RecordList, {
      target: container,
      props: { model: 'Order', description: d, rows: [] },
    });
    await tick();
    expect(container.textContent).toContain('New order');
    expect(container.textContent).not.toContain('New orders');
    unmount(component);
    component = mount(NewPage, {
      target: container,
      props: {
        data: {
          description: d,
          model: 'Order',
          references: {},
          prefill: {},
          returnTo: null,
        },
      } as never,
    });
    await tick();
    expect(container.querySelector('h1')?.textContent).toBe('New order');
  });

  it('labels reference options with the name and sorts them naturally', async () => {
    const d = shop();
    const refModel = d.models.Customer;
    const options: RecordRow[] = [
      { id: 'c5', code: 'C005', name: 'Customer 10' },
      { id: 'c6', code: 'C006', name: 'Customer 8' },
      { id: 'c7', code: 'C007', name: 'Customer 9' },
    ];
    component = mount(FieldInput, {
      target: container,
      props: {
        id: 'f',
        spec: fieldSpec('customer', d.models.Order.fields.customer),
        value: '',
        options,
        refModel,
      },
    });
    await tick();
    const labels = [...container.querySelectorAll('option')].map((o) =>
      o.textContent?.trim(),
    );
    expect(labels).toEqual(['None', 'Customer 8', 'Customer 9', 'Customer 10']);
  });
});
