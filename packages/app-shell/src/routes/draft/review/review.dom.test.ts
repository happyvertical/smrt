import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PREVIEW_TEST_TIMEOUT_MS,
  runPreviewChild,
} from '../../../../test-support/run-preview-child.ts';
import type { PublishPreview } from '../../../lib/ui/types.ts';
import {
  description,
  draftInfo,
  preview,
} from '../../../test/draft-fixtures.ts';
import Review from './+page.svelte';

// One test runs a real-engine child; see test-support/run-preview-child.ts.
vi.setConfig({ testTimeout: PREVIEW_TEST_TIMEOUT_MS });

const navigation = vi.hoisted(() => ({
  goto: vi.fn(async () => {}),
  invalidateAll: vi.fn(async () => {}),
}));
vi.mock('$app/navigation', () => navigation);
let container: HTMLDivElement;
let component: ReturnType<typeof mount>;
let changed: boolean;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );

beforeEach(() => {
  changed = false;
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const path = String(input);
      if (path.includes('/preview')) return json({ draft: draftInfo, preview });
      if (path.includes('/publish')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          expect: preview.digest,
        });
        return changed
          ? json({ error: 'The draft changed since this preview.' }, 409)
          : json({ id: 'approval-publish', status: 'approved', result: {} });
      }
      throw new Error(`Unexpected request ${path}`);
    }),
  );
});
afterEach(() => {
  if (component) unmount(component);
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  component = mount(Review, {
    target: container,
    props: { data: { description: description() } } as never,
  });
  await vi.waitFor(() => expect(button('Publish')).toBeTruthy());
}

describe('publish review', () => {
  it('explains the wait while preparing a review and publishing', async () => {
    let release!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    component = mount(Review, {
      target: container,
      props: { data: { description: description() } } as never,
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        'Reviewing your draft… a large import can take a minute',
      ),
    );
    release(json({ draft: draftInfo, preview }));
    await vi.waitFor(() => expect(button('Publish')).toBeTruthy());
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    button('Publish')?.click();
    await vi.waitFor(() =>
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        'Publishing… a large import can take a minute',
      ),
    );
    release(json({ id: 'approval-publish', status: 'approved', result: {} }));
    await vi.waitFor(() =>
      expect(navigation.goto).toHaveBeenCalledWith('/', {
        invalidateAll: true,
      }),
    );
  });
  it('renders the preview counts, changes and every method in full', async () => {
    await render();
    const text = container.textContent;
    for (const expected of [
      'Better orders',
      'Add model Order',
      'Remove model Note',
      'Age in Customer: text to integer',
      'Archived values: 7',
      'Archived tables: 1',
      'All method code (2)',
    ])
      expect(text).toContain(expected);
    expect(
      [...container.querySelectorAll('pre code')].map((c) => c.textContent),
    ).toEqual(preview.methods.map((m) => m.code));
    expect(fetch).toHaveBeenCalledWith(
      '/api/shell/draft/preview?target=draft',
      expect.objectContaining({ method: 'POST' }),
    );
  });
  it("publishes in one step on the owner's click, pinned to the reviewed digest", async () => {
    await render();
    button('Publish')?.click();
    await vi.waitFor(() =>
      expect(navigation.goto).toHaveBeenCalledWith('/', {
        invalidateAll: true,
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/shell/draft/publish?target=draft',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ expect: preview.digest }),
      }),
    );
    // No second Approve step: nothing is fetched from the approvals routes.
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) => String(input).includes('/approvals')),
    ).toBe(false);
    expect(
      [...container.querySelectorAll('button')].some((b) =>
        b.textContent?.startsWith('Approve'),
      ),
    ).toBe(false);
  });
  it('shows a changed-draft refusal and offers a fresh review', async () => {
    changed = true;
    await render();
    button('Publish')?.click();
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        'The draft changed since this preview.',
      ),
    );
    expect(button('Review again')).toBeTruthy();
    expect(button('Publish')).toBeUndefined();
    expect(navigation.goto).not.toHaveBeenCalled();
    changed = false;
    button('Review again')?.click();
    await vi.waitFor(() => expect(button('Publish')).toBeTruthy());
    await tick();
    expect(container.textContent).not.toContain(
      'The draft changed since this preview.',
    );
  });
});

it('leads with a single-column summary, then the Publish action, then the details', async () => {
  await render();
  const group = (name: string) =>
    container.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
  expect(group('Added')?.textContent).toContain('Add model Order');
  expect(group('Added')?.textContent).toContain('Add field Email in Customer');
  expect(
    group('Added')?.querySelector('[data-smrt-component="Badge"]')?.textContent,
  ).toBe('3');
  expect(group('Added')?.textContent).toContain('Add method Total in Order');
  expect(group('Removed')?.textContent).toContain('Remove model Note');
  expect(group('Changed')?.textContent).toContain(
    'Age in Customer: text to integer',
  );
  expect(group('Archived')?.textContent).toContain('Archived values: 7');
  expect(group('Archived')?.textContent).toContain('Archived tables: 1');
  // No data was loaded, so there is no Data section and no card grid.
  expect(group('Data')).toBeNull();
  expect(container.querySelector('[data-smrt-component="Card"]')).toBeNull();
  const follows = (a: Node | null | undefined, b: Node | null | undefined) =>
    Boolean(
      ((a as Node).compareDocumentPosition(b as Node) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    );
  const publish = button('Publish');
  expect(follows(group('Archived'), publish)).toBe(true);
  const changes = container.querySelector('details ol');
  expect(changes?.querySelectorAll('li').length).toBe(2);
  // Every section, the change list and the method code sit above Publish.
  expect(follows(changes, publish)).toBe(true);
  expect(follows(container.querySelector('pre'), publish)).toBe(true);
  expect(publish?.closest('[data-smrt-part="actions"]')).toBeTruthy();
  // The summary precedes every other heading.
  expect(container.querySelector('h2')?.textContent).toBe(
    'What will be published',
  );
});

it('hides empty groups and importer bookkeeping, and shows one quiet line', async () => {
  const plumbing = structuredClone(preview);
  plumbing.methods = [];
  plumbing.archives = { values: 0, tables: 0 };
  plumbing.definition = {
    modelsAdded: [],
    modelsRemoved: [],
    recipesAdded: [],
    recipesRemoved: [],
    models: {},
  };
  plumbing.versions = [
    {
      version: 2,
      summary: 'Hide',
      humanSummary: 'Hide field: Workbook row in Orders',
      statements: [],
      steps: [],
    },
    {
      version: 3,
      summary: 'Hide',
      humanSummary: 'Hide field: Workbook lookup in Orders',
      statements: [],
      steps: [],
    },
    {
      version: 4,
      summary: 'Load',
      humanSummary: 'Load 2 records into Orders',
      statements: [],
      steps: [],
    },
  ];
  vi.mocked(fetch).mockResolvedValue(
    json({ draft: draftInfo, preview: plumbing }),
  );
  await render();
  for (const name of ['Data', 'Added', 'Removed', 'Changed', 'Archived'])
    expect(container.querySelector(`section[aria-label="${name}"]`)).toBeNull();
  const text = container.textContent ?? '';
  expect(text).toContain('No changes to publish.');
  expect(text).not.toContain('Workbook row');
  expect(text).not.toContain('Workbook lookup');
  expect(text).not.toContain('All method code');
  expect(container.querySelectorAll('details li').length).toBe(1);
  expect(container.textContent).not.toContain('0 inserted');
});

it('does not request a preview when mounted without a ready draft', async () => {
  component = mount(Review, {
    target: container,
    props: {
      data: { description: { ...description(), draft: null } },
    } as never,
  });
  await tick();
  await tick();
  expect(fetch).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('shows each loaded table with its counts and a preview of the draft rows', async () => {
  const withData = structuredClone(preview);
  withData.fields = {
    Order: {
      workbookRow: { type: 'integer', label: 'Workbook row' },
      workbookLookup: { type: 'text', label: 'Workbook lookup' },
      item: { type: 'text', label: 'Item' },
      paid: { type: 'boolean', label: 'Paid' },
    },
  };
  withData.modelLabels = { Order: 'Orders' };
  withData.versions[0].dataSteps = [
    {
      op: 'loadRecords',
      model: 'Order',
      mode: 'insert',
      counts: { insert: 5, update: 0, unchanged: 0, rejected: 0 },
    },
    {
      op: 'extractModel',
      model: 'Order',
      counts: { rows: 9, distinct: 5, folded: 1, create: 3, matched: 2 },
    },
    {
      op: 'mergeRecords',
      model: 'Customer',
      counts: { removed: 2, references: { Order: 7 } },
    },
  ];
  const rows = [1, 2, 3, 4, 5].map((n) => ({
    id: `r${n}`,
    workbookRow: n,
    workbookLookup: `k${n}`,
    item: `Widget ${n}`,
    paid: n % 2 === 0,
  }));
  vi.mocked(fetch).mockImplementation(async (input) => {
    const path = String(input);
    if (path.includes('/api/shell/records/Order')) {
      const limit = Number(new URL(path, 'http://x').searchParams.get('limit'));
      return json({ records: rows.slice(0, limit) });
    }
    return json({ draft: draftInfo, preview: withData });
  });
  await render();
  const data = container.querySelector('section[aria-label="Data"]');
  expect(data?.textContent).toContain('Orders');
  expect(data?.textContent).toContain('5 records added');
  expect(data?.textContent).not.toContain('0 updated');
  expect(data?.textContent).toContain(
    'Extract from Orders: 9 records, 5 distinct values, 1 folded, 3 created, 2 matched.',
  );
  expect(data?.textContent).toContain(
    'Merge 2 records in Customer; references repointed (7 references in Orders).',
  );
  await vi.waitFor(() =>
    expect(data?.querySelectorAll('tbody tr').length).toBe(3),
  );
  const headers = [...(data?.querySelectorAll('th') ?? [])].map((th) =>
    th.textContent?.trim(),
  );
  expect(headers.join('|')).toContain('Item');
  expect(headers.join('|')).toContain('Paid');
  expect(headers.join('|')).not.toContain('Workbook');
  expect(data?.textContent).toContain('Widget 1');
  expect(data?.textContent).toContain('Showing 3 of 5 rows');
  expect(fetch).toHaveBeenCalledWith(
    '/api/shell/records/Order?target=draft&limit=3',
  );
  [...(data?.querySelectorAll('button') ?? [])]
    .find((b) => b.textContent?.includes('Show all 5 rows'))
    ?.click();
  await vi.waitFor(() =>
    expect(data?.querySelectorAll('tbody tr').length).toBe(5),
  );
});

it('shows a success notice once published', async () => {
  await render();
  button('Publish')?.click();
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Published. Opening your app'),
  );
});

it('names the page differently from the Publish button', async () => {
  await render();
  expect(container.querySelector('h1')?.textContent).toBe(
    'Review your draft: Better orders',
  );
  expect(document.title).not.toBe('Publish');
});
it('does not request a preview when mounted without a ready draft', async () => {
  component = mount(Review, {
    target: container,
    props: {
      data: { description: { ...description(), draft: null } },
    } as never,
  });
  await tick();
  await tick();
  expect(fetch).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('shows reviewed current-live counts for each replayed data command', async () => {
  const withData = structuredClone(preview);
  withData.versions[0].dataSteps = [
    {
      op: 'loadRecords',
      model: 'Order',
      mode: 'upsert',
      counts: { insert: 2, update: 3, unchanged: 4, rejected: 0 },
    },
    {
      op: 'extractModel',
      model: 'Order',
      counts: { rows: 9, distinct: 5, folded: 1, create: 3, matched: 2 },
    },
    {
      op: 'mergeRecords',
      model: 'Customer',
      counts: { removed: 2, references: { Order: 7 } },
    },
  ];
  vi.mocked(fetch).mockResolvedValue(
    json({ draft: draftInfo, preview: withData }),
  );
  await render();
  const data = container.querySelector('section[aria-label="Data"]');
  expect(
    data?.querySelector('[data-smrt-component="Badge"]')?.textContent,
  ).toBe('3');
  expect(data?.textContent).toContain(
    '2 records added, 3 updated, 4 unchanged',
  );
  expect(data?.textContent).toContain(
    'Extract from Order: 9 records, 5 distinct values, 1 folded, 3 created, 2 matched.',
  );
  expect(data?.textContent).toContain(
    'Merge 2 records in Customer; references repointed (7 references in Order).',
  );
});

it('reviews real load and field rename rehearsals without false removals or formula changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'draft-review-'));
  try {
    const output = join(dir, 'previews.json');
    await runPreviewChild(
      'test-support/draft-review-engine-previews.ts',
      output,
    );
    const previews = JSON.parse(readFileSync(output, 'utf8')) as Record<
      string,
      PublishPreview
    >;
    for (const [name, actual] of Object.entries(previews)) {
      // Exercise legacy preview heading fallback with real command summaries too.
      if (name === 'allLabels')
        for (const version of actual.versions) delete version.humanSummary;
      vi.mocked(fetch).mockResolvedValue(
        json({ draft: draftInfo, preview: actual }),
      );
      await render();
      // The surrounding chat/sidebar can leave a 300px main column even on desktop.
      container.style.width = '300px';
      const summary = container.querySelector<HTMLElement>(
        '.smrt-publish-preview__summary',
      );
      expect(summary).toBeTruthy();
      for (const section of summary!.querySelectorAll('section')) {
        const heading = section.querySelector('.smrt-publish-preview__heading');
        expect(
          heading?.querySelector('[data-smrt-component="Badge"]'),
        ).toBeTruthy();
      }
      const text = container.textContent ?? '';
      const group = (name: string) =>
        container.querySelector(`section[aria-label="${name}"]`);
      expect(text).toContain('Rename field Quantity to units in Orders');
      expect(text).not.toContain('Order.units');
      expect(text).not.toContain('Order.quantity');
      if (name !== 'allLabels') expect(group('Added')).toBeNull();
      expect(group('Removed')?.textContent ?? '').not.toMatch(/Quantity|units/);
      expect(group('Data')?.textContent).toContain('Orders');
      expect(group('Data')?.textContent).toContain('1 record added');
      expect(group('Data')?.textContent).not.toMatch(/0 updated|0 rejected/);
      expect(container.querySelector('ol')?.textContent).toContain(
        'Load 1 record into Orders',
      );
      if (name === 'renamed' || name === 'differingLabels') {
        expect(group('Changed')?.textContent).not.toContain('calculated as');
        expect(text).not.toContain('Calculated field changes');
        expect(group('Archived')).toBeNull();
        expect(actual.archives.values).toBeGreaterThan(0); // engine undo journals remain intact
      }
      if (name === 'differingLabels')
        expect(text).toContain('Rename field Notes to Memo in Orders');
      if (name === 'formulaChanged' || name === 'archived') {
        expect(text).toContain('Calculated field changes');
        expect(group('Changed')?.textContent).toContain(
          'Total in Orders: calculated as',
        );
        expect(group('Changed')?.textContent).toContain('10');
      }
      if (name === 'archived' || name === 'allLabels')
        expect(group('Archived')?.textContent).toContain('Price in Orders');
      if (name === 'allLabels') {
        expect(group('Changed')?.textContent).toContain(
          'Change method Rebuild summary in Orders.',
        );
        expect(group('Added')?.textContent).toContain('Add model Deliveries.');
        expect(group('Added')?.textContent).toContain(
          'Add field Promised date in Orders.',
        );
        expect(group('Added')?.textContent).toContain(
          'Add method Recalculate total in Orders.',
        );
        expect(group('Removed')?.textContent).toContain(
          'Remove model Retired contacts.',
        );
        expect(group('Removed')?.textContent).toContain(
          'Remove field Previous reference in Orders.',
        );
        expect(group('Changed')?.textContent).toContain(
          'Customer rating in Orders: text to integer',
        );
        expect(container.querySelector('ol')?.textContent).toContain(
          'Change field type: Customer rating in Orders',
        );
        const codeHeadings = [...container.querySelectorAll('h3')].map(
          (heading) => heading.textContent,
        );
        expect(codeHeadings).toContain('Show total in Orders · unchanged');
        expect(codeHeadings).toContain('Recalculate total in Orders · added');
        expect(codeHeadings).toContain('Rebuild summary in Orders · changed');
        expect(
          container.querySelector(
            'pre[aria-label="Code for Recalculate total in Orders"] code',
          )?.textContent,
        ).toBe('return { result: 10 };');
        expect(text).not.toMatch(
          /Order\.|RetiredContact|Shipment|legacyField|promisedDate|recalculateTotal/,
        );
        expect(
          [...container.querySelectorAll('pre')]
            .map((code) => code.getAttribute('aria-label'))
            .join(' '),
        ).not.toMatch(/Order\.|recalculateTotal/);
      }
      if (process.env.SMRT_DRAFT_REVIEW_ARTIFACT)
        writeFileSync(
          `${process.env.SMRT_DRAFT_REVIEW_ARTIFACT}-${name}.txt`,
          text,
        );
      await unmount(component);
      component = undefined as never;
      container.replaceChildren();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps the summary a single column and the heading words intact', () => {
  const source = readFileSync(
    'src/lib/components/PublishPreview.svelte',
    'utf8',
  );
  expect(source).toContain('@layer smrt.structure {');
  expect(source).not.toContain('grid-template-columns');
  expect(source).toMatch(
    /\.smrt-publish-preview__heading\s*\{[^}]*white-space: nowrap;/s,
  );
  expect(source).toMatch(
    /\.smrt-publish-preview__summary\s*\{[^}]*overflow-wrap: normal;[^}]*word-break: normal;/s,
  );
  expect(source).not.toMatch(
    /word-break:\s*break-all|overflow-wrap:\s*anywhere/,
  );
  if (process.env.SMRT_DRAFT_REVIEW_ARTIFACT)
    writeFileSync(
      `${process.env.SMRT_DRAFT_REVIEW_ARTIFACT}-layout.css`,
      source.slice(source.indexOf('<style>') + 7, source.indexOf('</style>')),
    );
});

describe('review follow-ups', () => {
  const follows = (a: Node | null | undefined, b: Node | null | undefined) =>
    Boolean(
      ((a as Node).compareDocumentPosition(b as Node) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    );
  it('never shows storage terms for the undo history a data load saves', async () => {
    const loaded = structuredClone(preview);
    loaded.archives = { values: 84, tables: 0 };
    loaded.versions[0].steps = [
      { op: 'loadRecords', table: 'orders' } as never,
    ];
    loaded.definition.modelsRemoved = [];
    loaded.definition.models = {};
    vi.mocked(fetch).mockResolvedValue(
      json({ draft: draftInfo, preview: loaded }),
    );
    await render();
    expect(container.textContent).not.toMatch(/journal/i);
    expect(
      container.querySelector('section[aria-label="Archived"]'),
    ).toBeNull();
  });
  it('says undo history is saved beside a real archive decision', async () => {
    const loaded = structuredClone(preview);
    loaded.versions[0].steps = [
      { op: 'loadRecords', table: 'orders' } as never,
    ];
    vi.mocked(fetch).mockResolvedValue(
      json({ draft: draftInfo, preview: loaded }),
    );
    await render();
    const archived = container.querySelector('section[aria-label="Archived"]');
    expect(archived?.textContent).toContain('undo history saved');
    expect(container.textContent).not.toMatch(/journal/i);
  });
  it('lists calculated field changes above Publish, which comes last', async () => {
    const calc = structuredClone(preview);
    calc.fields = {
      Customer: { score: { type: 'integer', calculated: { value: 2 } } },
    };
    calc.definition.models.Customer.fieldsAdded = ['score'];
    vi.mocked(fetch).mockResolvedValue(
      json({ draft: draftInfo, preview: calc }),
    );
    await render();
    const heading = [...container.querySelectorAll('h2')].find(
      (h) => h.textContent === 'Calculated field changes',
    );
    expect(heading).toBeTruthy();
    const publish = button('Publish');
    expect(follows(heading, publish)).toBe(true);
    expect(follows(container.querySelector('details'), publish)).toBe(true);
    const bar = publish?.closest('[data-smrt-part="actions"]');
    expect(bar?.nextElementSibling).toBeNull();
  });
  it('says one short thing while reviewing and while publishing', async () => {
    let release: (value: Response) => void = () => {};
    await render();
    vi.mocked(fetch).mockImplementation(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    button('Publish')?.click();
    await vi.waitFor(() =>
      expect(container.querySelector('[role="status"]')).toBeTruthy(),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Publishing… a large import can take a minute',
    );
    // The button does not repeat the status line.
    expect(button('Publish')?.disabled).toBe(true);
    expect(container.textContent?.match(/Publishing/g)).toHaveLength(1);
    release(json({ error: 'stop' }, 500));
  });
  it('shows linked records by label in the draft data preview', async () => {
    const withLinks = structuredClone(preview);
    withLinks.fields = {
      Order: {
        item: { type: 'text', label: 'Item' },
        customer: { type: 'reference', label: 'Customer', ref: 'Customer' },
      },
      Customer: { name: { type: 'text', label: 'Name' } },
    };
    withLinks.modelLabels = { Order: 'Orders' };
    withLinks.versions[0].dataSteps = [
      {
        op: 'loadRecords',
        model: 'Order',
        mode: 'insert',
        counts: { insert: 1, update: 0, unchanged: 0, rejected: 0 },
      },
    ];
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = String(input);
      if (path.includes('/api/shell/records/Order'))
        return json({ records: [{ id: 'o1', item: 'Cake', customer: 'c-9' }] });
      if (path.includes('/api/shell/records/Customer'))
        return json({ records: [{ id: 'c-9', name: 'Ada Example' }] });
      return json({ draft: draftInfo, preview: withLinks });
    });
    await render();
    const data = container.querySelector('section[aria-label="Data"]');
    await vi.waitFor(() => expect(data?.textContent).toContain('Ada Example'));
    expect(data?.querySelector('tbody')?.textContent).not.toContain('c-9');
  });
});
