import { mount, tick, unmount } from 'svelte';
import { createClassComponent } from 'svelte/legacy';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RecordForm from '../lib/components/RecordForm.svelte';
import RecordList from '../lib/components/RecordList.svelte';
import { serializeForm } from '../lib/ui/fields.ts';
import { publishGroups } from '../lib/ui/publish.ts';
import { description, preview } from '../test/draft-fixtures.ts';
import ModelPage from './m/[model]/+page.svelte';

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
function data() {
  const d = description('draft');
  d.models.Customer.fields = {
    name: { type: 'text' },
    quantity: { type: 'integer', label: 'Quantity' },
    price: { type: 'money', label: 'Price' },
    total: {
      type: 'money',
      label: 'Total',
      required: true,
      calculated: {
        op: 'mul',
        left: { col: 'quantity' },
        right: { col: 'price' },
      },
    },
  };
  return d;
}
it.each([
  true,
  false,
])('shows read-only calculated output and never submits it (editing %s)', async (editing) => {
  const d = data();
  const record = {
    id: 'c1',
    name: 'Acme',
    quantity: 2,
    price: 1250,
    total: 2500,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(record))),
  );
  component = mount(RecordForm, {
    target: container,
    props: {
      description: d,
      model: 'Customer',
      record: editing ? record : null,
    },
  });
  await tick();
  expect(container.querySelector('output')?.textContent).toBe(
    editing ? '$25.00' : '',
  );
  expect(container.textContent).toContain('Quantity × Price');
  expect(container.querySelector('input[id$="-total"]')).toBeNull();
  const input = container.querySelector<HTMLInputElement>(
    'input[id$="-quantity"]',
  );
  if (!input) throw new Error('Missing quantity input');
  input.value = '3';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  container
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  const request = vi.mocked(fetch).mock.calls[0][1];
  expect(JSON.parse(String(request?.body))).not.toHaveProperty('total');
  expect(
    serializeForm(d.models.Customer.fields, {
      name: 'Acme',
      quantity: '3',
      price: '12.50',
      total: '999',
    }).data,
  ).not.toHaveProperty('total');
});
it('sorts calculated columns numerically and displays formatted values', async () => {
  component = mount(RecordList, {
    target: container,
    props: {
      description: data(),
      model: 'Customer',
      rows: [
        { id: 'c1', name: 'First', quantity: 2, price: 100, total: 200 },
        { id: 'c2', name: 'Second', quantity: 1, price: 100, total: 100 },
      ],
    },
  });
  await tick();
  [...container.querySelectorAll<HTMLButtonElement>('th button')]
    .find((b) => b.textContent === 'Total')
    ?.click();
  await tick();
  expect(container.querySelector('tbody tr')?.textContent).toContain('Second');
  expect(container.querySelector('tbody tr')?.textContent).toContain('$1.00');
});
it('publish review explains a calculation change without a spurious type change', () => {
  const fields = data().models.Customer.fields;
  const p = {
    ...preview,
    fields: { Customer: fields },
    definition: {
      ...preview.definition,
      models: {
        Customer: {
          fieldsAdded: [],
          fieldsRemoved: [],
          fieldsChanged: [
            {
              field: 'total',
              from: { type: 'money' as const },
              to: fields.total,
            },
          ],
        },
      },
    },
  };
  expect(
    publishGroups(p)
      .flatMap((g) => g.items)
      .join(' '),
  ).toContain('calculated as Quantity × Price');
});

it('the model field view identifies calculated fields and their formula', async () => {
  component = mount(ModelPage, {
    target: container,
    props: {
      data: {
        description: data(),
        model: 'Customer',
        rows: [],
        references: {},
      },
    } as never,
  });
  await tick();
  expect(container.querySelector('details')?.textContent).toContain(
    'Total calculated',
  );
  expect(container.querySelector('details')?.textContent).toContain(
    'Quantity × Price',
  );
});

it('sorts dates chronologically and money numerically in both directions, with nulls', async () => {
  const d = data();
  d.models.Customer.fields = {
    name: { type: 'text' },
    when: { type: 'date', label: 'When' },
    price: { type: 'money', label: 'Price' },
  };
  component = mount(RecordList, {
    target: container,
    props: {
      description: d,
      model: 'Customer',
      rows: [
        { id: 'later', name: 'Later', when: '2026-01-01', price: 1000 },
        { id: 'earlier', name: 'Earlier', when: '2025-12-31', price: 200 },
        { id: 'empty', name: 'Empty', when: null, price: null },
      ],
    },
  });
  await tick();
  const names = () =>
    [...container.querySelectorAll('tbody tr td:first-child')].map((cell) =>
      cell.textContent?.trim(),
    );
  for (const label of ['When', 'Price']) {
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>('th button'),
    ].find((b) => b.textContent === label);
    button?.click();
    await tick();
    expect(names()).toEqual(['Empty', 'Earlier', 'Later']);
    button?.click();
    await tick();
    expect(names()).toEqual(['Later', 'Earlier', 'Empty']);
  }
});

it('resets sorting when navigating to another model with different fields', async () => {
  const d = data();
  d.models.Other = {
    ...d.models.Customer,
    label: 'Other',
    fields: { name: { type: 'text' } },
  };
  const list = createClassComponent({
    component: RecordList,
    target: container,
    props: {
      description: d,
      model: 'Customer',
      rows: [
        { id: 'c1', name: 'First', total: 200 },
        { id: 'c2', name: 'Second', total: 100 },
      ],
    },
  });
  try {
    await tick();
    [...container.querySelectorAll<HTMLButtonElement>('th button')]
      .find((b) => b.textContent === 'Name')
      ?.click();
    await tick();
    list.$set({
      model: 'Other',
      rows: [
        { id: 'old', name: 'A older', createdAt: '2025-01-01' },
        { id: 'new', name: 'Z newest', createdAt: '2026-01-01' },
      ],
    });
    await tick();
    expect(container.querySelector('tbody tr')?.textContent).toContain(
      'Z newest',
    );
    expect(
      [...container.querySelectorAll('th[aria-sort]')].every(
        (th) => th.getAttribute('aria-sort') === 'none',
      ),
    ).toBe(true);
  } finally {
    list.$destroy();
  }
});
