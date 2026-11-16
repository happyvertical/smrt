import { checkPlan } from '@happyvertical/smrt-spreadsheets/import';
import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { businessWorkbook } from '../../../test-support/import-workbook.ts';
import ImportReview from '../../lib/components/ImportReview.svelte';
import type { ImportState } from '../../lib/ui/import.ts';
import Settings from '../settings/import/+page.svelte';
import Page from './+page.svelte';

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
function ready(): ImportState {
  const { workbook, plan } = businessWorkbook();
  return {
    id: 'internal-run-id',
    draftId: 'internal-draft-id',
    state: 'done',
    status: 'review',
    step: 'review',
    stopReason: null,
    plan,
    findings: [],
    proof: {
      plan,
      ok: true,
      loaded: { customers: 2, orders: 2 },
      facts: checkPlan(plan, workbook).facts,
      findings: [],
      work: 100,
    },
  };
}
it('shows source columns, links, choice and money metadata, cached formula proof and totals with labels', async () => {
  const current = ready();
  current.findings = [
    {
      code: 'calculated-mismatch',
      severity: 'error',
      table: 'orders',
      field: 'total',
      sheet: 'Orders',
      cell: 'D4',
      expected: 2500,
      actual: 2300,
      count: 24,
      message: 'raw_key_not_for_display',
    },
  ];
  component = mount(ImportReview, {
    target: document.body,
    props: { current },
  });
  await tick();
  const text = document.body.textContent ?? '';
  for (const phrase of [
    'Orders',
    'Customers',
    '2 rows read',
    '2 loaded',
    'column B',
    'CAD',
    'links to Customers',
    'matches the workbook',
    'Totals proof',
    '24 findings',
    'D4',
  ])
    expect(text).toContain(phrase);
  expect(text).not.toContain('raw_key_not_for_display');
  expect(text).not.toContain('internal-run-id');
});
it('offers only existing draft review/publish and discard after proof', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ import: ready() }))),
  );
  component = mount(Page, {
    target: document.body,
    props: { data: { current: ready() } as never, params: {}, form: null },
  });
  await tick();
  expect(
    document.querySelector<HTMLAnchorElement>('a[href="/draft/review"]')
      ?.textContent,
  ).toContain('Review and publish');
  expect(document.body.textContent).toContain('Discard import');
  expect(document.body.textContent).toContain(
    'Publishing still needs your approval',
  );
  expect(document.querySelector('input[type="file"]')).toBeNull();
});
it('shows saved budget-stop progress with Resume and Cancel, and preserves the server refusal', async () => {
  const current = {
    ...ready(),
    state: 'stopped',
    status: 'loading',
    step: 'loading',
    stopReason: 'max_tokens',
  };
  const send = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: 'This import cannot resume within its remaining budget.',
        }),
        { status: 409 },
      ),
  );
  vi.stubGlobal('fetch', send);
  component = mount(Page, {
    target: document.body,
    props: { data: { current } as never, params: {}, form: null },
  });
  await tick();
  const resume = Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Resume'),
  )!;
  resume.click();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  expect(send).toHaveBeenCalledWith('/api/shell/import/resume', {
    method: 'POST',
  });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'cannot resume',
  );
  expect(document.body.textContent).toContain('Cancel import');
});
it('provides an accessible file picker/drop zone and refuses non-workbooks before upload', async () => {
  const send = vi.fn();
  vi.stubGlobal('fetch', send);
  component = mount(Page, {
    target: document.body,
    props: { data: { current: null } as never, params: {}, form: null },
  });
  await tick();
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', {
    value: [new File(['x'], 'notes.txt')],
  });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await tick();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    '.xlsx',
  );
  expect(send).not.toHaveBeenCalled();
  expect(
    document.querySelector('[aria-label="Workbook drop zone"]'),
  ).toBeTruthy();
});
it('saves a number setting through the owner route and shows its outcome', async () => {
  const send = vi.fn(
    async () => new Response(JSON.stringify({ maxCells: 1200 })),
  );
  vi.stubGlobal('fetch', send);
  component = mount(Settings, {
    target: document.body,
    props: { data: { maxCells: 1200 } as never, params: {}, form: null },
  });
  await tick();
  const input = document.querySelector<HTMLInputElement>(
    'input[type="number"]',
  )!;
  expect(input.min).toBe('1000');
  expect(input.max).toBe('2000000');
  document
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  expect(send).toHaveBeenCalledWith(
    '/api/shell/import/settings',
    expect.objectContaining({ body: JSON.stringify({ maxCells: 1200 }) }),
  );
  expect(document.body.textContent).toContain('Import limit saved.');
});
