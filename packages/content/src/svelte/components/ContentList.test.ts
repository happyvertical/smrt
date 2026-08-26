// @vitest-environment jsdom

import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentData } from '../../mock-smrt-client.js';
import { ContentListQueryError } from '../content-list-query.js';
import { createContentListMemorySavedViewStore } from '../content-list-saved-views.js';
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

  it('pages against the server total rather than the rendered page', () => {
    const query = createFakeContentListQuery();
    const target = renderList({
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
