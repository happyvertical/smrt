import { checkPlan } from '@happyvertical/smrt-spreadsheets/import';
import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import {
  businessWorkbook,
  realisticBusinessWorkbook,
} from '../../../test-support/import-workbook.ts';
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
  vi.useRealTimers();
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
    'Price: 17.50 CAD',
    'link · Customers',
    'matches the workbook',
    'Price × Quantity',
    'Totals proof',
    '24 findings',
    'D4',
  ])
    expect(text).toContain(phrase);
  expect(text).not.toContain('raw_key_not_for_display');
  expect(text).not.toContain('internal-run-id');
});
it.each([
  'before upload',
  'while planning',
])('explains large-workbook timing %s', async (stage) => {
  const current =
    stage === 'before upload'
      ? null
      : { ...ready(), state: 'running', status: 'running', step: 'planning' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ import: current }))),
  );
  component = mount(Page, {
    target: document.body,
    props: { data: { current } as never, params: {}, form: null },
  });
  await tick();
  expect(document.body.textContent).toContain(
    'A large workbook can take about a minute to import.',
  );
});
it('offers Review, Apply and Discard after proof', async () => {
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
    document.querySelector<HTMLAnchorElement>('a[href="/changes"]')
      ?.textContent,
  ).toBe('Review');
  expect(document.body.textContent).toContain('Discard import');
  expect(document.body.textContent).not.toContain('Live/Draft');
  expect(document.body.textContent).toContain('apply it in one step');
  expect(document.body.textContent).not.toContain('still needs your approval');
  // The previous proof sits in the sheet cards: no bullets or section headings.
  expect(document.querySelector('h3')).toBeNull();
  for (const card of document.querySelectorAll(
    'section[aria-label="Orders"], section[aria-label="Customers"]',
  ))
    expect(card.querySelector('ul')).toBeNull();
  expect(document.querySelector('input[type="file"]')).toBeNull();
});
it('applies the import through the digest-pinned batch route, with no draft or publish words', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    url === '/api/shell/changes/apply'
      ? new Response(JSON.stringify({ id: 'a', status: 'approved' }))
      : new Response(JSON.stringify({ import: ready() })),
  );
  vi.stubGlobal('fetch', fetchMock);
  const { changes } = await import('../../test/changes-fixtures.ts');
  component = mount(Page, {
    target: document.body,
    props: {
      data: {
        current: ready(),
        changes: changes({ digest: 'pinned' }),
      } as never,
      params: {},
      form: null,
    },
  });
  await tick();
  expect(document.body.textContent).not.toMatch(/draft|publish/i);
  const apply = [...document.querySelectorAll('button')].find((b) =>
    /^Apply 2 changes$/.test(b.textContent?.trim() ?? ''),
  )!;
  expect(apply).toBeTruthy();
  expect(document.querySelector('a[href="/changes"]')?.textContent).toBe(
    'Review',
  );
  apply.click();
  await vi.waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([u]) => u === '/api/shell/changes/apply'),
    ).toBe(true),
  );
  const call = fetchMock.mock.calls.find(
    ([u]) => u === '/api/shell/changes/apply',
  )!;
  expect(JSON.parse(String(call[1]?.body))).toMatchObject({
    expect: 'pinned',
    generation: 3,
  });
});
it('a stale digest on Apply says to review again, in plain words', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/shell/changes/apply'
        ? new Response(JSON.stringify({ error: 'stale' }), { status: 409 })
        : new Response(JSON.stringify({ import: ready() })),
    ),
  );
  const { changes } = await import('../../test/changes-fixtures.ts');
  component = mount(Page, {
    target: document.body,
    props: {
      data: { current: ready(), changes: changes() } as never,
      params: {},
      form: null,
    },
  });
  await tick();
  [...document.querySelectorAll('button')]
    .find((b) => /^Apply/.test(b.textContent?.trim() ?? ''))!
    .click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain(
      'These changes were different when you last looked',
    ),
  );
});
it('holds a new import while other changes wait, in plain words with a link', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ import: null }))),
  );
  const { changes } = await import('../../test/changes-fixtures.ts');
  component = mount(Page, {
    target: document.body,
    props: {
      data: { current: null, changes: changes() } as never,
      params: {},
      form: null,
    },
  });
  await tick();
  expect(document.body.textContent).toContain(
    'You have 2 changes waiting. Apply or discard them before importing a workbook.',
  );
  expect(document.querySelector('a[href="/changes"]')).toBeTruthy();
  expect(
    document.querySelector<HTMLInputElement>('input[type="file"]')!.disabled,
  ).toBe(true);
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
it.each([
  'Codex',
  'Claude Code',
  'ChatGPT',
  'API-key inference',
])('names %s after an engine failure and retries the saved upload', async (engine) => {
  const current: ImportState = {
    ...ready(),
    state: 'failed',
    status: 'failed',
    step: 'failed',
    reason: 'engine',
    engine,
    findings: [],
    plan: undefined,
    proof: undefined,
  };
  const send = vi.fn(
    async () => new Response(JSON.stringify({ import: current })),
  );
  vi.stubGlobal('fetch', send);
  component = mount(Page, {
    target: document.body,
    props: { data: { current } as never, params: {}, form: null },
  });
  await tick();
  expect(document.body.textContent).toContain(
    `${engine} could not plan this import`,
  );
  expect(document.body.textContent).not.toContain('findings below');
  expect(document.querySelector('a[href="/settings/assistant"]')).toBeTruthy();
  Array.from(document.querySelectorAll('button'))
    .find((b) => b.textContent === 'Try again')
    ?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  expect(send).toHaveBeenCalledWith('/api/shell/import/retry', {
    method: 'POST',
  });
  expect(send).not.toHaveBeenCalledWith(
    '/api/shell/import',
    expect.objectContaining({ method: 'POST' }),
  );
});
it.each([
  true,
  false,
])('only refers to findings when workbook findings exist (%s)', async (findings) => {
  const current: ImportState = {
    ...ready(),
    state: 'failed',
    status: 'failed',
    reason: 'workbook',
    findings: findings
      ? [
          {
            code: 'required-blank',
            severity: 'error',
            sheet: 'Orders',
            cell: 'A6',
            count: 1,
            message: 'internal_key',
          },
        ]
      : [],
    proof: undefined,
  };
  vi.stubGlobal('fetch', vi.fn());
  component = mount(Page, {
    target: document.body,
    props: { data: { current } as never, params: {}, form: null },
  });
  await tick();
  expect(document.body.textContent?.includes('findings below')).toBe(findings);
  expect(document.body.textContent).not.toContain('internal_key');
  expect(document.body.textContent).not.toContain('Try again');
});
it.each([
  'max_tokens',
  'max_duration',
])('offers resume when the time or work budget stops the run (%s)', async (stopReason) => {
  const current = {
    ...ready(),
    state: 'stopped',
    status: 'paused',
    reason: 'budget',
    stopReason,
  };
  vi.stubGlobal('fetch', vi.fn());
  component = mount(Page, {
    target: document.body,
    props: { data: { current } as never, params: {}, form: null },
  });
  await tick();
  expect(document.body.textContent).toContain('time or work limit');
  expect(document.body.textContent).toContain('Resume import');
  expect(document.body.textContent).not.toContain('findings below');
});
it('polls each reported stage, retains completed stages and shows planning elapsed time', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  const began = Date.now();
  const current: ImportState = {
    ...ready(),
    state: 'running',
    status: 'running',
    step: 'reading',
    progress: [{ stage: 'reading', at: began }],
    proof: undefined,
    plan: undefined,
  };
  let next = current;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ import: next }))),
  );
  component = mount(Page, {
    target: document.body,
    props: { data: { current } as never, params: {}, form: null },
  });
  await tick();
  for (const [stage, label] of [
    ['planning', 'Planning the import'],
    ['checking', 'Checking the plan'],
    ['loading', 'Loading your data'],
    ['proving', 'Proving the loaded data'],
  ]) {
    next = {
      ...next,
      step: stage,
      progress: [...next.progress!, { stage, at: began }],
    };
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    expect(document.querySelector('[aria-current="step"]')?.textContent).toBe(
      label,
    );
    if (stage === 'planning')
      expect(document.body.textContent).toContain(
        'Still working · 1 second elapsed',
      );
  }
  expect(
    document.querySelector('[aria-label="Import progress"]')?.textContent,
  ).toContain('Reading the workbook');
  expect(document.body.textContent).not.toContain('MiB');
});

it('offers a saved-file retry for a refused plan without blaming settings or showing validator paths', async () => {
  const current: ImportState = {
    ...ready(),
    state: 'failed',
    status: 'failed',
    reason: 'plan',
    note: 'The assistant could not work out a plan for this workbook on “Orders”, column “Total”. It stumbled on translating a formula. Your workbook is saved. Try again to ask for a new plan.',
    proof: undefined,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ import: current }))),
  );
  component = mount(Page, {
    target: document.body,
    props: { data: { current } as never, params: {}, form: null },
  });
  await tick();
  expect(document.body.textContent).toContain('column “Total”');
  expect(document.body.textContent).toContain('Try again');
  expect(document.body.textContent).not.toContain('findings below');
  expect(document.body.textContent).not.toContain('tables[0].fields');
  expect(document.body.textContent).not.toContain('invalid-expression');
  expect(document.querySelector('a[href="/settings/assistant"]')).toBeNull();
});
it('lists untranslated formulas and explains their saved values will not recalculate', async () => {
  const current: ImportState = {
    ...ready(),
    untranslatedFormulas: [
      {
        table: 'orders',
        field: 'total',
        sheet: 'Orders',
        column: 4,
        count: 42,
        examples: [{ cell: 'D4', formula: 'SUMIF(A4:A5,"Ada",B4:B5)' }],
      },
    ],
  };
  component = mount(ImportReview, {
    target: document.body,
    props: { current },
  });
  await tick();
  for (const text of [
    'Formulas not translated',
    'Orders',
    'Total',
    'column D',
    'SUMIF',
    '42 formulas',
    'will not recalculate',
  ])
    expect(document.body.textContent).toContain(text);
});

it('keeps year checks in the proof without presenting years as a useful total', async () => {
  const { workbook, plan } = realisticBusinessWorkbook();
  const current = ready();
  current.plan = plan;
  current.proof!.plan = plan;
  current.proof!.loaded = { customers: 8, orders: 42 };
  current.proof!.facts = checkPlan(plan, workbook).facts;
  const sums = structuredClone(current.proof!.facts.sums);
  component = mount(ImportReview, {
    target: document.body,
    props: { current },
  });
  await tick();
  const text = document.body.textContent ?? '';
  expect(text).toContain('Unit price × Quantity');
  expect(text).toContain('Quantity:');
  expect(text).toContain('Unit price: 635.25 CAD');
  expect(text).not.toContain('Year:');
  expect(text).not.toContain('85,092');
  expect(current.proof!.facts.sums).toEqual(sums);
  expect(sums.orders.year).toBe(2026 * 42);
});
it('names the running import actions Pause import and Cancel import, never a bare Stop', async () => {
  const current: ImportState = {
    ...ready(),
    state: 'running',
    status: 'running',
    step: 'planning',
    progress: [{ stage: 'planning', at: Date.now() }],
    proof: undefined,
    plan: undefined,
  };
  vi.stubGlobal('fetch', vi.fn());
  component = mount(Page, {
    target: document.body,
    props: { data: { current } as never, params: {}, form: null },
  });
  await tick();
  const labels = [...document.querySelectorAll('button')].map((b) =>
    b.textContent?.trim(),
  );
  expect(labels).toContain('Pause import');
  expect(labels).toContain('Cancel import');
  expect(labels).not.toContain('Stop');
});
