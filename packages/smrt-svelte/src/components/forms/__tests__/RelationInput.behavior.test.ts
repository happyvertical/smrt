/**
 * Behaviour tests for RelationInput (#3600): debounced search, select, clear,
 * resolving the current value, keyboard operation, loading/empty/error states,
 * Form integration, and accessibility. Search and resolve are caller-supplied,
 * so every test drives them with controllable promises.
 */

import { createControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: { mode: 'default' }, setMode: vi.fn() }),
}));
vi.mock('../../../hooks/useSTT.svelte.js', () => ({
  useSTT: () => ({
    isListening: false,
    lastResult: '',
    isReady: false,
    adapterType: null,
    initialize: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

import RelationInput from '../RelationInput.svelte';
import type { RelationOption } from '../types.js';
import FormFixture from './relation-input-form.fixture.svelte';

const CUSTOMERS: RelationOption[] = [
  { id: 'c1', label: 'Acme Corp', detail: 'acme@example.com' },
  { id: 'c2', label: 'Globex', detail: 'globex@example.com' },
  { id: 'c3', label: 'Initech' },
];

function byQuery(query: string): RelationOption[] {
  const q = query.toLowerCase();
  return CUSTOMERS.filter(
    (c) =>
      c.label.toLowerCase().includes(q) ||
      (c.detail ?? '').toLowerCase().includes(q),
  );
}

function makeSearch() {
  return vi.fn(async (query: string) => byQuery(query));
}

function props(extra: Record<string, unknown> = {}) {
  return {
    name: 'customerId',
    label: 'Customer',
    search: makeSearch(),
    debounceMs: 5,
    ...extra,
  };
}

const combo = () => screen.getByRole('combobox', { name: /Customer/ });

describe('RelationInput search and select', () => {
  it('searches with an empty query when the list opens', async () => {
    const p = props();
    render(RelationInput, { props: p });
    await userEvent.click(combo());
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    expect(p.search).toHaveBeenCalledWith('');
  });

  it('debounces typing into one search with the final text', async () => {
    const p = props({ debounceMs: 40 });
    render(RelationInput, { props: p });
    await userEvent.click(combo());
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    (p.search as ReturnType<typeof vi.fn>).mockClear();
    await userEvent.type(combo(), 'glo', { delay: 1 });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(p.search).toHaveBeenCalledTimes(1);
    expect(p.search).toHaveBeenCalledWith('glo');
  });

  it('lists results that matched on detail, not only label', async () => {
    render(RelationInput, { props: props() });
    await userEvent.type(combo(), 'acme@');
    await waitFor(() =>
      expect(screen.getByRole('option')).toHaveTextContent('Acme Corp'),
    );
  });

  it('shows the detail text under the label', async () => {
    render(RelationInput, { props: props() });
    await userEvent.click(combo());
    const option = await screen.findByRole('option', { name: /Acme Corp/ });
    expect(option).toHaveTextContent('acme@example.com');
  });

  it('selects an option: binds the id, shows the label, posts the id', async () => {
    const onchange = vi.fn();
    const { container } = render(RelationInput, {
      props: props({ onchange }),
    });
    await userEvent.click(combo());
    await userEvent.click(
      await screen.findByRole('option', { name: /Globex/ }),
    );
    expect(onchange).toHaveBeenCalledWith('c2');
    expect(combo()).toHaveValue('Globex');
    expect(
      container.querySelector<HTMLInputElement>('input[name="customerId"]'),
    ).toHaveValue('c2');
  });

  it('keeps showing the chosen label after later searches replace the results', async () => {
    render(RelationInput, { props: props() });
    await userEvent.click(combo());
    await userEvent.click(
      await screen.findByRole('option', { name: /Globex/ }),
    );
    await userEvent.click(document.body);
    await userEvent.click(combo());
    await userEvent.clear(combo());
    await userEvent.type(combo(), 'init', { delay: 1 });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    await userEvent.keyboard('{Escape}');
    expect(combo()).toHaveValue('Globex');
  });

  it('ignores a slow earlier response that arrives after a newer one', async () => {
    const resolvers: Record<string, (r: RelationOption[]) => void> = {};
    const search = vi.fn(
      (q: string) =>
        new Promise<RelationOption[]>((res) => {
          resolvers[q] = res;
        }),
    );
    render(RelationInput, { props: props({ search }) });
    await userEvent.click(combo());
    await waitFor(() => expect(search).toHaveBeenCalledWith(''));
    resolvers['']([CUSTOMERS[0]]);
    await userEvent.type(combo(), 'g');
    await waitFor(() => expect(search).toHaveBeenCalledWith('g'));
    resolvers.g([CUSTOMERS[1]]);
    await waitFor(() =>
      expect(screen.getByRole('option')).toHaveTextContent('Globex'),
    );
    // A late response for a query that has since been superseded is dropped.
    await userEvent.type(combo(), 'l');
    await waitFor(() => expect(search).toHaveBeenCalledWith('gl'));
    resolvers.gl([CUSTOMERS[1]]);
    resolvers.g([CUSTOMERS[2]]);
    await waitFor(() =>
      expect(screen.getByRole('option')).toHaveTextContent('Globex'),
    );
  });
});

describe('RelationInput stale options', () => {
  it('does not let Enter pick a result of an older query while a new search is pending', async () => {
    const onchange = vi.fn();
    let release: (r: RelationOption[]) => void = () => {};
    const search = vi.fn((q: string) =>
      q === ''
        ? Promise.resolve(CUSTOMERS)
        : new Promise<RelationOption[]>((res) => {
            release = res;
          }),
    );
    render(RelationInput, {
      props: props({ search, onchange, debounceMs: 1 }),
    });
    await userEvent.click(combo());
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    await userEvent.type(combo(), 'glo');
    expect(screen.queryByRole('option')).toBeNull();
    await userEvent.keyboard('{Enter}');
    expect(onchange).not.toHaveBeenCalled();
    await waitFor(() => expect(search).toHaveBeenCalledWith('glo'));
    release([CUSTOMERS[1]]);
    await userEvent.keyboard('{Enter}');
    expect(onchange).toHaveBeenCalledWith('c2');
  });
});

describe('RelationInput keyboard', () => {
  it('opens with ArrowDown, moves with arrows, picks with Enter, closes with Escape', async () => {
    const onchange = vi.fn();
    render(RelationInput, { props: props({ onchange }) });
    combo().focus();
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    expect(combo()).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{ArrowDown}');
    const options = screen.getAllByRole('option');
    expect(combo()).toHaveAttribute('aria-activedescendant', options[1].id);
    await userEvent.keyboard('{Enter}');
    expect(onchange).toHaveBeenCalledWith('c2');
    expect(combo()).toHaveAttribute('aria-expanded', 'false');

    await userEvent.keyboard('{ArrowDown}');
    expect(combo()).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Escape}');
    expect(combo()).toHaveAttribute('aria-expanded', 'false');
  });

  it('exposes combobox semantics with listbox options', async () => {
    render(RelationInput, { props: props() });
    await userEvent.click(combo());
    await screen.findAllByRole('option');
    expect(combo()).toHaveAttribute('aria-autocomplete', 'list');
    expect(combo()).toHaveAttribute('aria-controls');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
});

describe('RelationInput states', () => {
  it('announces searching, then the result count', async () => {
    let finish: (r: RelationOption[]) => void = () => {};
    const search = vi.fn(
      () =>
        new Promise<RelationOption[]>((res) => {
          finish = res;
        }),
    );
    render(RelationInput, { props: props({ search }) });
    await userEvent.click(combo());
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Searching'),
    );
    expect(combo()).toHaveAttribute('aria-busy', 'true');
    finish(CUSTOMERS);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('3 results'),
    );
    expect(combo()).not.toHaveAttribute('aria-busy');
  });

  it('shows the empty state when nothing matches', async () => {
    render(RelationInput, { props: props() });
    await userEvent.type(combo(), 'zzz');
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('No matches'),
    );
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('shows an error state when the search fails and recovers on the next search', async () => {
    const search = vi
      .fn<(q: string) => Promise<RelationOption[]>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(CUSTOMERS);
    render(RelationInput, { props: props({ search }) });
    await userEvent.click(combo());
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Search failed'),
    );
    await userEvent.type(combo(), 'a');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
  });

  it('renders the error message and marks the field invalid', () => {
    render(RelationInput, { props: props({ error: 'Pick a customer' }) });
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a customer');
    expect(combo()).toHaveAttribute('aria-invalid', 'true');
    expect(combo().getAttribute('aria-describedby')).toContain(
      screen.getByRole('alert').id,
    );
  });

  it('disables the field and the clear button', () => {
    render(RelationInput, { props: props({ disabled: true, value: 'c1' }) });
    expect(combo()).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Clear/ })).toBeNull();
  });

  it('marks a required field', () => {
    render(RelationInput, { props: props({ required: true }) });
    expect(combo()).toHaveAttribute('aria-required', 'true');
  });
});

describe('RelationInput clear', () => {
  it('clears a selection and reports the empty value', async () => {
    const onchange = vi.fn();
    const { container } = render(RelationInput, {
      props: props({
        onchange,
        value: 'c1',
        resolve: async () => CUSTOMERS[0],
      }),
    });
    await waitFor(() => expect(combo()).toHaveValue('Acme Corp'));
    await userEvent.click(
      screen.getByRole('button', { name: 'Clear Customer' }),
    );
    expect(onchange).toHaveBeenCalledWith('');
    expect(combo()).toHaveValue('');
    expect(
      container.querySelector<HTMLInputElement>('input[name="customerId"]'),
    ).toHaveValue('');
    expect(screen.queryByRole('button', { name: /Clear/ })).toBeNull();
    expect(combo()).toHaveFocus();
  });

  it('offers no clear button when required or empty', () => {
    const { unmount } = render(RelationInput, {
      props: props({ required: true, value: 'c1', resolve: async () => null }),
    });
    expect(screen.queryByRole('button', { name: /Clear/ })).toBeNull();
    unmount();
    render(RelationInput, { props: props() });
    expect(screen.queryByRole('button', { name: /Clear/ })).toBeNull();
  });
});

describe('RelationInput resolve', () => {
  it('shows the resolved label for an initial value, never the raw id', async () => {
    const resolve = vi.fn(async (id: string) => ({ id, label: 'Globex' }));
    render(RelationInput, { props: props({ value: 'c2', resolve }) });
    expect(combo()).not.toHaveValue('c2');
    await waitFor(() => expect(combo()).toHaveValue('Globex'));
    expect(resolve).toHaveBeenCalledWith('c2');
  });

  it('does not resolve a value it already labelled from a search', async () => {
    const resolve = vi.fn(async (id: string) => ({ id, label: 'x' }));
    render(RelationInput, { props: props({ resolve }) });
    await userEvent.click(combo());
    await userEvent.click(
      await screen.findByRole('option', { name: /Globex/ }),
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('leaves the field empty when resolve finds nothing or fails', async () => {
    const resolve = vi.fn(async () => null);
    const { unmount } = render(RelationInput, {
      props: props({ value: 'gone', resolve }),
    });
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(combo()).toHaveValue('');
    unmount();
    render(RelationInput, {
      props: props({
        value: 'gone',
        resolve: vi.fn(async () => {
          throw new Error('x');
        }),
      }),
    });
    expect(combo()).toHaveValue('');
  });
});

describe('RelationInput value rebinding', () => {
  it('drops the previous label when value changes to an unknown id and there is no resolve', async () => {
    const view = render(RelationInput, { props: props() });
    await userEvent.click(combo());
    await userEvent.click(await screen.findByRole('option', { name: /Acme/ }));
    expect(combo()).toHaveValue('Acme Corp');
    await view.rerender({ ...props(), value: 'c9' });
    await waitFor(() => expect(combo()).toHaveValue(''));
  });
});

describe('RelationInput onCreate', () => {
  it('offers a New action that receives the typed text and selects the result', async () => {
    const onCreate = vi.fn(async (q: string) => ({
      id: 'new1',
      label: q.toUpperCase(),
    }));
    const onchange = vi.fn();
    render(RelationInput, { props: props({ onCreate, onchange }) });
    await userEvent.type(combo(), 'umbrella');
    await userEvent.click(screen.getByRole('button', { name: /New customer/ }));
    expect(onCreate).toHaveBeenCalledWith('umbrella');
    await waitFor(() => expect(onchange).toHaveBeenCalledWith('new1'));
    expect(combo()).toHaveValue('UMBRELLA');
  });

  it('is absent without onCreate', () => {
    render(RelationInput, { props: props() });
    expect(screen.queryByRole('button', { name: /New/ })).toBeNull();
  });
});

describe('RelationInput in the rich Form', () => {
  it('registers with the form control registry and posts the id', async () => {
    const registry = createControlInteractionRegistry();
    const search = makeSearch();
    render(FormFixture, {
      props: {
        search,
        interactionRegistry: registry,
        resolve: async (id: string) => ({ id, label: 'Globex' }),
      },
    });
    await waitFor(() => expect(combo()).toHaveValue('Globex'));
    const entry = registry.get({ formId: 'order', controlId: 'customerId' });
    expect(entry?.state.value).toBe('c2');
    const form = screen.getByRole('form', { name: 'Order' }) as HTMLFormElement;
    expect(new FormData(form).getAll('customerId')).toEqual(['c2']);
  });
});

describe('RelationInput accessibility', () => {
  it('is axe-clean closed, open with results, and with an error', async () => {
    const { container } = render(RelationInput, {
      props: props({ error: 'Required', description: 'Who is buying' }),
    });
    await expectNoA11yViolations(container);
    await userEvent.click(combo());
    await screen.findAllByRole('option');
    await expectNoA11yViolations(container);
  });
});
