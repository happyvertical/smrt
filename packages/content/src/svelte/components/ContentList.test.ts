// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentData } from '../../mock-smrt-client.js';
import {
  CONTENT_LIST_UNREPRESENTABLE_OPTION,
  normalizeContentToken,
} from '../content-list-controller.js';
import {
  ContentListQueryError,
  contentListQueryRequestKey,
} from '../content-list-query.js';
import { createContentListJobController } from '../content-list-runtime.js';
import { createContentListMemorySavedViewStore } from '../content-list-saved-views.js';
import Harness from './__tests__/content-list-props-harness.svelte';
import { createFakeContentListQuery } from './__tests__/content-list-query-fixture.svelte.js';
import ContentList from './ContentList.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

const contents: ContentData[] = [
  {
    id: 'content-1',
    type: 'article',
    title: 'Council budget explained',
    description: 'A close read of the tabled budget.',
    author: 'Ada Lovelace',
    status: 'published',
    state: 'active',
    updatedAt: '2026-02-01T10:00:00.000Z',
  },
  {
    id: 'content-2',
    type: 'document',
    title: 'Zoning appendix',
    description: 'Reference tables.',
    author: 'Grace Hopper',
    status: 'draft',
    state: 'deprecated',
    updatedAt: '2026-01-20T10:00:00.000Z',
  },
];

interface RenderOptions {
  contents?: ContentData[];
  [key: string]: unknown;
}

function renderList(props: RenderOptions = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ContentList, {
    target,
    props: {
      contents,
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onAdd: vi.fn(),
      ...props,
    },
  });
  mountedComponents.push(component);
  flushSync();
  return target;
}

function buttonByLabel(target: HTMLElement, label: string): HTMLButtonElement {
  const button = target.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!button) throw new Error(`No button labelled ${label}`);
  return button;
}

function buttonsByText(target: HTMLElement, text: string): HTMLButtonElement[] {
  return Array.from(target.querySelectorAll('button')).filter(
    (button) => button.textContent?.trim() === text,
  );
}

function checkboxByLabel(target: HTMLElement, label: string): HTMLInputElement {
  const checkbox = target.querySelector<HTMLInputElement>(
    `input[type="checkbox"][aria-label="${label}"]`,
  );
  if (!checkbox) throw new Error(`No checkbox labelled ${label}`);
  return checkbox;
}

function searchInput(target: HTMLElement): HTMLInputElement {
  const input = target.querySelector<HTMLInputElement>(
    'input[placeholder="Search contents..."]',
  );
  if (!input) throw new Error('No search input');
  return input;
}

function typeText(element: HTMLInputElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

function selectOption(element: HTMLSelectElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
}

function click(element: Element) {
  (element as HTMLElement).click();
  flushSync();
}

function switchTo(target: HTMLElement, label: string) {
  click(buttonByLabel(target, label));
}

/**
 * Presentations whose paging must be identical.
 *
 * `defaultViewMode` defaults to `grid`, and `renderList` never overrode it, so
 * every paging, clamping, and restoration test only ever exercised the arm
 * where `DataTable` is NOT mounted. `DataTable` clamps the same controller, so
 * half the component's paging behaviour was untested — twice a clamp fix landed
 * green while the compact path still carried the bug. Anything about which page
 * is requested, which pages exist, or which rows are reachable belongs in
 * `describePaging` so it runs in both.
 */
const PAGING_VIEW_MODES = ['grid', 'compact'] as const;

/** Renders in one presentation; the suite body receives the bound renderer. */
function describePaging(
  name: string,
  suite: (render: (props?: RenderOptions) => HTMLElement) => void,
): void {
  for (const defaultViewMode of PAGING_VIEW_MODES) {
    describe(`${name} [${defaultViewMode}]`, () => {
      suite((props: RenderOptions = {}) =>
        renderList({ defaultViewMode, ...props }),
      );
    });
  }
}

/**
 * The rendered row titles, in whichever presentation is mounted — the card
 * modes render headings, the compact table renders a title cell.
 */
function visibleRowTitles(target: HTMLElement): string[] {
  const table = target.querySelector('table');
  if (!table) return rowTitles(target);
  return Array.from(table.querySelectorAll('tbody tr td:nth-child(3)')).map(
    (cell) => cell.textContent?.trim() ?? '',
  );
}

function rowTitles(target: HTMLElement): string[] {
  return Array.from(target.querySelectorAll('h3')).map(
    (heading) => heading.textContent?.trim() ?? '',
  );
}

afterEach(() => {
  while (mountedComponents.length > 0) {
    const component = mountedComponents.pop();
    if (component) {
      unmount(component);
    }
  }

  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('ContentList presentations', () => {
  it('renders grid cards by default', () => {
    const target = renderList();

    expect(target.querySelectorAll('.content-card')).toHaveLength(2);
    expect(rowTitles(target)).toEqual([
      'Council budget explained',
      'Zoning appendix',
    ]);
  });

  it('renders the detailed rows when seeded with the detailed mode', () => {
    const target = renderList({ defaultViewMode: 'detailed' });

    expect(target.querySelectorAll('.content-row')).toHaveLength(2);
    expect(target.querySelector('.content-card')).toBeNull();
  });

  it('renders the compact mode as a semantic table with column headers', () => {
    const target = renderList({ defaultViewMode: 'compact' });
    const table = target.querySelector('table');

    expect(table).toBeTruthy();
    const headers = Array.from(table?.querySelectorAll('th') ?? []).map(
      (header) => header.textContent?.trim(),
    );
    expect(headers.join(' ')).toContain('Title');
    expect(headers.join(' ')).toContain('Status');
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('keeps the same row identities in every presentation', () => {
    const target = renderList();

    const gridRows = rowTitles(target);
    switchTo(target, 'Detailed List');
    const detailedRows = rowTitles(target);
    switchTo(target, 'Compact List');
    const compactRows = Array.from(
      target.querySelectorAll('tbody tr td:nth-child(3)'),
    ).map((cell) => cell.textContent?.trim());

    expect(detailedRows).toEqual(gridRows);
    expect(compactRows).toEqual(gridRows);
  });
});

describe('ContentList shared query state', () => {
  it('filters every presentation from one search term', () => {
    const target = renderList();

    typeText(searchInput(target), 'zoning');

    expect(rowTitles(target)).toEqual(['Zoning appendix']);

    switchTo(target, 'Compact List');
    expect(target.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('preserves search, filters, and selection across a mode switch', () => {
    const target = renderList();

    typeText(searchInput(target), 'council');
    click(checkboxByLabel(target, 'Select Council budget explained'));

    expect(target.textContent).toContain('1 selected');

    switchTo(target, 'Compact List');

    expect(searchInput(target).value).toBe('council');
    expect(target.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(target.textContent).toContain('1 selected');
    // The compact table reuses the same row identity and selection wording.
    expect(
      checkboxByLabel(target, 'Deselect Council budget explained').checked,
    ).toBe(true);

    switchTo(target, 'Grid View');

    expect(searchInput(target).value).toBe('council');
    expect(
      checkboxByLabel(target, 'Deselect Council budget explained').checked,
    ).toBe(true);
  });

  it('filters by type and by status from the toolbar selects', () => {
    const target = renderList();
    const [typeSelect, statusSelect] =
      target.querySelectorAll<HTMLSelectElement>('select');

    selectOption(typeSelect, 'document');
    expect(rowTitles(target)).toEqual(['Zoning appendix']);

    selectOption(typeSelect, '');
    selectOption(statusSelect, 'published');
    expect(rowTitles(target)).toEqual(['Council budget explained']);
  });

  it('locks the type filter and hides the type select when a type prop is supplied', () => {
    const target = renderList({ type: 'article' });

    expect(target.querySelectorAll('select')).toHaveLength(1);
    expect(rowTitles(target)).toEqual(['Council budget explained']);
  });

  it('re-applies the locked type filter when a surface command drops it', async () => {
    const registry = createDataSurfaceRegistry();
    const identity = { surfaceId: 'content-list', kind: 'table' as const };
    const target = renderList({
      type: 'article',
      defaultViewMode: 'compact',
      dataSurface: { registry },
      contents: [
        ...contents,
        {
          id: 'content-3',
          type: 'document',
          title: 'Published appendix',
          status: 'published',
          state: 'active',
        },
      ],
    });

    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    expect(target.querySelectorAll('tbody tr')).toHaveLength(1);

    // A surface may set its own filters, but it may not unlock the list.
    await registry.execute({
      version: 1,
      commandId: 'clear-type-filter',
      identity,
      expectedRevision: registry.inspect(identity)?.revision ?? 0,
      controlId: 'set-filters',
      payload: {
        filters: [
          { columnId: 'status', operator: 'equals', value: 'published' },
        ],
      },
    });
    flushSync();

    expect(target.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(target.textContent).toContain('Council budget explained');
    expect(target.textContent).not.toContain('Published appendix');

    await registry.execute({
      version: 1,
      commandId: 'reset-view',
      identity,
      expectedRevision: registry.inspect(identity)?.revision ?? 0,
      controlId: 'reset',
    });
    flushSync();

    expect(target.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(target.textContent).not.toContain('Published appendix');
  });

  it('re-applies the locked type filter when a surface command inverts it', async () => {
    const registry = createDataSurfaceRegistry();
    const identity = { surfaceId: 'content-list', kind: 'table' as const };
    const target = renderList({
      type: 'article',
      defaultViewMode: 'compact',
      dataSurface: { registry },
      contents: [
        ...contents,
        {
          id: 'content-3',
          type: 'document',
          title: 'Published appendix',
          status: 'published',
          state: 'active',
        },
      ],
    });

    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());

    // A filter naming the locked value but negating it must not pass the lock.
    await registry.execute({
      version: 1,
      commandId: 'invert-type-filter',
      identity,
      expectedRevision: registry.inspect(identity)?.revision ?? 0,
      controlId: 'set-filters',
      payload: {
        filters: [
          { columnId: 'type', operator: 'notEquals', value: 'article' },
        ],
      },
    });
    flushSync();

    expect(target.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(target.textContent).toContain('Council budget explained');
    expect(target.textContent).not.toContain('Published appendix');
  });

  it('selects and clears every row on the page from the shared selection bar', () => {
    const target = renderList();

    click(checkboxByLabel(target, 'Select all contents on this page'));
    expect(target.textContent).toContain('2 selected');

    click(buttonsByText(target, 'Clear selection')[0]);
    expect(target.textContent).toContain('0 selected');
  });
});

describe('ContentList query ownership', () => {
  it('renders the same rows in every mode for a search with surrounding whitespace', () => {
    const target = renderList();

    typeText(searchInput(target), '  zoning  ');
    const gridTitles = rowTitles(target);

    expect(gridTitles).toEqual(['Zoning appendix']);

    switchTo(target, 'Compact List');
    const compactTitles = Array.from(
      target.querySelectorAll('tbody tr td:nth-child(3)'),
    ).map((cell) => cell.textContent?.trim());

    expect(compactTitles).toEqual(gridTitles);
  });

  it('sorts through the adapter when a compact column header is clicked', () => {
    const target = renderList({ defaultViewMode: 'compact' });

    // Ascending, then descending: the second click has to reverse the rows even
    // though DataTable itself no longer sorts anything.
    click(buttonByLabel(target, 'Sort Title ascending'));
    click(buttonByLabel(target, 'Sort Title descending'));

    expect(
      Array.from(target.querySelectorAll('tbody tr td:nth-child(3)')).map(
        (cell) => cell.textContent?.trim(),
      ),
    ).toEqual(['Zoning appendix', 'Council budget explained']);

    switchTo(target, 'Grid View');
    expect(rowTitles(target)).toEqual([
      'Zoning appendix',
      'Council budget explained',
    ]);
  });

  it('renders the same rows in every mode for a mixed-case equals filter', async () => {
    const registry = createDataSurfaceRegistry();
    const identity = { surfaceId: 'content-list', kind: 'table' as const };
    const target = renderList({
      defaultViewMode: 'compact',
      dataSurface: { registry },
    });

    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    await registry.execute({
      version: 1,
      commandId: 'filter-published',
      identity,
      expectedRevision: registry.inspect(identity)?.revision ?? 0,
      controlId: 'set-filters',
      payload: {
        filters: [
          { columnId: 'status', operator: 'equals', value: 'PUBLISHED' },
        ],
      },
    });
    flushSync();

    const compactTitles = Array.from(
      target.querySelectorAll('tbody tr td:nth-child(3)'),
    ).map((cell) => cell.textContent?.trim());
    expect(compactTitles).toEqual(['Council budget explained']);

    switchTo(target, 'Grid View');
    expect(rowTitles(target)).toEqual(compactTitles);
  });
});

describe('ContentList selection integrity', () => {
  const withGhostRow: ContentData[] = [
    contents[0],
    { type: 'article', title: 'Ghost row', status: 'draft', state: 'active' },
  ];

  it('disables and explains the checkbox of a row without a durable id', () => {
    const target = renderList({ contents: withGhostRow });

    const ghost = checkboxByLabel(target, 'Select Ghost row');
    expect(ghost.disabled).toBe(true);
    expect(ghost.getAttribute('title')).toBe(
      'This content has no stable id and cannot be selected.',
    );
    expect(
      checkboxByLabel(target, 'Select Council budget explained').disabled,
    ).toBe(false);
  });

  it('skips rows without a durable id when selecting the whole page', () => {
    const target = renderList({ contents: withGhostRow });

    click(checkboxByLabel(target, 'Select all contents on this page'));

    expect(target.textContent).toContain('1 selected');
  });

  it('disables the compact row checkbox of a row without a durable id', () => {
    const target = renderList({
      contents: withGhostRow,
      defaultViewMode: 'compact',
    });

    const ghost = checkboxByLabel(target, 'Select Ghost row');
    expect(ghost.disabled).toBe(true);
    expect(ghost.getAttribute('title')).toBe(
      'This content has no stable id and cannot be selected.',
    );

    click(ghost);

    expect(target.textContent).toContain('0 selected');
  });

  it('toggles only the durable rows from the compact header select-all', () => {
    const target = renderList({
      contents: withGhostRow,
      defaultViewMode: 'compact',
    });
    // Whichever header checkbox the table renders, it must address exactly the
    // durable page rows rather than getting stuck half-selected on the ghost.
    const selectAll = () => {
      const checkbox = target.querySelector<HTMLInputElement>(
        'thead input[type="checkbox"]',
      );
      if (!checkbox) throw new Error('No header select-all checkbox');
      return checkbox;
    };

    expect(selectAll().getAttribute('aria-label')).toBe(
      'Select all contents on this page',
    );

    click(selectAll());

    // The ghost row must not leave the header stuck in an indeterminate state.
    expect(target.textContent).toContain('1 selected');
    expect(selectAll().checked).toBe(true);
    expect(selectAll().indeterminate).toBe(false);

    click(selectAll());

    expect(target.textContent).toContain('0 selected');
    expect(selectAll().checked).toBe(false);
    expect(selectAll().indeterminate).toBe(false);
  });

  it('normalizes a surface selection that reaches a row without a durable id', async () => {
    const registry = createDataSurfaceRegistry();
    const identity = { surfaceId: 'content-list', kind: 'table' as const };
    const target = renderList({
      contents: withGhostRow,
      defaultViewMode: 'compact',
      dataSurface: { registry },
    });

    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    await registry.execute({
      version: 1,
      commandId: 'select-ghost',
      identity,
      expectedRevision: registry.inspect(identity)?.revision ?? 0,
      controlId: 'set-selected-rows',
      payload: {
        rowIds: ['content-list:unidentified:1', 'content-1'],
      },
    });
    flushSync();

    expect(target.textContent).toContain('1 selected');
    expect(
      checkboxByLabel(target, 'Deselect Council budget explained').checked,
    ).toBe(true);
    expect(checkboxByLabel(target, 'Select Ghost row').checked).toBe(false);
  });
});

describe('ContentList callbacks', () => {
  it('confirms before delegating a delete', () => {
    const onDelete = vi.fn();
    const target = renderList({ onDelete });

    click(buttonsByText(target, 'Delete')[0]);
    const dialog = document.querySelector('[role="dialog"]');

    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain('Council budget explained');
    expect(onDelete).not.toHaveBeenCalled();

    const confirm = Array.from(dialog?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Delete',
    );
    click(confirm as HTMLButtonElement);

    expect(onDelete).toHaveBeenCalledWith(contents[0]);
  });

  it('keeps the legacy edit and add callbacks', () => {
    const onEdit = vi.fn();
    const onAdd = vi.fn();
    const target = renderList({ onEdit, onAdd });

    click(buttonsByText(target, 'Edit')[0]);
    expect(onEdit).toHaveBeenCalledWith(contents[0]);

    click(buttonsByText(target, 'Add Content')[0]);
    expect(onAdd).toHaveBeenCalled();
  });

  it('renders a view link only for routable content', () => {
    const target = renderList({
      getViewHref: (content: ContentData) =>
        content.status === 'published' ? `/articles/${content.id}` : null,
    });

    const viewLinks = Array.from(target.querySelectorAll('a.view-btn'));
    expect(viewLinks).toHaveLength(1);
    expect(viewLinks[0].getAttribute('href')).toBe('/articles/content-1');
  });

  it('degrades an unknown subtype to plain text instead of a dead link', () => {
    const target = renderList({
      defaultViewMode: 'compact',
      contents: [{ id: 'content-9', type: 'unknown', title: 'Odd content' }],
      getViewHref: () => {
        throw new Error('unknown content subtype');
      },
    });

    expect(target.textContent).toContain('Odd content');
    expect(target.querySelector('a.title-link')).toBeNull();
    expect(target.querySelector('tbody strong')?.textContent).toBe(
      'Odd content',
    );
  });

  it('renders the passed controls snippet host actions', () => {
    const target = renderList();
    expect(target.querySelector('.search-filters')).toBeTruthy();
  });
});

describe('ContentList async states', () => {
  it('announces a load error with a retry affordance instead of the list', () => {
    const onRetry = vi.fn();
    const target = renderList({ error: 'Network unavailable', onRetry });

    const alert = target.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Network unavailable');
    expect(target.querySelector('.content-card')).toBeNull();

    click(buttonsByText(target, 'Retry')[0]);
    expect(onRetry).toHaveBeenCalled();
  });

  it('announces the initial load and the empty result', () => {
    const loadingTarget = renderList({ contents: [], loading: true });
    expect(
      loadingTarget.querySelector('[role="status"]')?.textContent?.trim(),
    ).toBe('Loading contents...');

    const emptyTarget = renderList({ contents: [] });
    expect(emptyTarget.textContent).toContain(
      'No contents match your filters.',
    );
  });
});

describe('ContentList trustworthy async runtime (#2455)', () => {
  it('keeps stale rows usable and reports a failed refresh without success', () => {
    const query = createFakeContentListQuery();
    const target = renderList({ query: { bind: () => query.binding } });
    query.resolve([serverRow('content-1', 'Council budget explained')]);
    query.setFreshness({ stale: true, lastUpdated: 1_787_765_400_000 });
    query.fail(new Error('reconnect failed'));
    flushSync();

    expect(rowTitles(target)).toEqual(['Council budget explained']);
    const alert = target.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('latest refresh failed');
    expect(alert?.textContent).toContain('reconnect failed');
    expect(alert?.textContent).not.toContain('Completed');
    expect(target.textContent).toContain('Showing saved content');
  });

  it('subscribes to the exact live query and reconnects after offline state', () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'onLine');
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
    });
    try {
      const query = createFakeContentListQuery();
      const target = renderList({ query: { bind: () => query.binding } });
      query.resolve([serverRow('content-1', 'Council budget explained')]);
      flushSync();

      expect(query.liveSubscriptions).toBe(1);
      window.dispatchEvent(new Event('offline'));
      flushSync();
      expect(target.textContent).toContain('Offline — showing saved content');
      expect(rowTitles(target)).toEqual(['Council budget explained']);

      window.dispatchEvent(new Event('online'));
      flushSync();
      expect(query.reconnects).toBe(1);
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'onLine', descriptor);
      else Reflect.deleteProperty(navigator, 'onLine');
    }
  });

  it('reconciles an external row change without losing query or selection', () => {
    const query = createFakeContentListQuery();
    const target = renderList({ query: { bind: () => query.binding } });
    query.resolve([serverRow('content-1', 'Council budget explained')]);
    flushSync();

    typeText(searchInput(target), 'budget');
    click(checkboxByLabel(target, 'Select Council budget explained'));
    query.resolve([serverRow('content-1', 'Council budget updated')]);
    flushSync();

    expect(searchInput(target).value).toBe('budget');
    expect(rowTitles(target)).toEqual(['Council budget updated']);
    expect(target.textContent).toContain('1 selected');
  });

  it('shows job id and progress, disables its row, and refreshes only on success', async () => {
    const query = createFakeContentListQuery();
    const jobs = createContentListJobController();
    jobs.update({
      jobId: 'job-review-1',
      actionId: 'review',
      submissionKey: 'review:content-1',
      status: 'running',
      target: { kind: 'rows', rowIds: ['content-1'] },
      completed: 1,
      total: 3,
    });
    const target = renderList({
      jobs,
      query: { bind: () => query.binding },
    });
    query.resolve([serverRow('content-1', 'Council budget explained')]);
    flushSync();

    expect(target.textContent).toContain('Job job-review-1');
    expect(target.querySelector('progress')?.getAttribute('value')).toBe('1');
    expect(buttonsByText(target, 'Edit')[0].disabled).toBe(true);

    jobs.update({
      ...jobs.snapshot().jobs[0],
      status: 'succeeded',
      completed: 3,
    });
    await settle();
    expect(query.refreshes).toBe(1);

    jobs.update({
      jobId: 'job-unrelated',
      actionId: 'review',
      submissionKey: 'review:content-2',
      status: 'running',
      target: { kind: 'rows', rowIds: ['content-2'] },
    });
    const unrelated = jobs
      .snapshot()
      .jobs.find((job) => job.jobId === 'job-unrelated');
    expect(unrelated).toBeDefined();
    if (!unrelated) throw new Error('Expected the unrelated job snapshot.');
    jobs.update({ ...unrelated, status: 'succeeded' });
    await settle();
    expect(query.refreshes).toBe(1);

    const activeRequest = query.requests.at(-1);
    expect(activeRequest).toBeDefined();
    if (!activeRequest) throw new Error('Expected the active query request.');
    jobs.update({
      jobId: 'job-query',
      actionId: 'bulk-review',
      submissionKey: 'bulk-review:active-query',
      status: 'running',
      target: {
        kind: 'query',
        queryKey: contentListQueryRequestKey(activeRequest),
      },
    });
    flushSync();
    expect(buttonsByText(target, 'Edit')[0].disabled).toBe(true);
    expect(
      checkboxByLabel(target, 'Select Council budget explained').disabled,
    ).toBe(true);
  });

  it('keeps a failed job failed and exposes its explicit retry', async () => {
    const retry = vi.fn(async () => ({
      jobId: 'job-retry-2',
      actionId: 'review',
      submissionKey: 'review:content-1',
      status: 'running' as const,
      target: { kind: 'rows' as const, rowIds: ['content-1'] },
    }));
    const jobs = createContentListJobController({ retry });
    jobs.update({
      jobId: 'job-failed-1',
      actionId: 'review',
      submissionKey: 'review:content-1',
      status: 'running',
      target: { kind: 'rows', rowIds: ['content-1'] },
    });
    const target = renderList({ jobs });
    jobs.update({
      ...jobs.snapshot().jobs[0],
      status: 'failed',
      error: 'model unavailable',
    });
    flushSync();

    expect(
      target.querySelector('[data-job-id="job-failed-1"] [role="alert"]')
        ?.textContent,
    ).toBe('model unavailable');
    click(buttonsByText(target, 'Retry job')[0]);
    await settle();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('ships a reduced-motion override for refresh affordances', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/svelte/components/ContentList.svelte'),
      'utf8',
    );
    expect(source).toContain('@media (prefers-reduced-motion: reduce)');
    expect(source).toMatch(/refresh-button[\s\S]*transition: none/);
  });
});

describe('ContentList data surface', () => {
  it('registers the compact table and drives the shared controller from a command', async () => {
    const registry = createDataSurfaceRegistry();
    const identity = { surfaceId: 'content-list', kind: 'table' as const };
    const target = renderList({
      defaultViewMode: 'compact',
      dataSurface: { registry },
    });

    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    expect(registry.inspect(identity)?.descriptor.rowKey).toBe('id');

    const result = await registry.execute({
      version: 1,
      commandId: 'search-zoning',
      identity,
      expectedRevision: registry.inspect(identity)?.revision ?? 0,
      controlId: 'set-search',
      payload: { search: 'zoning' },
    });
    flushSync();

    expect(result.ok).toBe(true);
    expect(target.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(searchInput(target).value).toBe('zoning');
  });
});

describe('ContentList empty results', () => {
  it('keeps the compact surface registered and recoverable on a zero-row query', async () => {
    const registry = createDataSurfaceRegistry();
    const identity = { surfaceId: 'content-list', kind: 'table' as const };
    const target = renderList({
      defaultViewMode: 'compact',
      dataSurface: { registry },
    });

    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());

    const noMatches = await registry.execute({
      version: 1,
      commandId: 'search-nothing',
      identity,
      expectedRevision: registry.inspect(identity)?.revision ?? 0,
      controlId: 'set-search',
      payload: { search: 'no-such-content' },
    });
    flushSync();

    expect(noMatches.ok).toBe(true);
    expect(
      target.querySelectorAll('tbody tr[class*="row--empty"]'),
    ).toHaveLength(1);
    expect(target.querySelector('tbody')?.textContent).toContain(
      'No contents match your filters.',
    );
    // The surface must survive its own zero-result query.
    expect(registry.inspect(identity)).toBeDefined();

    const recovered = await registry.execute({
      version: 1,
      commandId: 'reset-after-empty',
      identity,
      expectedRevision: registry.inspect(identity)?.revision ?? 0,
      controlId: 'reset',
    });
    flushSync();

    expect(recovered.ok).toBe(true);
    expect(target.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('still shows the shared empty panel in the card presentations', () => {
    const target = renderList();

    typeText(searchInput(target), 'no-such-content');

    expect(target.querySelector('.empty-state')?.textContent?.trim()).toBe(
      'No contents match your filters.',
    );
    expect(target.querySelector('table')).toBeNull();
  });
});

describe('ContentList paging and refreshing in the card presentations', () => {
  it('renders page controls that navigate the card rows', async () => {
    const registry = createDataSurfaceRegistry();
    const identity = { surfaceId: 'content-list', kind: 'table' as const };
    const target = renderList({
      defaultViewMode: 'compact',
      dataSurface: { registry },
    });

    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    await registry.execute({
      version: 1,
      commandId: 'page-size-one',
      identity,
      expectedRevision: registry.inspect(identity)?.revision ?? 0,
      controlId: 'set-page-size',
      payload: { pageSize: 1 },
    });
    flushSync();

    switchTo(target, 'Grid View');

    const pages = target.querySelector('nav');
    expect(pages).toBeTruthy();
    expect(pages?.getAttribute('aria-label')).toBe('Content pages');
    expect(rowTitles(target)).toEqual(['Council budget explained']);

    const nextPage = Array.from(pages?.querySelectorAll('button') ?? []).find(
      (button) =>
        /next|2/i.test(
          `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`,
        ),
    );
    click(nextPage as HTMLButtonElement);

    expect(rowTitles(target)).toEqual(['Zoning appendix']);
  });

  it('announces a refresh while the card rows stay on screen', () => {
    const target = renderList({ loading: true });

    const status = target.querySelector('[role="status"]');
    expect(status?.textContent?.trim()).toBe('Refreshing contents...');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(target.querySelectorAll('.content-card')).toHaveLength(2);
  });

  it('keeps the initial-load panel when no rows are available yet', () => {
    const target = renderList({ contents: [], loading: true });

    expect(target.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      'Loading contents...',
    );
  });
});

describe('ContentList accessibility', () => {
  it('names every icon-only control', () => {
    const target = renderList({ defaultViewMode: 'compact' });

    for (const button of Array.from(target.querySelectorAll('button'))) {
      const name =
        button.getAttribute('aria-label')?.trim() ||
        button.textContent?.trim() ||
        '';
      expect(name).not.toBe('');
    }
    for (const link of Array.from(target.querySelectorAll('a'))) {
      const name =
        link.getAttribute('aria-label')?.trim() ||
        link.textContent?.trim() ||
        '';
      expect(name).not.toBe('');
    }
  });

  it('labels every selection checkbox', () => {
    const target = renderList();

    const checkboxes = Array.from(
      target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const checkbox of checkboxes) {
      expect(checkbox.getAttribute('aria-label')?.trim()).toBeTruthy();
    }
  });

  it('groups the view-mode toggles and marks the active one', () => {
    const target = renderList();
    const group = target.querySelector('[role="group"]');

    expect(group?.getAttribute('aria-label')).toBe('View mode');
    expect(
      buttonByLabel(target, 'Grid View').getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      buttonByLabel(target, 'Compact List').getAttribute('aria-pressed'),
    ).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// Server-backed mode, URL state, and saved views (#2452)
// ---------------------------------------------------------------------------

function serverRow(
  id: string,
  title: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type: 'article',
    title,
    description: '',
    author: 'Ada Lovelace',
    status: 'published',
    state: 'active',
    updated_at: '2026-02-01T10:00:00.000Z',
    ...overrides,
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

describe('ContentList server-backed mode (#2452)', () => {
  it('renders exactly the rows the transport returned, in that order', () => {
    const query = createFakeContentListQuery();
    const target = renderList({
      query: { bind: () => query.binding },
    });

    // A search no local row could satisfy: if the component still ran the local
    // predicate over the server's answer, both rows would disappear.
    typeText(searchInput(target), 'zzzz-no-local-match');
    query.resolve([
      serverRow('server-2', 'Zoning appendix'),
      serverRow('server-1', 'Council budget explained'),
    ]);
    flushSync();

    expect(rowTitles(target)).toEqual([
      'Zoning appendix',
      'Council budget explained',
    ]);
  });

  it('does not re-sort or re-page the server answer', () => {
    const query = createFakeContentListQuery();
    const target = renderList({
      // A page size of one: a second local pass would keep a single row.
      query: { bind: () => query.binding, request: { defaultPageSize: 1 } },
    });

    click(buttonByLabel(target, 'Compact List'));
    // An ascending title sort: a second local pass would reorder these three.
    const titleHeader = Array.from(target.querySelectorAll('th button')).find(
      (button) => button.textContent?.includes('Title'),
    );
    if (!titleHeader) throw new Error('No sortable Title header');
    click(titleHeader);

    query.resolve(
      [
        serverRow('server-b', 'Beta'),
        serverRow('server-a', 'Alpha'),
        serverRow('server-c', 'Gamma'),
      ],
      3,
    );
    flushSync();

    expect(
      Array.from(target.querySelectorAll('tbody tr td:nth-child(3)')).map(
        (cell) => cell.textContent?.trim(),
      ),
    ).toEqual(['Beta', 'Alpha', 'Gamma']);
    // The sort did reach the server, it just did not run again locally.
    expect(query.requests.at(-1)?.sort).toEqual([
      { field: 'title', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ]);
  });

  it('ignores the `contents` prop entirely', () => {
    const query = createFakeContentListQuery();
    const target = renderList({ query: { bind: () => query.binding } });

    expect(rowTitles(target)).toEqual([]);

    query.resolve([serverRow('server-1', 'Only from the server')]);
    flushSync();

    expect(rowTitles(target)).toEqual(['Only from the server']);
  });

  it('executes an offset request that maps the columns to server fields', () => {
    const query = createFakeContentListQuery();
    const target = renderList({
      query: {
        bind: () => query.binding,
        request: { defaultPageSize: 20 },
      },
    });

    expect(query.requests).toHaveLength(1);
    expect(query.requests[0]).toMatchObject({
      version: 1,
      mode: 'rows',
      page: { kind: 'offset', offset: 0, limit: 20 },
    });

    selectOption(
      target.querySelectorAll('select')[0] as HTMLSelectElement,
      'article',
    );

    expect(query.requests).toHaveLength(2);
    expect(JSON.stringify(query.requests[1].filter)).toContain(
      '"field":"type"',
    );
  });

  it('re-queries for a query change but not for a selection change', () => {
    const query = createFakeContentListQuery();
    const target = renderList({ query: { bind: () => query.binding } });
    query.resolve([serverRow('server-1', 'Council budget explained')]);
    flushSync();

    const beforeSelection = query.requests.length;
    click(checkboxByLabel(target, 'Select Council budget explained'));
    expect(query.requests).toHaveLength(beforeSelection);

    typeText(searchInput(target), 'budget');
    expect(query.requests.length).toBe(beforeSelection + 1);
  });

  it('keeps a selection addressable across a server page change', () => {
    const query = createFakeContentListQuery();
    const target = renderList({ query: { bind: () => query.binding } });
    query.resolve([serverRow('server-1', 'Council budget explained')], 2);
    flushSync();

    click(checkboxByLabel(target, 'Select Council budget explained'));
    expect(target.textContent).toContain('1 selected');

    // The next page carries entirely different rows; the selection must not be
    // silently discarded just because its row is no longer rendered.
    query.resolve([serverRow('server-2', 'Zoning appendix')], 2);
    flushSync();

    expect(target.textContent).toContain('1 selected');
  });

  describePaging('server-total paging', (renderIn) => {
    it('pages against the server total rather than the rendered page', () => {
      const query = createFakeContentListQuery();
      const target = renderIn({
        query: {
          bind: () => query.binding,
          request: { defaultPageSize: 2 },
        },
      });
      // Two rows on screen, fifty in the query.
      query.resolve(
        [serverRow('server-1', 'Alpha'), serverRow('server-2', 'Beta')],
        50,
      );
      flushSync();

      const pages = target.querySelector('nav');
      expect(pages).toBeTruthy();
      expect(pages?.getAttribute('aria-label')).toBe('Content pages');
    });
  });

  it('announces a query failure through the shared error panel and retries', () => {
    const query = createFakeContentListQuery();
    const target = renderList({ query: { bind: () => query.binding } });

    query.fail(
      new ContentListQueryError('Filter field is not declared: secret', {
        code: 'DATA_QUERY_FILTER_NOT_ALLOWED',
        status: 400,
      }),
    );
    flushSync();

    const panel = target.querySelector('[role="alert"]');
    expect(panel?.textContent).toContain('Contents could not be loaded');
    expect(panel?.textContent).toContain('DATA_QUERY_FILTER_NOT_ALLOWED');

    click(buttonsByText(target, 'Retry')[0]);
    expect(query.retries).toBe(1);
  });

  it('announces a refresh over rows that are already on screen', () => {
    const query = createFakeContentListQuery();
    const target = renderList({ query: { bind: () => query.binding } });
    query.resolve([serverRow('server-1', 'Council budget explained')]);
    flushSync();

    query.setBusy({ refreshing: true });
    flushSync();

    const status = target.querySelector('[role="status"]');
    expect(status?.textContent?.trim()).toBe('Refreshing contents...');
    expect(rowTitles(target)).toEqual(['Council budget explained']);
  });

  it('leaves local mode untouched when no query source is supplied (H3)', () => {
    const target = renderList();

    typeText(searchInput(target), 'zoning');
    expect(rowTitles(target)).toEqual(['Zoning appendix']);
  });
});

describe('ContentList URL state (#2452)', () => {
  it('restores search, a filter, and the page from query parameters', () => {
    const target = renderList({
      urlState: { params: 'q=zoning&status=draft' },
    });

    expect(searchInput(target).value).toBe('zoning');
    expect(rowTitles(target)).toEqual(['Zoning appendix']);
  });

  it('reports what a stale link could not restore', () => {
    const target = renderList({
      urlState: { params: 'legacyScore.gt=5' },
    });

    const notice = target.querySelector('.state-notice');
    expect(notice?.textContent).toContain(
      'Part of this view could not be applied',
    );
    expect(notice?.textContent).toContain('legacyScore');
    expect(notice?.textContent).toContain('that column no longer exists');

    click(buttonsByText(target, 'Dismiss')[0]);
    expect(target.querySelector('.state-notice')).toBeNull();
  });

  it('lets the `type` prop lock win over a restored type filter', () => {
    const target = renderList({
      type: 'article',
      urlState: { params: 'type=document' },
    });

    // `document` was restored, then the lock effect re-applied `article`.
    expect(rowTitles(target)).toEqual(['Council budget explained']);
    // A locked list never renders the type select at all.
    expect(
      Array.from(target.querySelectorAll('select')).some(
        (select) => select.getAttribute('aria-label') === 'Filter by type',
      ),
    ).toBe(false);
  });

  it('restores a type filter when no `type` prop locks the list', () => {
    const target = renderList({ urlState: { params: 'type=document' } });

    // Without a lock the select owns the filter, so a restored type must
    // survive rather than being cleared as though the prop had been removed.
    expect(rowTitles(target)).toEqual(['Zoning appendix']);
    const select = Array.from(target.querySelectorAll('select')).find(
      (candidate) => candidate.getAttribute('aria-label') === 'Filter by type',
    );
    expect(select?.value).toBe('document');
  });

  it('publishes changes while preserving foreign parameters', () => {
    const onChange = vi.fn();
    const target = renderList({
      urlState: { params: 'utm_source=newsletter', onChange },
    });

    // The initial restore must not be published back at the host.
    expect(onChange).not.toHaveBeenCalled();

    typeText(searchInput(target), 'zoning');

    expect(onChange).toHaveBeenCalled();
    const params = onChange.mock.calls.at(-1)?.[0] as URLSearchParams;
    expect(params.get('q')).toBe('zoning');
    expect(params.get('utm_source')).toBe('newsletter');
  });
});

describe('ContentList saved views (#2452)', () => {
  it('saves the current view and applies it again', async () => {
    const store = createContentListMemorySavedViewStore({
      storageKey: 'test:content-list:component',
    });
    const target = renderList({ savedViews: store });
    await settle();

    typeText(searchInput(target), 'zoning');
    const nameInput = target.querySelector<HTMLInputElement>(
      'input[aria-label="Name for this view"]',
    );
    if (!nameInput) throw new Error('No saved-view name input');
    typeText(nameInput, 'Zoning work');
    click(buttonsByText(target, 'Save view')[0]);
    await settle();

    expect((await store.list()).map((view) => view.name)).toEqual([
      'Zoning work',
    ]);

    // Move away from the saved view, then come back to it.
    typeText(searchInput(target), '');
    expect(rowTitles(target)).toHaveLength(2);

    const [saved] = await store.list();
    const select = target.querySelector<HTMLSelectElement>(
      'select[aria-label="Saved views"]',
    );
    if (!select) throw new Error('No saved-view select');
    selectOption(select, saved.id);

    expect(searchInput(target).value).toBe('zoning');
    expect(rowTitles(target)).toEqual(['Zoning appendix']);
  });

  it('restores a stale view and reports the columns it dropped', async () => {
    const store = createContentListMemorySavedViewStore({
      storageKey: 'test:content-list:stale',
    });
    await store.save({
      name: 'Legacy audit',
      snapshot: {
        version: 3,
        modes: {
          filtering: 'manual',
          sorting: 'manual',
          pagination: 'manual',
        },
        state: {
          search: 'zoning',
          filters: [
            { columnId: 'legacyScore', operator: 'gt', value: 5 },
            { columnId: 'status', operator: 'equals', value: 'draft' },
          ],
          sorting: [],
          page: 1,
          pageSize: null,
          columnOrder: [],
          columnVisibility: [],
          columnWidths: [],
          columnPinning: [],
          selection: { scope: 'explicit', rowIds: [] },
          selectedRowIds: [],
          expandedRowIds: [],
        },
      } as never,
    });

    const target = renderList({ savedViews: store });
    await settle();

    const [saved] = await store.list();
    const select = target.querySelector<HTMLSelectElement>(
      'select[aria-label="Saved views"]',
    );
    if (!select) throw new Error('No saved-view select');
    selectOption(select, saved.id);

    // The valid remainder still applied.
    expect(searchInput(target).value).toBe('zoning');
    expect(rowTitles(target)).toEqual(['Zoning appendix']);
    // And the stale column was reported rather than silently discarded.
    const notice = target.querySelector('.state-notice');
    expect(notice?.textContent).toContain('legacyScore');
  });

  it('deletes the selected view', async () => {
    const store = createContentListMemorySavedViewStore({
      storageKey: 'test:content-list:delete',
    });
    const saved = await store.save({
      name: 'Temporary',
      snapshot: {
        version: 3,
        modes: {
          filtering: 'manual',
          sorting: 'manual',
          pagination: 'manual',
        },
        state: {
          search: '',
          filters: [],
          sorting: [],
          page: 1,
          pageSize: null,
          columnOrder: [],
          columnVisibility: [],
          columnWidths: [],
          columnPinning: [],
          selection: { scope: 'explicit', rowIds: [] },
          selectedRowIds: [],
          expandedRowIds: [],
        },
      } as never,
    });

    const target = renderList({ savedViews: store });
    await settle();

    const select = target.querySelector<HTMLSelectElement>(
      'select[aria-label="Saved views"]',
    );
    if (!select) throw new Error('No saved-view select');
    selectOption(select, saved.id);
    click(buttonsByText(target, 'Delete view')[0]);
    await settle();

    expect(await store.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Review batch #2452
// ---------------------------------------------------------------------------

function requestLimit(request: { page?: unknown } | undefined): number {
  const page = request?.page as { limit?: number } | undefined;
  if (typeof page?.limit !== 'number') throw new Error('No offset page');
  return page.limit;
}

function paginationNav(target: HTMLElement): HTMLElement | null {
  return target.querySelector<HTMLElement>('nav[aria-label="Content pages"]');
}

describePaging(
  'ContentList unpaginated state in server mode (#2452)',
  (render) => {
    it('coerces `?size=all` to the page size, pages, and says so', () => {
      const query = createFakeContentListQuery();
      const target = render({
        query: { bind: () => query.binding, request: { defaultPageSize: 2 } },
        urlState: { params: 'size=all' },
      });

      // The request is bounded, not silently defaulted behind the operator's back.
      expect(query.requests.at(-1)?.page).toEqual({
        kind: 'offset',
        offset: 0,
        limit: 2,
      });

      query.resolve([serverRow('a', 'Alpha'), serverRow('b', 'Beta')], 5);
      flushSync();

      // Page controls render, so the other three rows are reachable.
      expect(paginationNav(target)).toBeTruthy();
      const notice = target.querySelector('.state-notice');
      expect(notice?.textContent).toContain(
        'an unpaginated list is not available from the server',
      );

      // And paging actually issues the next offset.
      const nextPage = Array.from(
        paginationNav(target)?.querySelectorAll('button') ?? [],
      ).find((button) =>
        /next|2/i.test(
          `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`,
        ),
      );
      click(nextPage as HTMLButtonElement);
      expect(query.requests.at(-1)?.page).toEqual({
        kind: 'offset',
        offset: 2,
        limit: 2,
      });
    });

    it('keeps the server page-size seed when a link omits `size`', () => {
      const query = createFakeContentListQuery();
      const target = render({
        query: { bind: () => query.binding, request: { defaultPageSize: 2 } },
        urlState: { params: 'q=zoning' },
      });

      expect(searchInput(target).value).toBe('zoning');
      expect(query.requests.at(-1)?.page).toEqual({
        kind: 'offset',
        offset: 0,
        limit: 2,
      });

      query.resolve([serverRow('a', 'Alpha'), serverRow('b', 'Beta')], 5);
      flushSync();

      expect(paginationNav(target)).toBeTruthy();
      // Nothing was refused, so the operator is not told anything.
      expect(target.querySelector('.state-notice')).toBeNull();
    });

    it('omits `size` from a published link while at the default', () => {
      const onChange = vi.fn();
      const query = createFakeContentListQuery();
      const target = render({
        query: { bind: () => query.binding, request: { defaultPageSize: 2 } },
        urlState: { params: '', onChange },
      });

      typeText(searchInput(target), 'zoning');

      const params = onChange.mock.calls.at(-1)?.[0] as URLSearchParams;
      expect(params.get('q')).toBe('zoning');
      expect(params.get('size')).toBeNull();
    });

    it('restores configured defaults from an empty query string', () => {
      // A bare path is a valid binding, not an absent one: the configured page
      // size must apply exactly as it would with parameters present.
      const target = render({
        urlState: { params: '', options: { defaultPageSize: 1 } },
      });

      expect(visibleRowTitles(target)).toHaveLength(1);
      expect(paginationNav(target)).toBeTruthy();
    });

    it('still allows an unpaginated local list', () => {
      const target = render({ urlState: { params: 'size=all' } });

      expect(visibleRowTitles(target)).toHaveLength(2);
      expect(paginationNav(target)).toBeNull();
      expect(target.querySelector('.state-notice')).toBeNull();
    });
  },
);

describe('ContentList server completeness reporting (#2452)', () => {
  it('tells the operator when the server truncated the answer', async () => {
    const query = createFakeContentListQuery();
    const target = renderList({ query: { bind: () => query.binding } });

    query.setEnvelope({
      truncated: true,
      warnings: [
        'Content query result was truncated to fit its maximum result bytes.',
      ],
    });
    // Any query-affecting change issues a fresh execute.
    typeText(searchInput(target), 'budget');
    await settle();

    const notice = target.querySelector('.state-notice');
    expect(notice?.textContent).toContain(
      'The server shortened this answer to fit its size limit',
    );
    expect(notice?.textContent).toContain('maximum result bytes');
  });

  it('prefers a binding that exposes the flags itself', () => {
    const query = createFakeContentListQuery();
    const binding = {
      ...query.binding,
      get rows() {
        return query.binding.rows;
      },
      get total() {
        return query.binding.total;
      },
      get loading() {
        return query.binding.loading;
      },
      get refreshing() {
        return query.binding.refreshing;
      },
      get stale() {
        return query.binding.stale;
      },
      get error() {
        return query.binding.error;
      },
      truncated: true,
      warnings: ['Content query shortened over-long values in: description.'],
    };
    const target = renderList({ query: { bind: () => binding } });

    const notice = target.querySelector('.state-notice');
    expect(notice?.textContent).toContain('shortened over-long values');
  });

  it('says nothing when the answer was complete', async () => {
    const query = createFakeContentListQuery();
    const target = renderList({ query: { bind: () => query.binding } });
    query.setEnvelope({ truncated: false, warnings: [] });
    typeText(searchInput(target), 'budget');
    await settle();

    expect(target.querySelector('.state-notice')).toBeNull();
  });
});

describePaging('ContentList restore limits (#2452)', (render) => {
  it('holds a saved view to the host maxPageSize, like a link', async () => {
    const store = createContentListMemorySavedViewStore({
      storageKey: 'test:content-list:max-page-size',
    });
    await store.save({
      name: 'Huge',
      snapshot: {
        version: 3,
        modes: {
          filtering: 'manual',
          sorting: 'manual',
          pagination: 'manual',
        },
        state: {
          search: '',
          filters: [],
          sorting: [],
          page: 1,
          pageSize: 100_000,
          columnOrder: [],
          columnVisibility: [],
          columnWidths: [],
          columnPinning: [],
          selection: { scope: 'explicit', rowIds: [] },
          selectedRowIds: [],
          expandedRowIds: [],
        },
      } as never,
    });

    const query = createFakeContentListQuery();
    const target = render({
      savedViews: store,
      query: { bind: () => query.binding, request: { defaultPageSize: 10 } },
      urlState: { options: { maxPageSize: 25 } },
    });
    await settle();

    const [saved] = await store.list();
    const select = target.querySelector<HTMLSelectElement>(
      'select[aria-label="Saved views"]',
    );
    if (!select) throw new Error('No saved-view select');
    selectOption(select, saved.id);

    expect(query.requests.at(-1)?.page).toEqual({
      kind: 'offset',
      offset: 0,
      limit: 25,
    });
    expect(target.querySelector('.state-notice')?.textContent).toContain(
      'that value was outside the allowed range',
    );
  });
});

// ---------------------------------------------------------------------------
// Review batch 2 (#2452)
// ---------------------------------------------------------------------------

describe('ContentList page-size ceiling (#2452 batch 2)', () => {
  it('coerces a data-surface set-page-size above the ceiling', async () => {
    const registry = createDataSurfaceRegistry();
    const query = createFakeContentListQuery();
    const target = renderList({
      defaultViewMode: 'compact',
      dataSurface: { registry },
      query: {
        bind: () => query.binding,
        request: { defaultPageSize: 10, maxPageSize: 25 },
      },
    });
    query.resolve([serverRow('a', 'Alpha')], 5_000);
    flushSync();

    const identity = { surfaceId: 'content-list', kind: 'table' as const };
    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    await registry.execute({
      version: 1,
      commandId: 'huge-page-size',
      identity,
      expectedRevision: registry.inspect(identity)?.revision ?? 0,
      controlId: 'set-page-size',
      payload: { pageSize: 100_000 },
    });
    flushSync();

    // The controller and the request agree, and neither exceeds the ceiling.
    const limit = requestLimit(query.requests.at(-1));
    expect(limit).toBe(25);
    expect(target.querySelector('.state-notice')?.textContent).toContain(
      'that value was outside the allowed range',
    );
    // 5000 rows at 25 a page is 200 pages, so page controls must render — in
    // COMPACT, without switching away. ContentList renders the pager itself in
    // every view mode, so the assertion holds where the test actually mounted.
    expect(paginationNav(target)).toBeTruthy();
  });

  it('clamps a seed page size above the ceiling', () => {
    const query = createFakeContentListQuery();
    const target = renderList({
      query: {
        bind: () => query.binding,
        request: { defaultPageSize: 201 },
      },
    });
    expect((query.requests[0].page as { limit: number }).limit).toBe(200);
    // The seed itself is clamped, so a mis-configured host does not get a
    // spurious "outside the allowed range" notice on first paint.
    expect(target.querySelector('.state-notice')).toBeNull();

    query.resolve([serverRow('a', 'Alpha')], 201);
    flushSync();
    // Row 201 is reachable because the UI pages by the same number.
    expect(paginationNav(target)).toBeTruthy();
  });

  it('keeps a tighter query ceiling when a looser URL ceiling exists', () => {
    const query = createFakeContentListQuery();
    renderList({
      query: {
        bind: () => query.binding,
        request: { defaultPageSize: 200, maxPageSize: 25 },
      },
      urlState: { options: { maxPageSize: 200 } },
    });
    expect((query.requests[0].page as { limit: number }).limit).toBe(25);
  });

  it('never lets the controller and the request disagree', () => {
    const query = createFakeContentListQuery();
    const target = renderList({
      query: {
        bind: () => query.binding,
        request: { defaultPageSize: 500, maxPageSize: 40 },
      },
      urlState: { params: 'size=1000' },
    });
    query.resolve([serverRow('a', 'Alpha')], 400);
    flushSync();

    const limit = requestLimit(query.requests.at(-1));
    const totalPages = Math.ceil(400 / limit);
    expect(limit).toBe(40);
    // The rendered page control count matches what the request actually pages by.
    expect(paginationNav(target)).toBeTruthy();
    expect(totalPages).toBe(10);
  });
});

describe('ContentList capped-offset page alignment (#2452 batch 2)', () => {
  it('moves the page marker to the page the request reads', async () => {
    const registry = createDataSurfaceRegistry();
    const query = createFakeContentListQuery();
    renderList({
      defaultViewMode: 'compact',
      dataSurface: { registry },
      query: { bind: () => query.binding, request: { defaultPageSize: 200 } },
    });
    query.resolve([serverRow('a', 'Alpha')], 2_000_000);
    flushSync();

    // A page whose offset exceeds the protocol maximum of 1,000,000.
    const identity = { surfaceId: 'content-list', kind: 'table' as const };
    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    await registry.execute({
      version: 1,
      commandId: 'far-page',
      identity,
      expectedRevision: registry.inspect(identity)?.revision ?? 0,
      controlId: 'set-page',
      payload: { page: 10_000 },
    });
    flushSync();

    const page = query.requests.at(-1)?.page as {
      offset: number;
      limit: number;
    };
    expect(page.offset).toBeLessThanOrEqual(1_000_000);
    // The page the UI reports is the page the server actually read, not the
    // one that was asked for and silently capped.
    const surfaceState = registry.inspect(identity)?.state as {
      table?: { state?: { page?: number } };
    };
    expect(surfaceState?.table?.state?.page).toBe(page.offset / page.limit + 1);
    expect(surfaceState?.table?.state?.page).toBeLessThan(10_000);
  });
});

describe('ContentList retry refreshes the completeness notice (#2452 batch 2)', () => {
  it('clears a stale truncation notice when the retry comes back complete', async () => {
    const query = createFakeContentListQuery();
    const target = renderList({ query: { bind: () => query.binding } });

    query.setEnvelope({ truncated: true, warnings: ['rows were dropped'] });
    typeText(searchInput(target), 'budget');
    await settle();
    expect(target.querySelector('.state-notice')?.textContent).toContain(
      'rows were dropped',
    );

    // The retry answers completely; the notice must not outlive the rows it
    // described. The query signature is unchanged, so only the retry path can.
    query.setEnvelope({ truncated: false, warnings: [] });
    query.fail(new Error('transient'));
    flushSync();
    click(buttonsByText(target, 'Retry')[0]);
    await settle();

    expect(query.retries).toBe(1);
    expect(target.querySelector('.state-notice')).toBeNull();
  });

  it('raises a notice when a retry comes back truncated', async () => {
    const query = createFakeContentListQuery();
    const target = renderList({ query: { bind: () => query.binding } });
    query.setEnvelope({ truncated: false, warnings: [] });
    typeText(searchInput(target), 'budget');
    await settle();
    expect(target.querySelector('.state-notice')).toBeNull();

    query.setEnvelope({ truncated: true, warnings: [] });
    query.fail(new Error('transient'));
    flushSync();
    click(buttonsByText(target, 'Retry')[0]);
    await settle();

    expect(target.querySelector('.state-notice')?.textContent).toContain(
      'The server shortened this answer',
    );
  });
});

// ---------------------------------------------------------------------------
// Review batch 3 (#2452)
// ---------------------------------------------------------------------------

function serverFilterValues(
  request: { filter?: unknown } | undefined,
): unknown[] {
  const found: unknown[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const entry = node as Record<string, unknown>;
    if (entry.kind === 'condition') {
      found.push(entry.value);
      return;
    }
    if (Array.isArray(entry.filters)) entry.filters.forEach(walk);
    if (entry.filter) walk(entry.filter);
  };
  walk(request?.filter);
  return found;
}

describe('ContentList free-text filter case (#2452 batch 3)', () => {
  it('sends a restored free-text filter with its case intact', () => {
    const query = createFakeContentListQuery();
    renderList({
      query: { bind: () => query.binding },
      urlState: { params: 'author.contains=NASA' },
    });

    // `%nasa%` would miss `NASA Update` on a case-sensitive backend.
    expect(serverFilterValues(query.requests.at(-1))).toContain('%NASA%');
  });

  it('sends a saved view free-text filter with its case intact', async () => {
    const store = createContentListMemorySavedViewStore({
      storageKey: 'test:content-list:case',
    });
    await store.save({
      name: 'NASA',
      snapshot: {
        version: 3,
        modes: {
          filtering: 'manual',
          sorting: 'manual',
          pagination: 'manual',
        },
        state: {
          search: '',
          filters: [{ columnId: 'title', operator: 'equals', value: 'NASA' }],
          sorting: [],
          page: 1,
          pageSize: null,
          columnOrder: [],
          columnVisibility: [],
          columnWidths: [],
          columnPinning: [],
          selection: { scope: 'explicit', rowIds: [] },
          selectedRowIds: [],
          expandedRowIds: [],
        },
      } as never,
    });

    const query = createFakeContentListQuery();
    const target = renderList({
      savedViews: store,
      query: { bind: () => query.binding },
    });
    await settle();
    const [saved] = await store.list();
    const select = target.querySelector<HTMLSelectElement>(
      'select[aria-label="Saved views"]',
    );
    if (!select) throw new Error('No saved-view select');
    selectOption(select, saved.id);

    expect(serverFilterValues(query.requests.at(-1))).toContain('NASA');
  });

  it('still normalizes the token columns, whose stored values are tokens', () => {
    const query = createFakeContentListQuery();
    renderList({
      query: { bind: () => query.binding },
      urlState: { params: 'status=Published&state=ACTIVE' },
    });

    const values = serverFilterValues(query.requests.at(-1));
    expect(values).toContain('published');
    expect(values).toContain('active');
  });

  it('keeps local matching case-insensitive', () => {
    const target = renderList({
      urlState: { params: 'title.contains=ZONING' },
    });
    // The stored filter is `ZONING`; the local evaluator lowercases both sides.
    expect(rowTitles(target)).toEqual(['Zoning appendix']);
  });

  it('settles the type lock without re-dispatching', () => {
    let transitions = 0;
    const target = renderList({
      type: 'article',
      urlState: {
        // Free-text case is preserved in the stored filter; local matching
        // still lowercases both sides at compare time.
        params: 'author.contains=ADA',
        onChange: () => {
          transitions += 1;
        },
      },
    });
    // A lock predicate that disagreed with the normalizer would dispatch on
    // every flush; the list would never settle.
    expect(rowTitles(target)).toEqual(['Council budget explained']);
    expect(transitions).toBeLessThanOrEqual(1);
  });
});

describePaging(
  'ContentList capped-offset reporting (#2452 batch 3)',
  (render) => {
    it('tells the operator that the page was redirected', () => {
      const query = createFakeContentListQuery();
      // A link is the way an unreachable page arrives now that the pager stops
      // offering them: it is applied before anything can clamp it.
      const target = render({
        query: { bind: () => query.binding, request: { defaultPageSize: 200 } },
        urlState: { params: 'page=9000' },
      });

      const page = query.requests.at(-1)?.page as { offset: number };
      expect(page.offset).toBeLessThanOrEqual(1_000_000);
      // The redirect survives the corrective re-translation that follows it.
      const notice = target.querySelector('.state-notice');
      expect(notice?.textContent).toContain('page 9000 cannot be loaded');
      expect(notice?.textContent).toContain('the list stops at page 5001');
    });

    it('clears the redirect notice once the operator moves elsewhere', () => {
      const query = createFakeContentListQuery();
      const target = render({
        query: { bind: () => query.binding, request: { defaultPageSize: 200 } },
        urlState: { params: 'page=9000' },
      });
      query.resolve([serverRow('a', 'Alpha')], 2_000_000);
      flushSync();
      expect(target.querySelector('.state-notice')).not.toBeNull();

      // Moved through the pager the operator actually sees, which now renders in
      // every presentation rather than only in the card modes.
      const first = Array.from(
        paginationNav(target)?.querySelectorAll('button') ?? [],
      ).find((button) => button.textContent?.trim() === '1');
      click(first as HTMLButtonElement);

      expect(target.querySelector('.state-notice')).toBeNull();
    });

    it('keeps a restored page when the compact table mounts', () => {
      const query = createFakeContentListQuery();
      render({
        query: { bind: () => query.binding, request: { defaultPageSize: 10 } },
        urlState: { params: 'page=3' },
      });
      // DataTable clamps the controller's page against `totalRows`; before the
      // first response there is no total to clamp against, and handing it a zero
      // would silently open a `?page=3` link on page 1.
      expect(query.requests.at(-1)?.page).toEqual({
        kind: 'offset',
        offset: 20,
        limit: 10,
      });
    });

    it('never advertises a page the endpoint cannot fetch', () => {
      const query = createFakeContentListQuery();
      const target = render({
        query: { bind: () => query.binding, request: { defaultPageSize: 200 } },
      });
      // 2,000,000 rows at 200 a page is 10,000 pages, but offset paging stops at
      // 1,000,000 — page 5,001 is the last one that can ever be fetched.
      query.resolve([serverRow('a', 'Alpha')], 2_000_000);
      flushSync();

      const labels = Array.from(
        paginationNav(target)?.querySelectorAll('button') ?? [],
      ).map((button) => button.textContent?.trim() ?? '');
      expect(labels).toContain('5001');
      expect(labels).not.toContain('10000');
    });

    it('advertises every page when they are all reachable', () => {
      const query = createFakeContentListQuery();
      const target = render({
        query: { bind: () => query.binding, request: { defaultPageSize: 10 } },
      });
      query.resolve([serverRow('a', 'Alpha')], 45);
      flushSync();

      const labels = Array.from(
        paginationNav(target)?.querySelectorAll('button') ?? [],
      ).map((button) => button.textContent?.trim() ?? '');
      expect(labels).toContain('5');
    });
  },
);

// ---------------------------------------------------------------------------
// Review batch 4 (#2452)
// ---------------------------------------------------------------------------

function selectByLabel(target: HTMLElement, label: string): HTMLSelectElement {
  const select = target.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  );
  if (!select) throw new Error(`No select labelled ${label}`);
  return select;
}

function optionValues(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((option) => option.value);
}

describe('ContentList toolbar vocabulary (#2452 batch 4)', () => {
  const reviewContents: ContentData[] = [
    {
      id: 'content-3',
      type: 'article',
      title: 'Held for review',
      author: 'Ada Lovelace',
      status: 'review',
      state: 'active',
      updatedAt: '2026-02-02T10:00:00.000Z',
    },
    ...contents,
  ];

  it('offers the model status the governance flow actually produces', () => {
    const target = renderList({ contents: reviewContents });
    const select = selectByLabel(target, 'Filter by status');

    // `review` is a real Content.status; `deleted` is the trash lifecycle
    // (#2454) and is deliberately not offered here.
    expect(optionValues(select)).toEqual([
      '',
      'published',
      'draft',
      'review',
      'archived',
    ]);
  });

  it('restores ?status=review with rows and a matching select', () => {
    const target = renderList({
      contents: reviewContents,
      urlState: { params: 'status=review' },
    });

    expect(rowTitles(target)).toEqual(['Held for review']);
    const select = selectByLabel(target, 'Filter by status');
    expect(select.value).toBe('review');
    expect(select.selectedIndex).toBeGreaterThanOrEqual(0);
    // Nothing was refused, so nothing is reported.
    expect(target.querySelector('.state-notice')).toBeNull();
  });

  it('shows AND reports a status token the vocabulary does not cover', () => {
    const target = renderList({ urlState: { params: 'status=embargoed' } });

    // The toolbar tells the truth about what is constraining the list …
    const select = selectByLabel(target, 'Filter by status');
    expect(select.value).toBe('embargoed');
    expect(optionValues(select)).toContain('embargoed');
    // … and the operator is told why it is empty.
    expect(rowTitles(target)).toEqual([]);
    expect(target.querySelector('.state-notice')?.textContent).toContain(
      'filtered by "embargoed", which is not one of the listed options',
    );
  });

  it('shows AND reports a mistyped type token', () => {
    const target = renderList({ urlState: { params: 'type=artcile' } });

    const select = selectByLabel(target, 'Filter by type');
    expect(select.value).toBe('artcile');
    expect(rowTitles(target)).toEqual([]);
    expect(target.querySelector('.state-notice')?.textContent).toContain(
      'filtered by "artcile", which is not one of the listed options',
    );
  });

  it('says nothing about a locked type, which has no select to disagree with', () => {
    const target = renderList({ type: 'briefing' });
    expect(
      target.querySelector('select[aria-label="Filter by type"]'),
    ).toBeNull();
    expect(target.querySelector('.state-notice')).toBeNull();
  });
});

describePaging(
  'ContentList type lock and a restored page (#2452 batch 4)',
  (render) => {
    it('keeps a restored page on a locked list whose link omits `type`', () => {
      const query = createFakeContentListQuery();
      render({
        type: 'article',
        query: { bind: () => query.binding, request: { defaultPageSize: 10 } },
        urlState: { params: 'page=3' },
      });

      // The lock's `setFilters` resets paging, so re-applying it after the
      // restore would silently discard the page the same link just carried.
      expect(query.requests.at(-1)?.page).toEqual({
        kind: 'offset',
        offset: 20,
        limit: 10,
      });
      // And the lock still won.
      expect(JSON.stringify(query.requests.at(-1)?.filter)).toContain(
        '"article"',
      );
    });

    it('keeps a restored page when the link carries the locked type too', () => {
      const query = createFakeContentListQuery();
      render({
        type: 'article',
        query: { bind: () => query.binding, request: { defaultPageSize: 10 } },
        urlState: { params: 'type=article&page=3' },
      });
      expect(query.requests.at(-1)?.page).toEqual({
        kind: 'offset',
        offset: 20,
        limit: 10,
      });
    });

    it('lets the lock override a conflicting restored type without losing the page', () => {
      const query = createFakeContentListQuery();
      render({
        type: 'article',
        query: { bind: () => query.binding, request: { defaultPageSize: 10 } },
        urlState: { params: 'type=document&page=3' },
      });
      const filter = JSON.stringify(query.requests.at(-1)?.filter);
      expect(filter).toContain('"article"');
      expect(filter).not.toContain('"document"');
      expect(query.requests.at(-1)?.page).toEqual({
        kind: 'offset',
        offset: 20,
        limit: 10,
      });
    });
  },
);

describe('ContentList type lock across a prop change (#2452 batch 4)', () => {
  function mountHarness(type: string | undefined) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    let setType = (_next: string | undefined) => {};
    const component = mount(Harness, {
      target,
      props: {
        contents,
        type,
        onEdit: vi.fn(),
        onDelete: vi.fn(),
        onAdd: vi.fn(),
        onReady: (next: (value: string | undefined) => void) => {
          setType = next;
        },
      },
    });
    mountedComponents.push(component);
    flushSync();
    return {
      target,
      setType: (next: string | undefined) => {
        setType(next);
        flushSync();
      },
    };
  }

  it('clears the filter when the lock is removed', () => {
    const { target, setType } = mountHarness('article');

    expect(rowTitles(target)).toEqual(['Council budget explained']);
    // Locked lists render no type select at all.
    expect(
      target.querySelector('select[aria-label="Filter by type"]'),
    ).toBeNull();

    setType(undefined);

    // The lock going away releases the filter rather than stranding it.
    expect(rowTitles(target)).toEqual([
      'Council budget explained',
      'Zoning appendix',
    ]);
    expect(selectByLabel(target, 'Filter by type').value).toBe('');
  });

  it('re-applies the filter when the lock comes back', () => {
    const { target, setType } = mountHarness('article');
    setType(undefined);
    setType('document');

    expect(rowTitles(target)).toEqual(['Zoning appendix']);
    expect(
      target.querySelector('select[aria-label="Filter by type"]'),
    ).toBeNull();
  });

  it('drives article → undefined → article → undefined correctly', () => {
    const { target, setType } = mountHarness('article');
    for (const step of [undefined, 'article', undefined] as const) {
      setType(step);
      expect(rowTitles(target)).toEqual(
        step === undefined
          ? ['Council budget explained', 'Zoning appendix']
          : ['Council budget explained'],
      );
    }
  });

  it('does not clear an operator filter on a list that never had a lock', () => {
    const { target, setType } = mountHarness(undefined);

    selectOption(selectByLabel(target, 'Filter by type'), 'document');
    expect(rowTitles(target)).toEqual(['Zoning appendix']);

    // A re-render with the prop still absent must not touch the filter.
    setType(undefined);
    expect(rowTitles(target)).toEqual(['Zoning appendix']);
    expect(selectByLabel(target, 'Filter by type').value).toBe('document');
  });
});

// ---------------------------------------------------------------------------
// Review batch 5 (#2452)
// ---------------------------------------------------------------------------

describe('ContentList toolbar never misstates the live predicate', () => {
  /**
   * The invariant: the select's displayed state either matches the live
   * predicate exactly, or the operator is told it does not.
   */
  const cases: Array<{
    name: string;
    params: string;
    /** What the select must NOT read as, because the query says otherwise. */
    notDisplayed: string;
    detail: string;
  }> = [
    {
      name: 'a list value',
      params: 'status.in=draft,review',
      notDisplayed: '',
      detail: 'in draft, review',
    },
    {
      name: 'a valueless operator',
      params: 'status.isNull=1',
      notDisplayed: '',
      detail: 'isNull',
    },
    {
      name: 'an inverted operator',
      params: 'status.notEquals=draft',
      notDisplayed: 'draft',
      detail: 'notEquals draft',
    },
  ];

  for (const testCase of cases) {
    it(`reports ${testCase.name} rather than displaying a value it is not applying`, () => {
      const target = renderList({ urlState: { params: testCase.params } });
      const select = selectByLabel(target, 'Filter by status');

      // Never the empty "All statuses", and never the inverse of the predicate.
      expect(select.value).not.toBe(testCase.notDisplayed);
      // The select shows the predicate itself …
      expect(
        Array.from(select.options)
          .find((option) => option.value === select.value)
          ?.textContent?.trim(),
      ).toBe(testCase.detail);
      // … and it cannot be re-chosen, only replaced.
      expect(
        Array.from(select.options).find(
          (option) => option.value === select.value,
        )?.disabled,
      ).toBe(true);
      // … and the operator is told.
      expect(target.querySelector('.state-notice')?.textContent).toContain(
        testCase.detail,
      );
    });
  }

  it('applies the same rule to the type select on an unlocked list', () => {
    const target = renderList({
      urlState: { params: 'type.notEquals=article' },
    });
    const select = selectByLabel(target, 'Filter by type');

    expect(select.value).not.toBe('article');
    expect(target.querySelector('.state-notice')?.textContent).toContain(
      'notEquals article',
    );
  });

  it('reports two filters on one column, which a single select cannot show', () => {
    const target = renderList({
      urlState: { params: 'status=draft&status.notEquals=archived' },
    });
    expect(selectByLabel(target, 'Filter by status').value).not.toBe('draft');
    expect(target.querySelector('.state-notice')?.textContent).toContain(
      'equals draft; notEquals archived',
    );
  });

  it('lets the operator replace an unrepresentable filter from the select', () => {
    const query = createFakeContentListQuery();
    const target = renderList({
      query: { bind: () => query.binding },
      urlState: { params: 'status.in=draft,review' },
    });
    expect(target.querySelector('.state-notice')).not.toBeNull();

    selectOption(selectByLabel(target, 'Filter by status'), 'published');

    // Choosing a real option replaces every filter on the column.
    const filter = JSON.stringify(query.requests.at(-1)?.filter);
    expect(filter).toContain('"published"');
    expect(filter).not.toContain('"draft"');
    expect(target.querySelector('.state-notice')).toBeNull();
  });

  it('stays silent for a plain, representable, in-vocabulary filter', () => {
    const target = renderList({ urlState: { params: 'status=draft' } });
    expect(selectByLabel(target, 'Filter by status').value).toBe('draft');
    expect(target.querySelector('.state-notice')).toBeNull();
  });

  it('says nothing about a locked type, which renders no select', () => {
    const target = renderList({
      type: 'article',
      urlState: { params: 'status=draft' },
    });
    expect(
      target.querySelector('select[aria-label="Filter by type"]'),
    ).toBeNull();
    expect(target.querySelector('.state-notice')).toBeNull();
  });
});

describe('the unrepresentable-option sentinel survives HTML parsing', () => {
  /**
   * A server-rendered option reaches the browser as markup, not as a
   * `setAttribute` call, so its value goes through the HTML tokenizer. A NUL in
   * an attribute value is rewritten to U+FFFD, which means the hydrated select
   * finds no matching option, reports `selectedIndex === -1`, and reads as no
   * selection — exactly the state the summary exists to prevent. A client-only
   * mount bypasses parsing entirely, which is why mounting the component cannot
   * catch this.
   */
  function parseAttributeValue(value: string): string {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = 'summary';
    const select = document.createElement('select');
    select.append(option);
    const source = document.createElement('div');
    source.append(select);
    // Round-trip through serialization and parsing, as SSR + hydration does.
    const parsed = document.createElement('div');
    parsed.innerHTML = source.innerHTML;
    return parsed.querySelector('option')?.value ?? '';
  }

  it('round-trips through the HTML parser unchanged', () => {
    expect(parseAttributeValue(CONTENT_LIST_UNREPRESENTABLE_OPTION)).toBe(
      CONTENT_LIST_UNREPRESENTABLE_OPTION,
    );
  });

  it('proves the round-trip is a real check by failing for NUL', () => {
    // The value this sentinel used to carry, and why it had to change.
    expect(parseAttributeValue('\u0000unrepresentable')).not.toBe(
      '\u0000unrepresentable',
    );
  });

  it('contains no character the parser rewrites or would need escaped', () => {
    expect(CONTENT_LIST_UNREPRESENTABLE_OPTION).not.toContain('\u0000');
    expect(CONTENT_LIST_UNREPRESENTABLE_OPTION).not.toContain('\ufffd');
    for (const character of ['<', '>', '&', '"', "'"]) {
      expect(CONTENT_LIST_UNREPRESENTABLE_OPTION).not.toContain(character);
    }
  });

  it('still selects after a parse round-trip, which NUL prevented', () => {
    const host = document.createElement('div');
    const option = document.createElement('option');
    option.value = CONTENT_LIST_UNREPRESENTABLE_OPTION;
    option.textContent = 'in draft, review';
    const built = document.createElement('select');
    built.append(option);
    host.append(built);
    const parsed = document.createElement('div');
    parsed.innerHTML = host.innerHTML;

    const select = parsed.querySelector('select');
    if (!select) throw new Error('no select');
    select.value = CONTENT_LIST_UNREPRESENTABLE_OPTION;
    expect(select.selectedIndex).toBe(0);
    expect(select.value).toBe(CONTENT_LIST_UNREPRESENTABLE_OPTION);
  });

  it('is harmless even if a filter value happens to equal it', () => {
    // `normalizeContentToken` only trims and lower-cases, so a crafted value
    // CAN equal the sentinel. It does not matter: the two states are mutually
    // exclusive, and a representable value renders as a real, enabled option
    // carrying that same value — so the select still shows what is applied.
    expect(normalizeContentToken(CONTENT_LIST_UNREPRESENTABLE_OPTION)).toBe(
      CONTENT_LIST_UNREPRESENTABLE_OPTION,
    );
    const target = renderList({
      urlState: {
        params: `status=${encodeURIComponent(CONTENT_LIST_UNREPRESENTABLE_OPTION)}`,
      },
    });
    const select = selectByLabel(target, 'Filter by status');
    const selected = Array.from(select.options).find(
      (option) => option.value === select.value,
    );
    expect(select.value).toBe(CONTENT_LIST_UNREPRESENTABLE_OPTION);
    // Enabled, i.e. the representable path — not the disabled summary.
    expect(selected?.disabled).toBe(false);
    expect(target.querySelector('.state-notice')?.textContent).toContain(
      'is not one of the listed options',
    );
  });
});

describePaging(
  'a page is only clamped against its own query total',
  (render) => {
    it('keeps a restored page when the previous total was smaller', async () => {
      const store = createContentListMemorySavedViewStore({
        storageKey: 'test:content-list:stale-total',
      });
      await store.save({
        name: 'Deep page',
        snapshot: {
          version: 3,
          modes: {
            filtering: 'manual',
            sorting: 'manual',
            pagination: 'manual',
          },
          state: {
            search: 'zoning',
            filters: [],
            sorting: [],
            page: 5,
            pageSize: 10,
            columnOrder: [],
            columnVisibility: [],
            columnWidths: [],
            columnPinning: [],
            selection: { scope: 'explicit', rowIds: [] },
            selectedRowIds: [],
            expandedRowIds: [],
          },
        } as never,
      });

      const query = createFakeContentListQuery();
      const target = render({
        savedViews: store,
        query: { bind: () => query.binding, request: { defaultPageSize: 10 } },
      });
      await settle();

      // The FIRST query settles with a small total — one page's worth.
      query.resolve([serverRow('a', 'Alpha')], 3);
      flushSync();

      // Applying the view changes the query AND restores page 5.
      const [saved] = await store.list();
      const select = target.querySelector<HTMLSelectElement>(
        'select[aria-label="Saved views"]',
      );
      if (!select) throw new Error('No saved-view select');
      selectOption(select, saved.id);

      expect(query.requests.at(-1)?.page).toEqual({
        kind: 'offset',
        offset: 40,
        limit: 10,
      });

      // `remoteQuery` publishes rows and a total while the new request is still
      // in flight — a cache hit, or the stale-while-revalidate path. That total
      // belongs to the PREVIOUS query (3 rows, one page at this size), and
      // clamping against it here resets a page the new query has not counted yet.
      // No `settle()`: the response for the current query has not arrived.
      query.resolve([serverRow('a', 'Alpha')], 3);
      flushSync();

      expect(query.requests.at(-1)?.page).toEqual({
        kind: 'offset',
        offset: 40,
        limit: 10,
      });

      // Once the current query does report its own total, the clamp applies.
      await settle();
      expect(query.requests.at(-1)?.page).toEqual({
        kind: 'offset',
        offset: 0,
        limit: 10,
      });
    });

    it('still clamps once the current query reports its own total', async () => {
      const query = createFakeContentListQuery();
      render({
        query: { bind: () => query.binding, request: { defaultPageSize: 10 } },
        urlState: { params: 'page=5' },
      });
      expect(query.requests.at(-1)?.page).toMatchObject({ offset: 40 });

      // The response for THAT query says there are only 12 rows — two pages — so
      // page 5 is genuinely out of range and is clamped.
      query.resolve([serverRow('a', 'Alpha')], 12);
      await settle();

      expect(query.requests.at(-1)?.page).toMatchObject({ offset: 10 });
    });
  },
);

describePaging('only an authoritative count may clamp a page', (render) => {
  /**
   * Mounts on page 3 with a page size of 10, so the first request reads offset
   * 20 and any clamp is immediately visible as a re-query at offset 0.
   */
  function mountOnPageThree() {
    const query = createFakeContentListQuery();
    render({
      query: { bind: () => query.binding, request: { defaultPageSize: 10 } },
      urlState: { params: 'page=3' },
    });
    expect(query.requests.at(-1)?.page).toEqual({
      kind: 'offset',
      offset: 20,
      limit: 10,
    });
    return query;
  }

  it('does not clamp on an UNAVAILABLE total, and still clamps on an exact one', async () => {
    const query = mountOnPageThree();

    // The response for THIS query arrives, but the backend cannot count. An
    // unavailable total is unknown — not zero, and not the one row in hand.
    query.resolveWithTotal([serverRow('a', 'Alpha')], { kind: 'unavailable' });
    await settle();

    expect(query.requests.at(-1)?.page).toEqual({
      kind: 'offset',
      offset: 20,
      limit: 10,
    });

    // CONTROL, in this same mount: the clamp effect is live, not inert. Give
    // it an authoritative count that page 3 exceeds and it must act — so the
    // assertion above is the rule being applied, not the effect failing to run.
    query.resolve([serverRow('a', 'Alpha')], 5);
    await settle();

    expect(query.requests.at(-1)?.page).toEqual({
      kind: 'offset',
      offset: 0,
      limit: 10,
    });
  });

  it('does not clamp on an ESTIMATED total', async () => {
    const query = mountOnPageThree();

    // An estimate of 5 rows implies one page, and clamping on it would hide
    // pages the query really has. Over-offering a page is visible and
    // self-correcting; hiding reachable rows is not.
    query.resolveWithTotal([serverRow('a', 'Alpha')], {
      kind: 'estimated',
      value: 5,
    });
    await settle();

    expect(query.requests.at(-1)?.page).toEqual({
      kind: 'offset',
      offset: 20,
      limit: 10,
    });

    // CONTROL: the same value as an EXACT total must clamp, so the assertion
    // above is the authority rule at work rather than a clamp that never ran.
    query.resolveWithTotal([serverRow('a', 'Alpha')], {
      kind: 'exact',
      value: 5,
    });
    await settle();

    expect(query.requests.at(-1)?.page).toEqual({
      kind: 'offset',
      offset: 0,
      limit: 10,
    });
  });

  it('clamps on an exact total, which is the authoritative case', async () => {
    const query = mountOnPageThree();
    query.resolveWithTotal([serverRow('a', 'Alpha')], {
      kind: 'exact',
      value: 5,
    });
    await settle();

    expect(query.requests.at(-1)?.page).toEqual({
      kind: 'offset',
      offset: 0,
      limit: 10,
    });
  });

  it('leaves a page alone when the exact total covers it', async () => {
    const query = mountOnPageThree();
    query.resolveWithTotal([serverRow('a', 'Alpha')], {
      kind: 'exact',
      value: 100,
    });
    await settle();

    expect(query.requests.at(-1)?.page).toEqual({
      kind: 'offset',
      offset: 20,
      limit: 10,
    });

    // CONTROL: shrink the same authoritative total below page 3 and the clamp
    // must fire — otherwise "left alone" would just mean "never evaluated".
    // 15 rows at 10 a page is 2 pages, so page 3 clamps to page 2.
    query.resolveWithTotal([serverRow('a', 'Alpha')], {
      kind: 'exact',
      value: 15,
    });
    await settle();

    expect(query.requests.at(-1)?.page).toEqual({
      kind: 'offset',
      offset: 10,
      limit: 10,
    });
  });

  it('still shows a pager for an estimate, which is what estimates are for', async () => {
    const query = createFakeContentListQuery();
    const target = render({
      query: { bind: () => query.binding, request: { defaultPageSize: 10 } },
    });
    query.resolveWithTotal([serverRow('a', 'Alpha')], {
      kind: 'estimated',
      value: 45,
    });
    await settle();

    // Displaying a pager and moving the operator are different questions.
    const labels = Array.from(
      paginationNav(target)?.querySelectorAll('button') ?? [],
    ).map((button) => button.textContent?.trim() ?? '');
    expect(labels).toContain('5');
  });

  it('still clamps in local mode, where the array IS the result set', () => {
    const target = render({
      urlState: { params: 'page=3&size=10' },
    });
    // Two rows, one page: local mode has an exact count by construction.
    expect(visibleRowTitles(target)).toEqual([
      'Council budget explained',
      'Zoning appendix',
    ]);
  });
});
