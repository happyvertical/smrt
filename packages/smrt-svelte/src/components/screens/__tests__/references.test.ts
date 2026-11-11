import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import DetailScreen from '../DetailScreen.svelte';
import EditForm from '../EditForm.svelte';
import ListScreen from '../ListScreen.svelte';
import RecipeScreens from '../RecipeScreens.svelte';
import RecordScreen from '../RecordScreen.svelte';
import { screenReferenceTarget } from '../references.js';
import { deriveScreenRelations } from '../relations.js';
import { deriveFieldRoles } from '../roles.js';
import {
  createRecipeScreenEntry,
  createRecipeScreenReferences,
  createRecipeScreensSource,
} from '../source.js';
import type {
  ScreenCollectionDefinition,
  ScreenRecord,
  ScreenReferenceSources,
} from '../types.js';

const people: ScreenCollectionDefinition = {
  name: 'people',
  objectRef: '@test/people:Person',
  className: 'Person',
  displayLabelField: 'name',
  fields: { name: { type: 'text' } },
  endpoint: '/people',
  actions: ['list', 'get'],
};
const definition: ScreenCollectionDefinition = {
  name: 'orders',
  objectRef: '@test/orders:Order',
  className: 'Order',
  fields: {
    number: { type: 'text' },
    customerId: { type: 'crossPackageRef' },
    approverId: { type: 'foreignKey' },
  },
  relationships: [
    {
      field: 'customerId',
      kind: 'crossPackageRef',
      relatedCollection: 'people',
    },
    { field: 'approverId', kind: 'foreignKey', relatedCollection: 'people' },
  ],
};
const ada = { id: 'ada-id', name: 'Ada Lovelace' };
const grace = { id: 'grace-id', name: 'Grace Hopper' };
const row = {
  id: 'order-id',
  number: 'ORD-1',
  customerId: ada.id,
  approverId: ada.id,
};
function mockReferences() {
  const get = vi.fn(async (id: string) =>
    [ada, grace].find((p) => p.id === id),
  );
  const search = vi.fn(
    async ({ query, offset }: { query: string; offset: number }) => ({
      rows: query === 'nobody' ? [] : offset ? [grace] : [ada],
      hasMore: query !== 'nobody' && offset === 0,
    }),
  );
  const list = vi.fn(async () => []);
  const references: ScreenReferenceSources = {
    people: {
      definition: people,
      source: { list, get, search },
      href: (id) => `/people/${id}`,
    },
  };
  return { references, get, search, list };
}

describe('named screen references', () => {
  it('shares collection-key and model-name lookup with the existing relation derivation', () => {
    const { references } = mockReferences();
    const target = references.people;
    const aliased = { exposedPeople: target };
    expect(
      screenReferenceTarget(definition, { name: 'customerId' }, aliased),
    ).toBe(target);
    expect(
      deriveScreenRelations(
        { orders: definition, exposedPeople: people },
        definition.objectRef,
      ).find(
        (relation) =>
          relation.field === 'customerId' && relation.kind === 'reference',
      )?.model,
    ).toBe(people.objectRef);
    expect(
      screenReferenceTarget(definition, { name: 'missingId' }, aliased),
    ).toBeUndefined();
    expect(
      screenReferenceTarget(definition, { name: 'customerId' }, {}),
    ).toBeUndefined();
  });

  it('renders a projected name in list and record headers, honors policies, and never submits it', async () => {
    const customer: ScreenCollectionDefinition = {
      objectRef: '@test:Customer',
      className: 'Customer',
      displayLabelField: 'displayLabel',
      displayLabelProjection: {
        via: 'profileId',
        field: 'name',
        fallback: 'Unnamed customer',
      },
      fields: {
        note: { type: 'text' },
        displayLabel: { type: 'text', readonly: true, ui: { basic: true } },
      },
    };
    const record = {
      id: 'customer-id',
      displayLabel: 'Maya Proof',
      note: 'Hello',
    };
    const policy = {
      objectRef: customer.objectRef,
      fields: {
        displayLabel: { visibility: 'basic' as const, label: 'Customer name' },
        note: { visibility: 'basic' as const },
      },
    };
    const list = render(ListScreen, {
      definition: customer,
      rows: [record],
      policy,
    });
    expect(
      screen.getByRole('columnheader', { name: /Customer name/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Maya Proof')).toBeInTheDocument();
    list.unmount();
    const view = render(RecordScreen, {
      definition: customer,
      record,
      policy,
      mode: 'view',
    });
    expect(
      screen.getByRole('heading', { name: 'Maya Proof' }),
    ).toBeInTheDocument();
    view.unmount();
    const hidden = render(RecordScreen, {
      definition: customer,
      record,
      mode: 'view',
      policy: {
        ...policy,
        fields: { ...policy.fields, displayLabel: { visibility: 'hidden' } },
      },
    });
    expect(screen.queryByText('Maya Proof')).not.toBeInTheDocument();
    hidden.unmount();
    const onsubmit = vi.fn();
    render(EditForm, {
      definition: customer,
      record,
      policy,
      fields: ['displayLabel', 'note'],
      onsubmit,
    });
    expect(
      screen.queryByRole('textbox', { name: /Customer name/ }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onsubmit).toHaveBeenCalledWith({ note: 'Hello' }, { isNew: false });
  });

  it('uses the manifest display field as the record title role', () => {
    expect(
      deriveFieldRoles({
        ...people,
        displayLabelField: 'nickname',
        fields: { name: { type: 'text' }, nickname: { type: 'text' } },
      }),
    ).toEqual({ name: [], nickname: ['title'] });
  });
  it('keeps both kinds of reference columns, coalesces repeated IDs, and searches rendered names', async () => {
    const { references, get, list } = mockReferences();
    const { container } = render(ListScreen, {
      definition,
      rows: [row],
      references,
    });
    expect(
      screen.getByRole('columnheader', { name: /Customer/ }),
    ).toBeInTheDocument();
    expect(await screen.findAllByText(ada.name)).toHaveLength(2);
    expect(get).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    await userEvent.type(screen.getByRole('searchbox'), 'Lovelace');
    expect(screen.getByText('ORD-1')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('links resolved names in a standalone detail and in the record header', async () => {
    const { references } = mockReferences();
    const detail = render(DetailScreen, {
      definition,
      record: row,
      references,
    });
    expect(
      (await screen.findAllByRole('link', { name: ada.name }))[0],
    ).toHaveAttribute('href', '/people/ada-id');
    detail.unmount();
    const { container } = render(RecordScreen, {
      definition,
      record: row,
      references,
    });
    expect(
      (await screen.findAllByRole('link', { name: ada.name }))[0],
    ).toHaveAttribute('href', '/people/ada-id');
    await expectNoA11yViolations(container);
  });

  it('resolves the initial value, searches on the source, pages, selects by keyboard, and submits IDs', async () => {
    const { references, search, list } = mockReferences();
    const onsubmit = vi.fn();
    const { container } = render(EditForm, {
      definition,
      fields: ['customerId'],
      record: row,
      references,
      onsubmit,
    });
    const input = screen.getByRole('combobox', { name: /Customer/ });
    await vi.waitFor(() => expect(input).toHaveValue(ada.name));
    await userEvent.click(input);
    expect(
      await screen.findByRole('option', { name: ada.name }),
    ).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, 'Gr');
    await vi.waitFor(() =>
      expect(search).toHaveBeenLastCalledWith({
        query: 'Gr',
        offset: 0,
        limit: 25,
      }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Load more records' }),
    );
    expect(
      await screen.findByRole('option', { name: grace.name }),
    ).toBeInTheDocument();
    expect(search).toHaveBeenLastCalledWith({
      query: 'Gr',
      offset: 1,
      limit: 25,
    });
    expect(input).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(input).toHaveValue(grace.name);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onsubmit).toHaveBeenCalledWith(
      { customerId: grace.id },
      { isNew: false },
    );
    expect(list).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it('clears optional references and leaves required references uncleared', async () => {
    const { references } = mockReferences();
    const onsubmit = vi.fn();
    const rendered = render(EditForm, {
      definition,
      fields: ['customerId'],
      record: row,
      references,
      onsubmit,
    });
    await screen.findByDisplayValue(ada.name);
    await userEvent.click(
      screen.getByRole('button', { name: /Clear customer/i }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onsubmit).toHaveBeenCalledWith(
      { customerId: null },
      { isNew: false },
    );
    rendered.unmount();
    render(EditForm, {
      definition: {
        ...definition,
        fields: { customerId: { type: 'foreignKey', required: true } },
      },
      references,
      onsubmit,
    });
    expect(
      screen.queryByRole('button', { name: /Clear/ }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('This field is required.'),
    ).toBeInTheDocument();
    expect(onsubmit).toHaveBeenCalledTimes(1);
  });

  it('announces empty and failed searches and preserves the committed value', async () => {
    const { references, search } = mockReferences();
    render(EditForm, {
      definition,
      fields: ['customerId'],
      record: row,
      references,
      onsubmit: vi.fn(),
    });
    const input = screen.getByRole('combobox');
    await screen.findByDisplayValue(ada.name);
    await userEvent.clear(input);
    await userEvent.type(input, 'nobody');
    await vi.waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'No matching records',
      ),
    );
    await userEvent.keyboard('{Escape}');
    expect(input).toHaveValue(ada.name);
    search.mockRejectedValueOnce(new Error('offline'));
    await userEvent.click(input);
    await vi.waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Could not search records',
      ),
    );
  });

  it('disables unavailable targets and preserves existing IDs on save', async () => {
    const onsubmit = vi.fn();
    render(EditForm, {
      definition,
      record: row,
      fields: ['customerId'],
      onsubmit,
    });
    expect(screen.getByLabelText(/Customer/)).toBeDisabled();
    expect(
      screen.getByText('This list is not available in this app.'),
    ).toBeInTheDocument();
    expect(screen.queryByDisplayValue(ada.id)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onsubmit).toHaveBeenCalledWith(
      { customerId: ada.id },
      { isNew: false },
    );
    await userEvent.click(
      screen.getByRole('button', { name: /Clear customer/i }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onsubmit).toHaveBeenLastCalledWith(
      { customerId: null },
      { isNew: false },
    );
  });

  it('drops late label responses after rows change and handles deleted targets', async () => {
    let answer!: (record: ScreenRecord) => void;
    const get = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const references = {
      people: { definition: people, source: { list: async () => [], get } },
    };
    const { rerender } = render(ListScreen, {
      definition,
      rows: [row],
      references,
    });
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
    await rerender({
      definition,
      rows: [{ ...row, customerId: 'deleted', approverId: null }],
      references,
    });
    answer(ada);
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(ada.name)).not.toBeInTheDocument();
    expect(screen.getByText('Linked record unavailable')).toBeInTheDocument();
  });

  it('forwards references through recipe create and record edit flows', async () => {
    const { references } = mockReferences();
    const source = {
      list: async () => [row],
      create: vi.fn(),
      update: vi.fn(),
    };
    const instance = render(RecipeScreens, {
      definition,
      references,
      source,
      view: 'create',
    });
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    instance.unmount();
    render(RecipeScreens, {
      definition,
      references,
      source,
      view: 'edit',
      recordId: row.id,
    });
    await vi.waitFor(() =>
      expect(screen.getAllByRole('combobox')).toHaveLength(2),
    );
    await vi.waitFor(() =>
      expect(screen.getAllByDisplayValue(ada.name)).toHaveLength(2),
    );
  });
});

describe('generated REST screen source', () => {
  it('adapts keyed cookbook entries across pages and keeps writes inside their filter', async () => {
    const first = Array.from({ length: 500 }, (_, i) => ({
      id: String(i),
      status: 'open',
    }));
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            init?.body
              ? { id: 'saved', ...JSON.parse(String(init.body)) }
              : String(url).includes('offset=500')
                ? { items: [{ id: 'late', status: 'paid' }] }
                : { items: first },
          ),
        ),
    );
    const def = { ...people, actions: ['list', 'get', 'create', 'update'] };
    const entry = createRecipeScreenEntry(
      { people: def },
      { model: people.objectRef, filter: { field: 'status', value: 'paid' } },
      { fetch: fetcher },
    );
    expect(await entry!.source.list()).toEqual([
      { id: 'late', status: 'paid' },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await entry!.source.create!({ status: 'open', name: 'Ada' });
    await entry!.source.update!('late', { status: 'open' });
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      status: 'paid',
      name: 'Ada',
    });
    expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body))).toEqual({
      status: 'paid',
    });
    expect(entry!.source.delete).toBeUndefined();
    expect(
      createRecipeScreenEntry({ people }, { model: '@unknown/pkg:Missing' }),
    ).toBeNull();
  });

  it('refuses an out-of-filter record returned by a keyed entry get', async () => {
    const source = createRecipeScreensSource(
      people,
      { list: vi.fn(), get: async () => ({ id: 'other', status: 'open' }) },
      { filter: { field: 'status', value: 'paid' } },
    );
    expect(await source.get!('other')).toBeUndefined();
  });
  it('searches the declared display field with stable paging and respects allowed actions', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ data: [ada, grace] })),
    );
    const map = createRecipeScreenReferences({ people }, { fetch: fetcher });
    const page = await map.people.source.search?.({
      query: 'Ada',
      offset: 25,
      limit: 1,
    });
    expect(page).toEqual({ rows: [ada], hasMore: true });
    const url = new URL(
      fetcher.mock.calls[0][0] as string,
      'https://example.test',
    );
    expect(url.pathname).toBe('/api/people');
    expect(url.searchParams.get('name[like]')).toBe('%Ada%');
    expect(url.searchParams.get('offset')).toBe('25');
    expect(url.searchParams.get('limit')).toBe('2');
    expect(url.searchParams.get('orderBy')).toBe('name ASC, id ASC');
    expect(map.people.source.create).toBeUndefined();
    expect(
      createRecipeScreenReferences({ people: { ...people, actions: [] } }),
    ).toEqual({});
  });

  it('does not offer search without label metadata and propagates transport errors', async () => {
    const list = vi.fn().mockRejectedValue(new Error('offline'));
    const source = createRecipeScreensSource(
      { ...people, displayLabelField: undefined },
      { list },
    );
    expect(source.search).toBeUndefined();
    await expect(source.list()).rejects.toThrow('offline');
  });
});
