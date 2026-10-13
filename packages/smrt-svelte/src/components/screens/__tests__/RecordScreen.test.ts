import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordOverview } from '../../overview/record.js';
import type { WidgetLoadContext } from '../../overview/types.js';
import RecordScreen from '../RecordScreen.svelte';
import type { ScreenRelation } from '../relations.js';
import { taskDefinition, taskPolicy, taskRows } from './fixtures.js';

const relations: ScreenRelation[] = [
  {
    model: '@acme/tasks:Comment',
    field: 'taskId',
    label: 'Comments',
    kind: 'children',
  },
  {
    model: '@acme/users:User',
    field: 'ownerId',
    label: 'Owner',
    kind: 'reference',
  },
];

function stubViewport(desktop: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width') ? desktop : !desktop,
    addEventListener() {},
    removeEventListener() {},
  }));
}

function loaders() {
  const seen: WidgetLoadContext[] = [];
  return {
    seen,
    loaders: {
      metric: (_options: unknown, ctx: WidgetLoadContext) => {
        seen.push(ctx);
        return { value: 3 };
      },
      records: (_options: unknown, ctx: WidgetLoadContext) => {
        seen.push(ctx);
        return {
          rows: [{ id: 'c1', title: `Comment on ${ctx.record?.id}` }],
          total: 3,
        };
      },
    },
  };
}

function mount(extra: Record<string, unknown> = {}) {
  const l = loaders();
  const result = render(RecordScreen, {
    props: {
      definition: taskDefinition,
      policy: taskPolicy,
      record: taskRows[0],
      relations,
      mode: 'view' as const,
      loaders: l.loaders,
      widgetContext: { fetch: 'host-fetch' },
      viewAllHref: (relation: ScreenRelation) => `/tasks/t-1/${relation.field}`,
      hrefFor: (_field: unknown, id: string) => `/users/${id}`,
      labels: { '@acme/users:User': () => 'Ada' },
      locale: 'en-US',
      ...extra,
    },
  });
  return { ...result, ...l };
}

beforeEach(() => stubViewport(true));
afterEach(() => vi.unstubAllGlobals());

describe('RecordScreen (view)', () => {
  it('renders the detail, the default related panels with the record context, and View all links', async () => {
    const { seen } = mount();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Write docs' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ada' })).toHaveAttribute(
      'href',
      `/users/${taskRows[0].ownerId}`,
    );

    // one records panel for the single children relation, headed with its
    // count and its one View all; the body repeats neither
    expect(await screen.findByText('Comment on t-1')).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 2 });
    const panels = headings.filter((h) => h.textContent?.includes('Comments'));
    expect(panels).toHaveLength(1);
    expect(panels[0]).toHaveTextContent(/Comments · 3/);
    const viewAll = screen.getAllByRole('link', { name: 'View all' });
    expect(viewAll).toHaveLength(1);
    expect(viewAll[0]).toHaveAttribute('href', '/tasks/t-1/taskId');
    expect(panels[0]).toContainElement(viewAll[0]);
    expect(screen.queryByText('3 in total')).toBeNull();

    // every loader saw the record context and the host capabilities
    expect(seen).toHaveLength(1);
    for (const ctx of seen) {
      expect(ctx.record).toEqual({ model: '@acme/tasks:Task', id: 't-1' });
      expect(ctx.overviewId).toBe('detail:acme.tasks.Task');
      expect(ctx.fetch).toBe('host-fetch');
      expect(ctx.locale).toBe('en-US');
    }
    expect(screen.queryByRole('form')).toBeNull();
    expect(document.querySelector('[data-testid="phone-sheet"]')).toBeNull();
  });

  it("falls back to the loader's href for View all, and keeps a paired metric without one", async () => {
    mount({
      viewAllHref: undefined,
      overview: recordOverview(taskDefinition, relations, { metrics: true }),
      loaders: {
        metric: () => ({ value: 3, href: '/comments?task=t-1' }),
        records: () => ({
          rows: [{ id: 'c1', title: 'First comment' }],
          total: 1,
          href: '/comments?task=t-1',
        }),
      },
    });
    expect(await screen.findByText('First comment')).toBeInTheDocument();
    const panels = screen
      .getAllByRole('heading', { level: 2 })
      .filter((h) => h.textContent?.includes('Comments'));
    expect(panels).toHaveLength(2);
    const viewAll = screen.getAllByRole('link', { name: 'View all' });
    expect(viewAll).toHaveLength(1);
    expect(viewAll[0]).toHaveAttribute('href', '/comments?task=t-1');
    expect(panels[0]).not.toContainElement(viewAll[0]);
    expect(panels[1]).toContainElement(viewAll[0]);
  });

  it('reloads the panels when the record changes', async () => {
    const { rerender, seen } = mount();
    await screen.findByText('Comment on t-1');
    await rerender({ record: taskRows[1] });
    expect(await screen.findByText('Comment on t-2')).toBeInTheDocument();
    expect(seen.at(-1)?.record).toEqual({
      model: '@acme/tasks:Task',
      id: 't-2',
    });
  });

  it('offers Edit in view mode and calls onedit', async () => {
    const onedit = vi.fn();
    mount({ onedit });
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onedit).toHaveBeenCalledOnce();
  });

  it('is axe-clean', async () => {
    const { container } = mount();
    await screen.findByText('Comment on t-1');
    await expectNoA11yViolations(container);
  });
});

describe('RecordScreen (edit)', () => {
  it('on desktop renders the form beside the detail and saves through onsave', async () => {
    const onsave = vi.fn();
    const oncancel = vi.fn();
    const { container } = mount({
      mode: 'edit',
      onsave,
      oncancel,
      onedit: vi.fn(),
    });
    expect(container.querySelector('.smrt-record-screen--edit')).not.toBeNull();
    const aside = screen.getByRole('complementary', { name: 'Edit task' });
    expect(within(aside).getByLabelText(/Task name/)).toHaveValue('Write docs');
    // the detail header hides its Edit action while editing
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(document.querySelector('[data-testid="phone-sheet"]')).toBeNull();

    await userEvent.clear(within(aside).getByLabelText(/Task name/));
    await userEvent.type(within(aside).getByLabelText(/Task name/), 'Edited');
    await userEvent.click(within(aside).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onsave).toHaveBeenCalledOnce());
    expect(onsave.mock.calls[0][0]).toMatchObject({ title: 'Edited' });

    await userEvent.click(
      within(aside).getByRole('button', { name: 'Cancel' }),
    );
    expect(oncancel).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it('on a phone renders the form in a page sheet whose close calls oncancel', async () => {
    stubViewport(false);
    const oncancel = vi.fn();
    const { container } = mount({ mode: 'edit', onsave: vi.fn(), oncancel });
    const sheet = await waitFor(() => {
      const node = document.querySelector('[data-testid="phone-sheet"]');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    await waitFor(() => expect(sheet).toHaveClass('open'));
    expect(within(sheet).getByLabelText(/Task name/)).toHaveValue('Write docs');
    expect(screen.queryByRole('complementary')).toBeNull();

    await userEvent.click(
      within(sheet).getByRole('button', { name: 'Close Edit task' }),
    );
    expect(oncancel).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it('on a phone keeps the sheet closed in view mode', async () => {
    stubViewport(false);
    mount();
    await waitFor(() => {
      const sheet = document.querySelector('[data-testid="phone-sheet"]');
      expect(sheet).not.toBeNull();
      expect(sheet).not.toHaveClass('open');
    });
    expect(screen.queryByLabelText(/Task name/)).toBeNull();
  });
});

describe('RecordScreen (overview)', () => {
  it('uses an explicit overview and hands layout edits to onoverviewchange', async () => {
    const onoverviewchange = vi.fn();
    mount({
      overview: {
        id: 'tasks.detail',
        defaults: [
          {
            id: 'w1',
            type: 'records',
            span: 4,
            options: {
              title: 'Latest',
              model: '@acme/tasks:Comment',
              filter: 'parent',
              field: 'taskId',
            },
          },
        ],
      },
      override: null,
      onoverviewchange,
      layoutEditing: true,
    });
    expect(await screen.findByText('Comment on t-1')).toBeInTheDocument();
    expect(screen.getAllByText('Latest').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /Remove/ }));
    await waitFor(() => expect(onoverviewchange).toHaveBeenCalledOnce());
    expect(onoverviewchange.mock.calls[0][0]).toMatchObject({
      removed: ['w1'],
    });
  });

  it('renders no panels without loaders', () => {
    mount({ loaders: undefined });
    expect(
      screen.getByText('There are no widgets on this overview yet.'),
    ).toBeInTheDocument();
  });
});
