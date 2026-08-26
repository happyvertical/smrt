// @vitest-environment jsdom

import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentData } from '../../mock-smrt-client.js';
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
