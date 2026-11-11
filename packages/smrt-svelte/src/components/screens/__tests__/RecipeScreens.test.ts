import type { Cookbook } from '@happyvertical/smrt-types';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CookbookHarness from '../../cookbook/__tests__/app-harness.svelte';
import type { CookbookCatalog } from '../../cookbook/types.js';
import RecipeScreens from '../RecipeScreens.svelte';
import type { RecipeScreensSource, ScreenRecord } from '../types.js';
import { taskDefinition, taskPolicy, taskRows } from './fixtures.js';

function memorySource(
  initial: ScreenRecord[] = taskRows,
): RecipeScreensSource & {
  rows: ScreenRecord[];
} {
  const state = { rows: [...initial] };
  return {
    get rows() {
      return state.rows;
    },
    list: vi.fn(async () => [...state.rows]),
    create: vi.fn(async (values) => {
      const created = { id: 't-new', ...values };
      state.rows = [...state.rows, created];
      return created;
    }),
    update: vi.fn(async (id, values) => {
      state.rows = state.rows.map((r) =>
        r.id === id ? { ...r, ...values } : r,
      );
      return state.rows.find((r) => r.id === id);
    }),
    delete: vi.fn(async (id) => {
      state.rows = state.rows.filter((r) => r.id !== id);
    }),
  };
}

describe('RecipeScreens', () => {
  it('lists, views, edits and deletes through the source', async () => {
    const source = memorySource();
    const onnavigate = vi.fn();
    render(RecipeScreens, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        source,
        onnavigate,
        locale: 'en-US',
      },
    });

    expect(await screen.findByText('Write docs')).toBeInTheDocument();

    // list -> view
    await userEvent.click(screen.getByText('Write docs'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Write docs' }),
    ).toBeInTheDocument();
    expect(onnavigate).toHaveBeenLastCalledWith('view', 't-1');

    // view -> edit -> save -> back to view with the new value
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const title = await screen.findByLabelText(/Task name/);
    await userEvent.clear(title);
    await userEvent.type(title, 'Write better docs');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Write better docs',
      }),
    ).toBeInTheDocument();
    expect(source.update).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ title: 'Write better docs' }),
    );

    // view -> delete (in the overflow menu) -> list
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Delete' }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tasks' }),
    ).toBeInTheDocument();
    expect(source.delete).toHaveBeenCalledWith('t-1');
    expect(screen.queryByText('Write better docs')).not.toBeInTheDocument();
  });

  it('creates a record and lands on its view', async () => {
    const source = memorySource([]);
    render(RecipeScreens, {
      props: { definition: taskDefinition, policy: taskPolicy, source },
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'New task' }),
    );
    await userEvent.type(await screen.findByLabelText(/Task name/), 'Fresh');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Fresh' }),
    ).toBeInTheDocument();
    expect(source.create).toHaveBeenCalledOnce();
  });

  it('a read-only source (and can flags) yields a read-only screen set', async () => {
    const readOnly: RecipeScreensSource = { list: async () => taskRows };
    render(RecipeScreens, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        source: readOnly,
      },
    });
    expect(await screen.findByText('Write docs')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'New task' }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('Write docs'));
    await screen.findByRole('heading', { level: 1, name: 'Write docs' });
    expect(
      screen.queryByRole('button', { name: 'Edit' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete' }),
    ).not.toBeInTheDocument();
  });

  it('opens at a controlled view and reports a missing record', async () => {
    const source = memorySource();
    render(RecipeScreens, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        source,
        view: 'view',
        recordId: 'gone',
      },
    });
    expect(
      await screen.findByText('This record no longer exists.'),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Back to tasks' }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tasks' }),
    ).toBeInTheDocument();
  });

  it('resolves the record through source.get when provided', async () => {
    const source = memorySource();
    const get = vi.fn(async (id: string) => taskRows.find((r) => r.id === id));
    render(RecipeScreens, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        source: { ...source, get },
        view: 'view',
        recordId: 't-2',
      },
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ship release' }),
    ).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('t-2');
  });

  it('shows a retryable load error', async () => {
    const list = vi
      .fn<() => Promise<readonly ScreenRecord[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(taskRows);
    render(RecipeScreens, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        source: { list },
      },
    });
    expect(
      await screen.findByText('Could not load this data.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Write docs')).toBeInTheDocument();
  });
});

// The shell receives the policy engine's resolved output, never raw rows.
const fixtureCookbook: Cookbook = {
  $schema: '',
  version: 1,
  recipes: ['tasks'],
  features: [],
  policies: [],
  layout: { version: 1, items: { 'item:tasks:Task': { label: 'Customers' } } },
};
const fixtureCatalog: CookbookCatalog = {
  models: [
    {
      id: taskDefinition.objectRef,
      name: 'Task',
      packageId: 'tasks',
      exposed: true,
    },
  ],
  recipes: [
    {
      id: 'tasks',
      label: 'Work',
      models: [taskDefinition.objectRef],
      nav: [{ model: taskDefinition.objectRef, label: 'Tasks', noun: 'Task' }],
    },
  ],
};
const fixturePolicy = {
  ...taskPolicy,
  fields: {
    ...taskPolicy.fields,
    title: { ...taskPolicy.fields.title, label: 'Customer name' },
    reference: {
      visibility: 'hidden' as const,
      hasDefault: true,
      defaultValue: 'USD',
    },
    priority: { ...taskPolicy.fields.priority, readOnly: true },
  },
};

describe('cookbook screen context', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
  });
  afterEach(() => vi.unstubAllGlobals());
  function fixture(
    source: RecipeScreensSource,
    view: 'list' | 'create' | 'edit' = 'list',
  ) {
    return render(CookbookHarness, {
      cookbook: fixtureCookbook,
      catalog: fixtureCatalog,
      sectionId: 'section:tasks',
      fieldPolicies: { [taskDefinition.objectRef]: fixturePolicy },
      screenProps: {
        definition: taskDefinition,
        source,
        view,
        ...(view === 'edit' ? { recordId: 't-1' } : {}),
      },
    });
  }

  it('uses the collection rename in navigation, titles, actions and record back links', async () => {
    fixture(memorySource());
    expect(
      await screen.findByRole('heading', { name: 'Customers', level: 1 }),
    ).toBeInTheDocument();
    expect(
      document.querySelector(
        '[data-smrt-component="TenantNav"] a[href="/m/tasks/Task/"]',
      )?.textContent,
    ).toContain('Customers');
    expect(
      screen.queryByRole('link', { name: 'Tasks' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: /Customer name/ }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'New customers' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'New customers', level: 1 }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(await screen.findByText('Write docs'));
    expect(
      await screen.findByRole('button', { name: 'Back to customers' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(
      await screen.findByRole('heading', { name: 'Edit customers' }),
    ).toBeInTheDocument();
  });

  it('applies create defaults including hidden values without exposing a hidden control', async () => {
    const source = memorySource([]);
    fixture(source, 'create');
    await userEvent.type(
      await screen.findByLabelText(/Customer name/),
      'Fresh customer',
    );
    expect(screen.getByLabelText('Priority')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Priority')).toHaveValue('5');
    expect(screen.queryByLabelText('Reference')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(source.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Fresh customer',
        reference: 'USD',
        priority: 5,
      }),
    );
  });

  it('omits hidden and read-only values on edit and preserves them in the saved record', async () => {
    const source = memorySource([
      { ...taskRows[0], reference: 'KEEP', priority: 99 },
    ]);
    fixture(source, 'edit');
    const name = await screen.findByLabelText(/Customer name/);
    expect(screen.getByLabelText('Priority')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Priority')).toHaveValue('99');
    expect(screen.queryByText('KEEP')).not.toBeInTheDocument();
    await userEvent.clear(name);
    await userEvent.type(name, 'Changed');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(source.update).toHaveBeenCalledWith(
      't-1',
      expect.not.objectContaining({ reference: expect.anything() }),
    );
    expect(source.update).toHaveBeenCalledWith(
      't-1',
      expect.not.objectContaining({ priority: expect.anything() }),
    );
    expect(source.rows[0]).toMatchObject({
      title: 'Changed',
      reference: 'KEEP',
      priority: 99,
    });
    expect(screen.queryByText('KEEP')).not.toBeInTheDocument();
  });

  it('does not search hidden values on the list', async () => {
    const source = memorySource([
      { ...taskRows[0], reference: 'private-search-value' },
    ]);
    fixture(source);
    await screen.findByText('Write docs');
    const search = screen.getByRole('searchbox', { name: 'Search customers' });
    await userEvent.type(search, 'private-search-value');
    await vi.waitFor(() =>
      expect(screen.queryByText('Write docs')).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('columnheader', { name: 'Reference' }),
    ).not.toBeInTheDocument();
  });
});
