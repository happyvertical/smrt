import { checkPlan } from '@happyvertical/smrt-spreadsheets/import';
import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { businessWorkbook } from '../../../test-support/import-workbook.ts';
import type { ImportState } from '../ui/import.ts';
import ImportReview from './ImportReview.svelte';

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
const settle = async () => {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
};
function ready(): ImportState {
  const { workbook, plan } = businessWorkbook();
  return {
    id: 'run',
    draftId: 'draft',
    state: 'done',
    status: 'review',
    step: 'review',
    stopReason: null,
    plan: {
      ...plan,
      engineNames: {
        reports: {},
        tables: {
          customers: {
            model: 'Customer',
            fields: { name: 'name', email: 'email' },
          },
          orders: {
            model: 'Order',
            fields: {
              customer: 'customer',
              price: 'price',
              quantity: 'quantity',
              total: 'total',
              status: 'status',
            },
          },
        },
      },
    },
    findings: [],
    proof: {
      plan,
      ok: true,
      loaded: { customers: 5, orders: 1 },
      facts: checkPlan(plan, workbook).facts,
      findings: [],
      work: 1,
    },
  };
}
it('previews the first three loaded rows per sheet with types and expands to all', async () => {
  const people = Array.from({ length: 5 }, (_, i) => ({
    id: `c${i}`,
    name: `Person ${i}`,
    email: `p${i}@example.test`,
  }));
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      const limit = Number(new URL(url, 'http://x').searchParams.get('limit'));
      const records = url.includes('/Customer?')
        ? people.slice(0, limit)
        : [
            {
              id: 'o1',
              customer: 'c0',
              price: 1750,
              quantity: 2,
              total: 3500,
              status: 'Paid',
            },
          ];
      return new Response(JSON.stringify({ records }));
    }),
  );
  component = mount(ImportReview, {
    target: document.body,
    props: { current: ready() },
  });
  await settle();
  expect(urls).toContain('/api/shell/records/Customer?target=draft&limit=3');
  const customers = document.querySelector(
    'table[aria-label="Customers row preview"]',
  )!;
  expect(customers.querySelectorAll('tbody tr')).toHaveLength(3);
  expect(customers.querySelector('thead')?.textContent).toContain('text');
  const orders = document.querySelector(
    'table[aria-label="Orders row preview"]',
  )!;
  expect(orders.querySelector('thead')?.textContent).toContain('money · CAD');
  expect(orders.querySelector('thead')?.textContent).toContain(
    'link · Customers',
  );
  expect(orders.querySelector('tbody')?.textContent).toContain('17.50 CAD');
  // The link cell shows the linked record's label, not its id.
  expect(orders.querySelector('tbody')?.textContent).toContain('Person 0');
  expect(orders.querySelector('tbody')?.textContent).not.toContain('c0');
  expect(urls).toContain('/api/shell/records/Customer?target=draft&limit=1000');
  const text = document.body.textContent ?? '';
  expect(text).toContain('Showing 3 of 5 rows');
  expect(text).toContain('Totals match');
  expect(text).toContain('2 columns detected');
  Array.from(document.querySelectorAll('button'))
    .find((b) => b.textContent?.includes('Show all 5 rows'))
    ?.click();
  await settle();
  expect(customers.querySelectorAll('tbody tr')).toHaveLength(5);
  expect(document.body.textContent).toContain('Showing 5 of 5 rows');
});
it('shows no preview and no request before the proof passes', async () => {
  const send = vi.fn();
  vi.stubGlobal('fetch', send);
  const current = ready();
  current.status = 'loading';
  component = mount(ImportReview, {
    target: document.body,
    props: { current },
  });
  await settle();
  expect(send).not.toHaveBeenCalled();
  expect(document.querySelector('table')).toBeNull();
});
