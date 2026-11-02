import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxEntry, ItemReviewView } from '../../review-dto.js';
import { IntakeInbox, IntakeReview, IntakeWorkspace } from '../index.js';
import { entry, host, view } from './review-fixtures.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function failed(): ItemReviewView {
  const current = view();
  current.generation!.outcome = 'provider_error';
  current.generation!.warnings = ['unavailable'];
  return current;
}

describe('Try again (#4504)', () => {
  it('re-runs a failed interpretation with the displayed binding and reloads', async () => {
    let current = failed();
    const retry = vi.fn(async () => {
      current = view('item', 'processing');
    });
    const callbacks = host(() => current, { retry });
    render(IntakeReview, { host: callbacks, itemId: 'item', pollMs: 10_000 });
    await fireEvent.click(await screen.findByTestId('retry-interpretation'));
    await waitFor(() =>
      expect(retry).toHaveBeenCalledWith({
        itemId: 'item',
        attemptId: 'generation-attempt',
        expectedRevision: 3,
        requestId: expect.any(String),
      }),
    );
    await waitFor(() => expect(callbacks.load).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('retry-interpretation')).toBeNull();
  });
  it('uses the server retry binding after a failed reinterpretation', async () => {
    const current = view();
    current.instruction = {
      current: null,
      applied: null,
      stale: false,
      failure: 'timeout',
      binding: { attemptId: 'anchor', expectedRevision: 7 },
    };
    const retry = vi.fn(async () => {});
    render(IntakeReview, {
      host: host(() => current, { retry }),
      itemId: 'item',
    });
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Try again' }),
    );
    await waitFor(() =>
      expect(retry).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: 'anchor', expectedRevision: 7 }),
      ),
    );
  });
  it('a stale answer refreshes the view and is not a denial', async () => {
    const retry = vi.fn(async () => ({ stale: true as const }));
    const callbacks = host(failed, { retry });
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    await fireEvent.click(await screen.findByTestId('retry-interpretation'));
    await waitFor(() => expect(callbacks.load).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('retry-interpretation')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('is not drawn without a failure, without the callback, or on a resolved item', async () => {
    render(IntakeReview, {
      host: host(view, { retry: vi.fn() }),
      itemId: 'item',
    });
    await screen.findByText('Row item');
    expect(screen.queryByTestId('retry-interpretation')).toBeNull();
    cleanup();
    render(IntakeReview, { host: host(failed), itemId: 'item' });
    await screen.findByText('Row item');
    expect(screen.queryByTestId('retry-interpretation')).toBeNull();
    cleanup();
    const resolved = failed();
    resolved.entry.item.disposition = {
      state: 'resolved',
      at: '2026-10-30T00:00:00.000Z',
    };
    render(IntakeReview, {
      host: host(() => resolved, { retry: vi.fn() }),
      itemId: 'item',
    });
    await screen.findByText('Row item');
    expect(screen.queryByTestId('retry-interpretation')).toBeNull();
  });
});

describe('list follows processing (#4504)', () => {
  it('the workspace follows every listed processing row until it settles', async () => {
    const settled = new Set<string>();
    const rows = () =>
      ['a', 'b', 'c'].map((id) =>
        entry(id, settled.has(id) ? 'unresolved' : 'processing'),
      );
    const callbacks = host(view, {
      list: vi.fn(async () => ({ items: rows() })),
      load: vi.fn(async (id: string) => {
        settled.add(id);
        return view(id);
      }),
    });
    render(IntakeWorkspace, { host: callbacks, pollMs: 10 });
    await screen.findByText('Row a');
    await waitFor(() =>
      expect(
        new Set(vi.mocked(callbacks.load).mock.calls.map(([id]) => id)),
      ).toEqual(new Set(['a', 'b', 'c'])),
    );
    await waitFor(() =>
      expect(
        screen.getAllByTestId('row-status').map((status) => status.textContent),
      ).toEqual([
        'Needs review: proposals',
        'Needs review: proposals',
        'Needs review: proposals',
      ]),
    );
    const reads = vi.mocked(callbacks.load).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(vi.mocked(callbacks.load).mock.calls.length).toBe(reads);
    expect(callbacks.list).toHaveBeenCalledOnce();
  });
  it('listPollMs re-reads the list while a row is processing, then stops', async () => {
    let reads = 0;
    const list = vi.fn(async () => ({
      items: [entry('a', ++reads < 3 ? 'processing' : 'unresolved')],
    }));
    render(IntakeInbox, { host: host(view, { list }), listPollMs: 15 });
    await waitFor(() =>
      expect(screen.getByTestId('row-status').textContent).toBe('Unresolved'),
    );
    const calls = list.mock.calls.length;
    expect(calls).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(list).toHaveBeenCalledTimes(calls);
  });
  it('does not poll by default', async () => {
    const list = vi.fn(async () => ({ items: [entry('a', 'processing')] }));
    render(IntakeInbox, { host: host(view, { list }) });
    await screen.findByText('Row a');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(list).toHaveBeenCalledOnce();
  });
  it('refresh() re-reads the list from the host page', async () => {
    let label = 'First';
    const list = vi.fn(async () => {
      const row: InboxEntry = { ...entry('a'), label };
      return { items: [row] };
    });
    const inbox = render(IntakeInbox, { host: host(view, { list }) });
    await screen.findByText('First');
    label = 'Second';
    const result = await inbox.component.refresh();
    expect(result.result).toBe('shown');
    expect(result.items.map((row) => row.label)).toEqual(['Second']);
    await screen.findByText('Second');
    cleanup();
    const workspace = render(IntakeWorkspace, { host: host(view, { list }) });
    await screen.findByText('Second');
    label = 'Third';
    expect((await workspace.component.refresh()).result).toBe('shown');
    await screen.findByText('Third');
  });
});
