import { createCookbookEngine } from '@happyvertical/smrt-core/cookbook/engine';
import {
  createCookbookRuntimeExposure,
  filterRuntimeCookbookSnapshot,
  filterRuntimeExposure,
  setRuntimeExposureGate,
} from '@happyvertical/smrt-core/runtime-exposure';
import type { Cookbook } from '@happyvertical/smrt-types';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CookbookHarness from '../../cookbook/__tests__/app-harness.svelte';
import surfaceManifest from '../../cookbook/__tests__/surface-package/manifest.json';
import type { CookbookCatalog, CookbookRecipe } from '../../cookbook/types.js';
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

describe('installed recipe end-to-end fixture', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
  });
  afterEach(() => vi.unstubAllGlobals());
  const currencyDefinition: typeof taskDefinition = {
    ...taskDefinition,
    fields: {
      ...taskDefinition.fields,
      currency: {
        type: 'text',
        default: 'CAD',
        ui: { basic: true, widget: 'currency' },
      },
    },
  };
  const cookbook: Cookbook = {
    $schema: '',
    version: 1,
    recipes: surfaceManifest.recipes.map((r) => r.id),
    features: [],
    policies: [
      {
        objectRef: taskDefinition.objectRef,
        fieldName: 'currency',
        scopeType: 'app',
        defaultValue: '"USD"',
      },
      {
        objectRef: taskDefinition.objectRef,
        fieldName: 'reference',
        scopeType: 'app',
        visibility: 'hidden',
        defaultValue: '"USD"',
      },
      {
        objectRef: taskDefinition.objectRef,
        fieldName: 'title',
        scopeType: 'app',
        label: 'Customer name',
      },
      {
        objectRef: taskDefinition.objectRef,
        fieldName: 'priority',
        scopeType: 'app',
        readOnly: true,
        defaultValue: '7',
      },
    ],
    layout: {
      version: 1,
      items: { 'item:tasks:Task': { label: 'Customers' } },
    },
  };
  const catalog: CookbookCatalog = {
    models: fixtureCatalog.models,
    recipes: surfaceManifest.recipes as CookbookRecipe[],
  };

  it('renders an installed package surface with raw policies and no host resolver or resolved policy map', async () => {
    const source = memorySource([]);
    render(CookbookHarness, {
      cookbook,
      catalog,
      sectionId: 'section:fixture.surface',
      screenProps: { definition: currencyDefinition, source },
    });
    expect(
      await screen.findByTestId('installed-recipe-surface'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'New customers' }),
    ).toBeInTheDocument();
    const name = screen.getByLabelText(/Customer name/);
    expect(screen.getByLabelText('Currency')).toHaveValue('USD');
    expect(screen.queryByLabelText('Reference')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Priority')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Priority')).toHaveValue('7');
    expect(
      document.querySelector(
        '[data-smrt-component="TenantNav"] a[href="/m/tasks/Task/"]',
      )?.textContent,
    ).toContain('Customers');
    await userEvent.type(name, 'Maya');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(source.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Maya',
        currency: 'USD',
        reference: 'USD',
        priority: 7,
      }),
    );
  });

  it('relabels/hides a projected Profile name from raw policies while keeping virtual values out of writes', async () => {
    const definition = {
      ...currencyDefinition,
      displayLabelField: 'displayLabel',
      displayLabelProjection: {
        via: 'profileId',
        field: 'name',
        fallback: 'Unnamed customer',
      },
      fields: {
        ...currencyDefinition.fields,
        displayLabel: {
          type: 'text' as const,
          readonly: true,
          ui: { basic: true },
        },
      },
    };
    const source = memorySource([
      { ...taskRows[0], displayLabel: 'Maya Projected' },
    ]);
    const raw = {
      ...cookbook,
      recipes: ['fixture.generic'],
      layout: {
        version: 1 as const,
        items: { 'item:tasks:Task:generic': { label: 'Customers' } },
      },
      policies: [
        ...cookbook.policies,
        {
          objectRef: definition.objectRef,
          fieldName: 'displayLabel',
          scopeType: 'app' as const,
          label: 'Client name',
          readOnly: false,
        },
      ],
    };
    const props = {
      cookbook: raw,
      catalog,
      sectionId: 'section:fixture.generic',
      screenProps: { definition, source },
    };
    const mounted = render(CookbookHarness, props);
    expect(
      await screen.findByRole('columnheader', { name: /Client name/ }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Maya Projected')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'New customers' }),
    );
    expect(screen.queryByLabelText(/Client name/)).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Customer name/), 'New');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(source.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ displayLabel: expect.anything() }),
    );
    await mounted.rerender({
      ...props,
      screenProps: { ...props.screenProps, view: 'list' },
      cookbook: {
        ...raw,
        policies: [
          ...raw.policies,
          { ...raw.policies.at(-1)!, visibility: 'hidden' },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(
        screen.queryByRole('columnheader', { name: /Client name/ }),
      ).not.toBeInTheDocument(),
    );
    await screen.findByText('Write docs');
    expect(screen.queryByText('Maya Projected')).not.toBeInTheDocument();
  });

  it('keeps installed surfaces, collection vocabulary and provider policies for a manifest-proven app replacement', async () => {
    const source = memorySource([]);
    const definition = {
      ...currencyDefinition,
      objectRef: '@fixture/app:Task',
      replacedQualifiedNames: [taskDefinition.objectRef],
    };
    render(CookbookHarness, {
      cookbook: {
        ...cookbook,
        policies: [
          {
            objectRef: definition.objectRef,
            fieldName: 'title',
            scopeType: 'app',
            label: 'App customer name',
          },
          ...cookbook.policies,
        ],
      },
      catalog,
      sectionId: 'section:fixture.surface',
      screenProps: { definition, source },
    });
    await screen.findByTestId('installed-recipe-surface');
    expect(
      screen.getByRole('heading', { name: 'New customers' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Currency')).toHaveValue('USD');
    expect(screen.queryByLabelText('Reference')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Priority')).toHaveAttribute('readonly');
    await userEvent.type(
      screen.getByLabelText(/App customer name/),
      'App Maya',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(source.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'App Maya',
        reference: 'USD',
        currency: 'USD',
        priority: 7,
      }),
    );
  });

  it('removes a lazy recipe surface and navigation when the host refreshes the live exposure projection', async () => {
    const engineCatalog = {
      ...catalog,
      recipes: catalog.recipes.map((recipe) => ({
        ...recipe,
        requires: recipe.requires ?? [],
      })),
    };
    const engine = createCookbookEngine({
      catalog: engineCatalog,
      cookbook: {
        ...cookbook,
        $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
      },
    });
    const originalCookbook = engine.cookbook();
    let preference = true;
    const gate = createCookbookRuntimeExposure({
      catalog: engineCatalog,
      engineFor: () => engine,
      predicate: () => preference,
    });
    setRuntimeExposureGate(gate);
    const source = memorySource([]);
    const project = () => {
      const snapshot = filterRuntimeCookbookSnapshot(
        engine.snapshot(),
        engineCatalog,
        { tenantId: 'owner-a' },
      );
      const definitions = filterRuntimeExposure(
        [currencyDefinition],
        (definition) => definition.objectRef,
        { tenantId: 'owner-a', surface: 'screen' },
      );
      return {
        cookbook: {
          ...engine.cookbook(),
          recipes: snapshot.recipes.map((recipe) => recipe.id),
          features: snapshot.features,
        },
        catalog,
        sectionId: 'section:fixture.surface',
        screenProps: definitions[0]
          ? { definition: definitions[0], source }
          : undefined,
      };
    };
    try {
      const mounted = render(CookbookHarness, project());
      await screen.findByTestId('installed-recipe-surface');
      const loaded = vi.mocked(source.list).mock.calls.length;
      preference = false;
      await mounted.rerender(project());
      await vi.waitFor(() =>
        expect(
          screen.queryByTestId('installed-recipe-surface'),
        ).not.toBeInTheDocument(),
      );
      expect(
        document.querySelector(
          '[data-smrt-component="TenantNav"] a[href="/m/tasks/Task/"]',
        ),
      ).toBeNull();
      expect(source.list).toHaveBeenCalledTimes(loaded);
      expect(engine.cookbook()).toEqual(originalCookbook);
      preference = true;
      await mounted.rerender(project());
      await screen.findByTestId('installed-recipe-surface');
      mounted.unmount();
    } finally {
      setRuntimeExposureGate(undefined);
      gate.dispose();
    }
  });

  it.each([
    'create',
    'edit',
  ] as const)('keeps hidden/read-only cookbook reference policies in the %s picker', async (view) => {
    const id = 'dd44cefa-5dfe-4133-bb8e-26796c288207';
    const hiddenId = 'cad90120-86e4-4ca0-9e0f-96c304f94974';
    const people = {
      name: 'people',
      objectRef: '@fixture/people:Person',
      className: 'Person',
      displayLabelField: 'name',
      fields: { name: { type: 'text' as const } },
    };
    const get = vi.fn(async () => ({ id, name: 'Ada Lovelace' }));
    const search = vi.fn(async () => ({ rows: [], hasMore: false }));
    const definition = {
      ...currencyDefinition,
      fields: {
        ...currencyDefinition.fields,
        customerId: { type: 'crossPackageRef' as const },
        approverId: { type: 'foreignKey' as const },
      },
      relationships: [
        {
          field: 'customerId',
          kind: 'crossPackageRef' as const,
          relatedCollection: 'people',
        },
        {
          field: 'approverId',
          kind: 'foreignKey' as const,
          relatedCollection: 'people',
        },
      ],
    };
    const source = memorySource([
      { ...taskRows[0], customerId: hiddenId, approverId: id },
    ]);
    const mounted = render(CookbookHarness, {
      cookbook: {
        ...cookbook,
        policies: [
          ...cookbook.policies,
          {
            objectRef: definition.objectRef,
            fieldName: 'customerId',
            scopeType: 'app',
            visibility: 'hidden',
            defaultValue: JSON.stringify(hiddenId),
          },
          {
            objectRef: definition.objectRef,
            fieldName: 'approverId',
            scopeType: 'app',
            readOnly: true,
            label: 'Verified by',
            defaultValue: JSON.stringify(id),
          },
        ],
      },
      catalog,
      sectionId: 'section:fixture.generic',
      screenProps: {
        definition,
        source,
        view,
        recordId: view === 'edit' ? 't-1' : null,
        references: {
          people: {
            definition: people,
            source: { list: vi.fn(async () => []), get, search },
          },
        },
      },
    });
    expect(screen.queryByLabelText(/Customer id/)).not.toBeInTheDocument();
    const picker = await screen.findByRole('combobox', { name: /Verified by/ });
    await vi.waitFor(() => expect(picker).toHaveValue('Ada Lovelace'));
    expect(picker).toBeDisabled();
    expect(search).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith(id);
    expect(get).not.toHaveBeenCalledWith(hiddenId);
    const title = screen.getByLabelText(/Customer name/);
    await userEvent.clear(title);
    await userEvent.type(title, 'Reference customer');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    if (view === 'create')
      expect(source.create).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: hiddenId, approverId: id }),
      );
    else {
      expect(source.update).toHaveBeenCalledWith(
        't-1',
        expect.not.objectContaining({ approverId: expect.anything() }),
      );
      expect(source.update).toHaveBeenCalledWith(
        't-1',
        expect.not.objectContaining({ customerId: expect.anything() }),
      );
      expect(source.rows[0]).toMatchObject({
        customerId: hiddenId,
        approverId: id,
      });
    }
    mounted.unmount();
  });

  it.each([
    'generic',
    'missing',
  ])('falls back to generic screens for a %s surface', async (key) => {
    render(CookbookHarness, {
      cookbook,
      catalog,
      sectionId: `section:fixture.${key}`,
      screenProps: {
        definition: currencyDefinition,
        source: memorySource(),
        entryId: `item:tasks:Task:${key}`,
      },
    });
    expect(await screen.findByText('Write docs')).toBeInTheDocument();
    expect(
      screen.queryByTestId('installed-recipe-surface'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: /Customer name/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: /Reference/ }),
    ).not.toBeInTheDocument();
  });

  it.each([
    'list',
    'detail',
    'record',
  ] as const)('applies raw hidden policies to standalone %s screens', async (standalone) => {
    render(CookbookHarness, {
      cookbook,
      catalog,
      sectionId: 'section:fixture.surface',
      standalone,
      standaloneRecord: { ...taskRows[0], reference: 'KEEP_PRIVATE' },
      screenProps: { definition: currencyDefinition, source: memorySource() },
    });
    expect((await screen.findAllByText('Write docs')).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText('KEEP_PRIVATE')).not.toBeInTheDocument();
    expect(screen.queryByText('Reference')).not.toBeInTheDocument();
  });

  it('applies raw defaults and read-only metadata to a standalone create form', async () => {
    const source = memorySource([]);
    render(CookbookHarness, {
      cookbook,
      catalog,
      sectionId: 'section:fixture.surface',
      standalone: 'form',
      screenProps: { definition: currencyDefinition, source },
    });
    expect(screen.getByLabelText('Currency')).toHaveValue('USD');
    expect(screen.getByLabelText('Priority')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Priority')).toHaveValue('7');
    expect(screen.queryByLabelText('Reference')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Customer name/), 'Standalone');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(source.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Standalone',
        currency: 'USD',
        priority: 7,
        reference: 'USD',
      }),
    );
  });

  it('preserves existing hidden/read-only values and does not apply create defaults in a standalone edit', async () => {
    const row = {
      ...taskRows[0],
      currency: 'CAD',
      priority: 99,
      reference: 'KEEP_PRIVATE',
    };
    const source = memorySource([row]);
    render(CookbookHarness, {
      cookbook,
      catalog,
      sectionId: 'section:fixture.surface',
      standalone: 'form',
      standaloneRecord: row,
      screenProps: { definition: currencyDefinition, source },
    });
    expect(screen.getByLabelText('Currency')).toHaveValue('CAD');
    expect(screen.getByLabelText('Budget (CAD)')).toBeInTheDocument();
    expect(screen.getByLabelText('Priority')).toHaveValue('99');
    expect(screen.queryByText('KEEP_PRIVATE')).not.toBeInTheDocument();
    const name = screen.getByLabelText(/Customer name/);
    await userEvent.clear(name);
    await userEvent.type(name, 'Changed');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(source.rows[0]).toMatchObject({
      title: 'Changed',
      currency: 'CAD',
      priority: 99,
      reference: 'KEEP_PRIVATE',
    });
    expect(source.update).toHaveBeenCalledWith(
      't-1',
      expect.not.objectContaining({ reference: expect.anything() }),
    );
    expect(source.update).toHaveBeenCalledWith(
      't-1',
      expect.not.objectContaining({ priority: expect.anything() }),
    );
  });

  it('uses the resolved currency default for exact money conversion', async () => {
    const source = memorySource([]);
    const kwd = {
      ...cookbook,
      policies: cookbook.policies.map((row) =>
        row.fieldName === 'currency' ? { ...row, defaultValue: '"KWD"' } : row,
      ),
    };
    render(CookbookHarness, {
      cookbook: kwd,
      catalog,
      sectionId: 'section:fixture.surface',
      standalone: 'form',
      screenProps: { definition: currencyDefinition, source },
    });
    await userEvent.type(
      screen.getByLabelText(/Customer name/),
      'Kuwait customer',
    );
    await userEvent.type(screen.getByLabelText('Budget (KWD)'), '1.234');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(source.create).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'KWD', budget: 1234 }),
    );
  });

  it('exports only the active cookbook-visible fields without a host policy projection', async () => {
    const ondownload = vi.fn();
    render(CookbookHarness, {
      cookbook,
      catalog,
      sectionId: 'section:fixture.generic',
      screenProps: {
        definition: currencyDefinition,
        source: memorySource(),
        entryId: 'item:tasks:Task:generic',
      },
      exportProps: {
        definition: currencyDefinition,
        mode: 'export',
        loadRows: async () => [{ ...taskRows[0], reference: 'NEVER_EXPORT' }],
        ondownload,
      },
    });
    expect(
      screen.queryByRole('checkbox', { name: 'Reference' }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Export/ }));
    await vi.waitFor(() => expect(ondownload).toHaveBeenCalledOnce());
    expect(JSON.stringify(ondownload.mock.calls)).not.toContain('NEVER_EXPORT');
    expect(JSON.stringify(ondownload.mock.calls)).toContain('Write docs');
  });
});
