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
  publishApproval,
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
let changedAt: 'request' | 'decision' | null;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );

beforeEach(() => {
  changedAt = null;
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
        return changedAt === 'request'
          ? json({ error: 'The draft changed since this preview.' }, 409)
          : json(
              {
                status: 'pending_approval',
                approvalId: 'approval-publish',
                summary: 'Publish Better orders',
                preview,
              },
              202,
            );
      }
      if (path.includes('/approvals/'))
        return changedAt === 'decision'
          ? json({
              id: 'approval-publish',
              status: 'failed',
              error: 'The draft changed since this preview.',
            })
          : json({ id: 'approval-publish', status: 'approved' });
      if (path.includes('/approvals'))
        return json({ approvals: [publishApproval()] });
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
        'Reviewing and publishing a large import can each take a while.',
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
        'Reviewing and publishing a large import can each take a while.',
      ),
    );
    release(
      json(
        {
          status: 'pending_approval',
          approvalId: 'approval-publish',
          summary: 'Publish Better orders',
          preview,
        },
        202,
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain('Approve'));
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
      'Data commands replay against current live records.',
      'If reviewed counts change, review a fresh preview before publishing.',
      'Direct record edits made in the draft are discarded;',
      'records loaded by a draft command are replayed.',
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
  it('requests the digest-pinned Approval and resolves it using the existing card', async () => {
    await render();
    button('Publish')?.click();
    await vi.waitFor(() =>
      expect(container.querySelector('button')?.textContent).toContain(
        'Approve',
      ),
    );
    const approve = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].find((b) => b.textContent?.startsWith('Approve'));
    expect(approve).toBeTruthy();
    expect(button('Publish')).toBeUndefined();
    approve?.click();
    await vi.waitFor(() =>
      expect(navigation.goto).toHaveBeenCalledWith('/', {
        invalidateAll: true,
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/shell/approvals/approval-publish?target=live',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ approve: true }),
      }),
    );
  });
  it.each([
    'request',
    'decision',
  ] as const)('shows a changed-chain refusal at %s and offers a fresh review', async (at) => {
    changedAt = at;
    await render();
    button('Publish')?.click();
    if (at === 'decision') {
      await vi.waitFor(() =>
        expect(
          [...container.querySelectorAll('button')].some((b) =>
            b.textContent?.startsWith('Approve'),
          ),
        ).toBe(true),
      );
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.startsWith('Approve'))
        ?.click();
    }
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        'The draft changed since this preview.',
      ),
    );
    expect(button('Review again')).toBeTruthy();
    expect(navigation.goto).not.toHaveBeenCalled();
    changedAt = null;
    button('Review again')?.click();
    await vi.waitFor(() => expect(button('Publish')).toBeTruthy());
    await tick();
    expect(container.textContent).not.toContain(
      'The draft changed since this preview.',
    );
  });
});

it('groups definition changes into counted sections before ordered changes and method code', async () => {
  await render();
  const group = (name: string) =>
    container.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
  expect(group('Data')?.textContent).toContain(
    'Replayed against current live records.',
  );
  expect(
    group('Data')?.querySelector('[data-smrt-component="Badge"]')?.textContent,
  ).toBe('0');
  expect(group('Added')?.textContent).toContain('Add model Order');
  expect(group('Added')?.textContent).toContain('Add field Email in Customer');
  expect(
    group('Added')?.querySelector('[data-smrt-component="Badge"]')?.textContent,
  ).toBe('3');
  expect(group('Added')?.textContent).toContain('Add method Total in Order');
  expect(group('Removed')?.textContent).toContain('Remove model Note');
  expect(group('Removed')?.textContent).toContain(
    'Remove field Old name in Customer',
  );
  expect(group('Changed')?.textContent).toContain(
    'Age in Customer: text to integer',
  );
  expect(group('Archived')?.textContent).toContain('Archived values: 7');
  expect(group('Archived')?.textContent).toContain('Archived tables: 1');
  expect(
    group('Archived')?.querySelector('[data-smrt-component="Badge"]')
      ?.textContent,
  ).toBe('8');
  const changes = container.querySelector('ol');
  expect(changes?.querySelectorAll('li').length).toBe(2);
  expect(
    Boolean(
      (group('Archived')?.compareDocumentPosition(changes as Node) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  ).toBe(true);
  expect(
    Boolean(
      (changes?.compareDocumentPosition(
        container.querySelector('pre') as Node,
      ) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  ).toBe(true);
  expect(
    container.querySelectorAll('[data-smrt-component="Card"]').length,
  ).toBe(5);
});

it('keeps empty change groups visible with zero counts', async () => {
  vi.mocked(fetch).mockResolvedValue(
    json({
      draft: draftInfo,
      preview: {
        ...preview,
        versions: [],
        methods: [],
        archives: { values: 0, tables: 0 },
        definition: {
          modelsAdded: [],
          modelsRemoved: [],
          recipesAdded: [],
          recipesRemoved: [],
          models: {},
        },
      },
    }),
  );
  await render();
  for (const name of ['Data', 'Added', 'Removed', 'Changed', 'Archived']) {
    const group = container.querySelector(`section[aria-label="${name}"]`);
    expect(
      group?.querySelector('[data-smrt-component="Badge"]')?.textContent,
    ).toBe('0');
  }
  expect(container.querySelector('ol')?.children.length).toBe(0);
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
    'Load records into Order (upsert): 2 inserted, 3 updated, 4 unchanged, 0 rejected.',
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
      const grid = container.querySelector<HTMLElement>(
        '.smrt-publish-preview__groups',
      );
      expect(grid).toBeTruthy();
      expect(
        [...grid!.children].map((section) =>
          section.getAttribute('aria-label'),
        ),
      ).toEqual(['Data', 'Added', 'Removed', 'Changed', 'Archived']);
      for (const section of grid!.children) {
        const heading = section.querySelector(
          '.smrt-publish-preview__group-heading',
        );
        expect(heading?.querySelector('h2')).toBeTruthy();
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
      if (name !== 'allLabels')
        expect(group('Added')?.textContent).toContain('None.');
      expect(group('Removed')?.textContent).not.toMatch(/Quantity|units/);
      expect(group('Data')?.textContent).toContain(
        'Load records into Orders (insert): 1 inserted, 0 updated, 0 unchanged, 0 rejected.',
      );
      expect(container.querySelector('ol')?.textContent).toContain(
        'Load 1 record into Orders',
      );
      if (name === 'renamed' || name === 'differingLabels') {
        expect(group('Changed')?.textContent).not.toContain('calculated as');
        expect(text).not.toContain('Calculated field changes');
        expect(group('Archived')?.textContent).toContain('None.');
        expect(
          group('Archived')?.querySelector('[data-smrt-component="Badge"]')
            ?.textContent,
        ).toBe('0');
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

it('sizes summary tracks to the available column and keeps heading words intact', () => {
  const source = readFileSync(
    'src/lib/components/PublishPreview.svelte',
    'utf8',
  );
  expect(source).toContain('@layer smrt.structure {');
  expect(source).toContain('repeat(auto-fit, minmax(min(100%, 18rem), 1fr))');
  expect(source).toMatch(
    /\.smrt-publish-preview__group-heading\s*\{[^}]*white-space: nowrap;/s,
  );
  expect(source).toMatch(
    /\.smrt-publish-preview__group\s*\{[^}]*overflow-wrap: normal;[^}]*word-break: normal;/s,
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
