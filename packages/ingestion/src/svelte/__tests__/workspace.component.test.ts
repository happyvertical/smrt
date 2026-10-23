import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenerationOutput } from '../../proposal-dto.js';
import type {
  InboxEntry,
  InboxState,
  IntakeReviewHost,
  ItemReviewView,
  ReviewAction,
} from '../../review-dto.js';
import { EvidenceViewer, IntakeInbox, IntakeWorkspace } from '../index.js';
import { triageSettled, viewStatus } from '../view-utils.js';

afterEach(cleanup);

function entry(
  id: string,
  state: InboxState,
  item: Partial<InboxEntry['item']> = {},
): InboxEntry {
  return {
    item: {
      id,
      receiptState: 'ready',
      processingState: 'completed',
      analysisRevision: 2,
      cancelled: false,
      traceId: `trace-${id}`,
      ...item,
    },
    label: `Item ${id.toUpperCase()}`,
    state,
    assignment: { assigneeId: null, version: 1 },
  };
}
function generation(
  suggestions: GenerationOutput['suggestions'] = [],
): GenerationOutput {
  return {
    version: 1,
    outcome: 'proposals',
    suggestions,
    splits: [],
    warnings: [],
    omittedSuggestions: 0,
    source: {
      attemptId: 'extraction',
      revision: 1,
      inputDigest: 'in',
      outputDigest: 'out',
      evidenceDigest: 'evidence',
    },
    offered: [],
    provenance: {
      configurationVersion: '1',
      promptVersion: '1',
      catalogDigest: 'catalog',
      policyVersions: [],
      generative: { provider: 'fixture', model: 'fixture', version: '1' },
      decision: { configured: false },
      usage: {},
    },
    automaticActionEligible: false,
  } as GenerationOutput;
}
function suggestion(
  disposition: 'ready_for_review' | 'needs_review',
  missingFields: string[] = [],
): GenerationOutput['suggestions'][number] {
  return {
    handlerId: 'draft',
    handlerVersion: '1',
    args: { title: 'Draft' },
    evidence: [],
    alternatives: [],
    missingFields,
    explanation: 'Suggested',
    disposition,
  };
}
function analysis(
  id: string,
  output: Record<string, unknown> = {},
): NonNullable<ItemReviewView['analysis']> {
  return {
    itemId: id,
    attemptId: `attempt-${id}`,
    revision: 2,
    inputDigest: 'in',
    outputDigest: 'out',
    evidenceDigest: 'evidence',
    configuration: { stage: 'interpret' },
    evidence: [],
    result: {
      status: 'completed',
      provider: 'fixture',
      model: 'fixture',
      version: '1',
      output,
      usage: {},
    },
  };
}
function action(id: string, state: string): ReviewAction {
  return {
    review: {
      actionId: `action-${id}`,
      proposalId: `proposal-${id}`,
      revision: 1,
      reviewVersion: 1,
      bindingHash: 'binding',
      display: { operation: 'Create draft' },
      state,
    },
    args: { title: 'Draft' },
    handlerId: 'draft',
    handlerVersion: '1',
  };
}
function view(
  listed: InboxEntry,
  extra: Partial<ItemReviewView> = {},
): ItemReviewView {
  return {
    entry: listed,
    evidence: [],
    reviews: { actions: [] },
    availability: 'available',
    ...extra,
  };
}
function ready(id: string, state: InboxState = 'unresolved') {
  return view(entry(id, state), {
    analysis: analysis(id),
    generation: generation([suggestion('ready_for_review')]),
  });
}
function inFlight(id: string) {
  return view(entry(id, 'processing', { processingState: 'running' }), {
    instruction: {
      current: {
        id: 'instruction',
        text: 'Customer PO from Badger, just file it',
        actorId: 'owner',
        recordedAt: '2026-10-23T00:00:00.000Z',
        supersedesId: null,
        digest: 'digest',
      },
      applied: null,
      stale: true,
      reinterpreting: true,
    },
  });
}
/**
 * A fake authenticated host: each item has a queue of views; `load` takes
 * the next one (the last repeats) and `list` reports each item's current
 * row under the requested state filter.
 */
function backend(order: string[], views: Record<string, ItemReviewView[]>) {
  const peek = (id: string) => views[id][0];
  const next = (id: string) =>
    structuredClone(views[id].length > 1 ? views[id].shift()! : views[id][0]);
  const host: IntakeReviewHost = {
    list: vi.fn(async ({ state }) => ({
      items: order
        .map((id) => structuredClone(peek(id).entry))
        .filter((row) => !state || row.state === state),
    })),
    load: vi.fn(async (id: string) => next(id)),
    upload: vi.fn(async () => ({ itemId: order[0] })),
    preview: vi.fn(async () => {}),
    decide: vi.fn(async () => {}),
    apply: vi.fn(async (actionId: string) => ({
      actionId,
      state: 'succeeded' as const,
    })),
    candidates: vi.fn(async () => ({ items: [], truncated: false })),
    assign: vi.fn(async () => {}),
    split: vi.fn(async () => {}),
    resolve: vi.fn(async () => {}),
    instruct: vi.fn(async () => {}),
  };
  return host;
}
function row(id: string) {
  return document.querySelector(`li[data-item-id="${id}"]`) as HTMLElement;
}
function pane() {
  return screen.getByTestId('workspace-item');
}

describe('intake triage workspace', () => {
  it('opens an item beside the list with its original inline and moves with J/K and Alt+arrows', async () => {
    const pdf = view(entry('b', 'unresolved'), {
      analysis: analysis('b', {
        results: [
          {
            evidence: { id: 'b-pdf' },
            segments: [
              { text: 'first', location: { kind: 'page', page: 1 } },
              { text: 'third', location: { kind: 'page', page: 3 } },
            ],
          },
        ],
      }),
      generation: generation([suggestion('ready_for_review')]),
      evidence: [
        {
          evidence: {
            id: 'b-record',
            partId: 'capture',
            parentEvidenceId: null,
            mediaType: 'application/json',
            contentHash: 'h1',
            byteLength: 2,
          },
          label: 'Capture record',
          text: '{}',
        },
        {
          evidence: {
            id: 'b-pdf',
            partId: 'file',
            parentEvidenceId: 'b-record',
            mediaType: 'application/pdf',
            contentHash: 'h2',
            byteLength: 20,
          },
          label: 'badger-po.pdf',
          viewUrl: '/original/b',
        },
      ],
    });
    const host = backend(['a', 'b', 'c'], {
      a: [ready('a')],
      b: [pdf],
      c: [ready('c')],
    });
    render(IntakeWorkspace, { host });
    await screen.findByText('Item C');
    expect(screen.getByText(/Choose an item/)).toBeTruthy();
    await fireEvent.click(
      within(row('b')).getByRole('button', { name: 'Review' }),
    );
    expect(row('b').getAttribute('aria-current')).toBe('true');
    expect(pane().getAttribute('aria-label')).toBe('Item B');
    await waitFor(() => expect(document.activeElement).toBe(pane()));
    // The pager opens on the uploaded file, not its capture record.
    await screen.findByText('Original 2 of 2');
    const frame = () =>
      pane().querySelector('iframe') as HTMLIFrameElement | null;
    expect(frame()?.getAttribute('src')).toMatch(/\/original\/b$/);
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();
    expect(frame()?.getAttribute('src')).toMatch(/\/original\/b#page=2$/);
    await fireEvent.click(
      screen.getByRole('button', { name: 'Previous original' }),
    );
    expect(screen.getByText('Capture record')).toBeTruthy();
    expect(frame()).toBeNull();
    expect(screen.getByTestId('queue-position').textContent).toBe(
      'Item 2 of 3',
    );
    // J / K and Alt+Down / Alt+Up move through the list, never navigating.
    await fireEvent.keyDown(document.body, { key: 'j' });
    await waitFor(() =>
      expect(row('c').getAttribute('aria-current')).toBe('true'),
    );
    await fireEvent.keyDown(document.body, { key: 'k' });
    await waitFor(() =>
      expect(row('b').getAttribute('aria-current')).toBe('true'),
    );
    await fireEvent.keyDown(document.body, { key: 'ArrowUp', altKey: true });
    await waitFor(() =>
      expect(row('a').getAttribute('aria-current')).toBe('true'),
    );
    await fireEvent.keyDown(document.body, { key: 'ArrowDown', altKey: true });
    await waitFor(() =>
      expect(row('b').getAttribute('aria-current')).toBe('true'),
    );
    // Typing in a field never moves the selection.
    const box = await screen.findByRole('textbox', {
      name: 'Instructions for the assistant',
    });
    await fireEvent.keyDown(box, { key: 'j' });
    expect(row('b').getAttribute('aria-current')).toBe('true');
    await fireEvent.click(screen.getByRole('button', { name: 'Next item' }));
    await waitFor(() =>
      expect(row('c').getAttribute('aria-current')).toBe('true'),
    );
    expect(
      (screen.getByRole('button', { name: 'Next item' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(host.list).toHaveBeenCalledTimes(1);
    expect(vi.mocked(host.load).mock.calls.map(([id]) => id)).toEqual([
      'b',
      'c',
      'b',
      'a',
      'b',
      'c',
    ]);
  });

  it('keeps the open row and its form on the same background stage, in place and without re-listing', async () => {
    const host = backend(['b'], {
      b: [inFlight('b'), inFlight('b'), ready('b', 'waiting')],
    });
    render(IntakeWorkspace, { host, itemId: 'b', pollMs: 5 });
    await screen.findByText('Item B');
    await waitFor(() =>
      expect(within(row('b')).getByTestId('row-status').textContent).toBe(
        'Interpreting…',
      ),
    );
    expect(screen.getByTestId('reinterpreting')).toBeTruthy();
    await waitFor(() =>
      expect(within(row('b')).getByTestId('row-status').textContent).toBe(
        'Ready to review',
      ),
    );
    expect(screen.queryByTestId('reinterpreting')).toBeNull();
    expect(screen.getByRole('button', { name: 'Prepare review' })).toBeTruthy();
    expect(host.list).toHaveBeenCalledTimes(1);
  });

  it('lets the reviewer move on while a reinterpretation runs and updates that row when it lands', async () => {
    const needsVendor = view(
      entry('b', 'unresolved', { analysisRevision: 4 }),
      {
        analysis: analysis('b'),
        generation: generation([suggestion('needs_review', ['vendor'])]),
      },
    );
    const host = backend(['b', 'c'], {
      // Enough in-flight reads that the open pane cannot reach the result
      // before the reviewer moves on.
      b: [
        ready('b'),
        ...Array.from({ length: 8 }, () => inFlight('b')),
        needsVendor,
      ],
      c: [ready('c')],
    });
    render(IntakeWorkspace, { host, itemId: 'b', pollMs: 5 });
    const box = await screen.findByRole('textbox', {
      name: 'Instructions for the assistant',
    });
    await fireEvent.input(box, {
      target: { value: 'Customer PO from Badger, just file it' },
    });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Re-read with these instructions' }),
    );
    await screen.findByTestId('reinterpreting');
    expect(host.instruct).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'b',
        text: 'Customer PO from Badger, just file it',
      }),
    );
    // Move on at once; the left item keeps following its stage.
    await fireEvent.keyDown(document.body, { key: 'j' });
    await waitFor(() =>
      expect(row('c').getAttribute('aria-current')).toBe('true'),
    );
    expect(within(row('b')).getByTestId('row-status').textContent).toBe(
      'Interpreting…',
    );
    await waitFor(() =>
      expect(within(row('b')).getByTestId('row-status').textContent).toBe(
        'Needs review: missing vendor',
      ),
    );
    expect(screen.getByTestId('background-update').textContent).toBe(
      'Item B: Needs review: missing vendor',
    );
    // The open item is untouched while the other row followed its stage.
    expect(row('c').getAttribute('aria-current')).toBe('true');
    expect(host.list).toHaveBeenCalledTimes(1);
    const loads = vi.mocked(host.load).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Settled rows stop following.
    expect(vi.mocked(host.load).mock.calls.length).toBe(loads);
  });

  it('follows an item left before its post-instruction reload answered, and announces only a stage it saw running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = backend(['b', 'c'], {
      // Two in-flight reads: the released pane read and the first follow
      // read may take them in either order.
      b: [ready('b'), inFlight('b'), inFlight('b'), ready('b', 'waiting')],
      c: [ready('c')],
    });
    const load = host.load;
    let reads = 0;
    host.load = vi.fn(async (id: string, cursor?: string) => {
      // The pane's reload after the instruction hangs until released.
      if (id === 'b' && ++reads === 2) await gate;
      return load(id, cursor);
    });
    render(IntakeWorkspace, { host, itemId: 'b', pollMs: 5 });
    const box = await screen.findByRole('textbox', {
      name: 'Instructions for the assistant',
    });
    await fireEvent.input(box, { target: { value: 'File it' } });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Re-read with these instructions' }),
    );
    await waitFor(() => expect(host.instruct).toHaveBeenCalled());
    // Still loading: the pane has not shown the reinterpretation yet.
    expect(screen.queryByTestId('reinterpreting')).toBeNull();
    await fireEvent.keyDown(document.body, { key: 'j' });
    await waitFor(() =>
      expect(row('c').getAttribute('aria-current')).toBe('true'),
    );
    release();
    await waitFor(() =>
      expect(screen.getByTestId('background-update').textContent).toBe(
        'Item B: Ready to review',
      ),
    );
    expect(within(row('b')).getByTestId('row-status').textContent).toBe(
      'Ready to review',
    );
  });

  it('advances after apply settles the item: the row leaves the filtered queue and the next item opens with focus', async () => {
    const waiting = (id: string) =>
      view(entry(id, 'waiting'), {
        analysis: analysis(id),
        reviews: { actions: [action(id, 'waiting_review')] },
      });
    const host = backend(['a', 'b'], {
      a: [
        waiting('a'),
        view(entry('a', 'waiting'), {
          analysis: analysis('a'),
          reviews: { actions: [action('a', 'authorized')] },
        }),
        view(entry('a', 'completed'), {
          analysis: analysis('a'),
          reviews: { actions: [action('a', 'succeeded')] },
        }),
      ],
      b: [waiting('b')],
    });
    render(IntakeWorkspace, { host });
    await screen.findByText('Item A');
    await fireEvent.change(screen.getByRole('combobox', { name: 'State' }), {
      target: { value: 'waiting' },
    });
    await waitFor(() =>
      expect(host.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'waiting' }),
      ),
    );
    await fireEvent.click(
      within(await waitFor(() => row('a'))).getByRole('button', {
        name: 'Review',
      }),
    );
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Approve' }),
    );
    // Approval leaves an apply step for this reviewer: no advance yet.
    const apply = await screen.findByRole('button', {
      name: 'Apply approved action',
    });
    expect(row('a').getAttribute('aria-current')).toBe('true');
    expect(within(row('a')).getByTestId('row-status').textContent).toBe(
      'Approved, not yet applied',
    );
    await fireEvent.click(apply);
    await waitFor(() =>
      expect(row('b')?.getAttribute('aria-current')).toBe('true'),
    );
    // Completed no longer matches "waiting": the row left the list.
    expect(row('a')).toBeNull();
    expect(pane().getAttribute('aria-label')).toBe('Item B');
    await waitFor(() => expect(document.activeElement).toBe(pane()));
    expect(host.decide).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'action-a', decision: 'approve' }),
    );
    expect(host.apply).toHaveBeenCalledWith('action-a');
    expect(host.list).toHaveBeenCalledTimes(2);
  });

  it('advances after "handled, no action" and reports an empty queue', async () => {
    const host = backend(['a', 'b'], {
      a: [
        ready('a'),
        view(
          entry('a', 'resolved', {
            disposition: { state: 'resolved', at: '2026-10-23T00:00:00.000Z' },
          }),
          {
            disposition: {
              kind: 'resolved_no_action',
              reviewer: 'owner',
              reason: 'Already paid',
              decidedAt: '2026-10-23T00:00:00.000Z',
            },
          },
        ),
      ],
      b: [
        view(entry('b', 'completed'), {
          reviews: { actions: [action('b', 'succeeded')] },
        }),
      ],
    });
    render(IntakeWorkspace, { host, itemId: 'a' });
    await screen.findByText('Item A');
    // The workspace resolves in its item pane, not per row.
    expect(
      within(screen.getByTestId('intake-inbox')).queryByRole('button', {
        name: 'Handled, no action',
      }),
    ).toBeNull();
    await fireEvent.input(
      await screen.findByRole('textbox', { name: 'Reason for no action' }),
      { target: { value: 'Already paid' } },
    );
    await fireEvent.click(
      within(pane()).getByRole('button', { name: 'Handled, no action' }),
    );
    // The only other row is completed: nothing is left to open.
    await screen.findByTestId('queue-done');
    expect(screen.queryByTestId('intake-review')).toBeNull();
    expect(within(row('a')).getByTestId('row-status').textContent).toBe(
      'Handled, no action',
    );
    expect(host.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'a',
        disposition: 'resolve_no_action',
        reason: 'Already paid',
      }),
    );
    expect(host.list).toHaveBeenCalledTimes(1);
  });

  it('keeps a partial saved-review page open until the remaining reviews are loaded', () => {
    const partial = view(entry('a', 'partially_completed'), {
      reviews: {
        actions: [action('a', 'succeeded')],
        nextCursor: 'more-reviews',
      },
    });
    expect(triageSettled(partial)).toBe(false);
    partial.reviews.nextCursor = undefined;
    expect(triageSettled(partial)).toBe(true);
  });

  it('advances past completed inbox pages to the next reviewable row', async () => {
    const host = backend(['a'], {
      a: [
        ready('a'),
        view(
          entry('a', 'resolved', {
            disposition: { state: 'resolved', at: '2026-10-23T00:00:00.000Z' },
          }),
        ),
      ],
      b: [ready('b')],
    });
    host.list = vi.fn(async ({ cursor }) =>
      cursor === 'page-2'
        ? { items: [entry('b', 'waiting')] }
        : cursor === 'page-1'
          ? { items: [entry('finished', 'completed')], nextCursor: 'page-2' }
          : { items: [entry('a', 'unresolved')], nextCursor: 'page-1' },
    );
    render(IntakeWorkspace, { host, itemId: 'a' });
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Handled, no action' }),
    );
    await waitFor(() =>
      expect(row('b')?.getAttribute('aria-current')).toBe('true'),
    );
    expect(screen.queryByTestId('queue-done')).toBeNull();
    expect(host.list).toHaveBeenCalledTimes(3);
  });

  it('loads more using the applied assignee filter rather than an unsaved edit', async () => {
    const host = backend(['a'], { a: [ready('a')] });
    host.list = vi.fn(async ({ cursor }) => ({
      items: cursor ? [entry('b', 'waiting')] : [entry('a', 'waiting')],
      ...(cursor ? {} : { nextCursor: 'next' }),
    }));
    render(IntakeInbox, { host });
    await screen.findByText('Item A');
    await fireEvent.input(
      screen.getByRole('textbox', { name: 'Assignee ID' }),
      {
        target: { value: 'unapplied-assignee' },
      },
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Item B');
    expect(host.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'next', assigneeId: undefined }),
    );
  });

  it('derives row status and settlement from the loaded view only', () => {
    expect(viewStatus(inFlight('b'))).toEqual({ kind: 'pending' });
    expect(viewStatus(ready('b'))).toEqual({ kind: 'ready' });
    const failed = ready('b');
    failed.instruction = {
      current: null,
      applied: null,
      stale: false,
      failure: 'timeout',
    };
    expect(viewStatus(failed)).toEqual({ kind: 'failed', reason: 'timeout' });
    const empty = view(entry('b', 'unresolved'), {
      generation: { ...generation(), outcome: 'ambiguous' },
    });
    expect(viewStatus(empty)).toEqual({
      kind: 'needs_review',
      reason: 'ambiguous',
    });
    const mixed = view(entry('b', 'partially_completed'), {
      reviews: {
        actions: [action('one', 'succeeded'), action('two', 'failed')],
      },
    });
    expect(triageSettled(mixed)).toBe(false);
    mixed.reviews.actions[1].review.state = 'stale';
    expect(triageSettled(mixed)).toBe(true);
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const statusText = (id: string) =>
  within(row(id)).getByTestId('row-status').textContent;
function pdf(listed: InboxEntry, extra: Partial<ItemReviewView> = {}) {
  const id = listed.item.id;
  return view(listed, {
    analysis: analysis(id, {
      results: [
        {
          evidence: { id: `${id}-pdf` },
          segments: [{ text: 'last', location: { kind: 'page', page: 3 } }],
        },
      ],
    }),
    evidence: [
      {
        evidence: {
          id: `${id}-pdf`,
          partId: 'file',
          parentEvidenceId: null,
          mediaType: 'application/pdf',
          contentHash: 'h',
          byteLength: 1,
        },
        label: `${id}.pdf`,
        viewUrl: `/original/${id}`,
      },
    ],
    ...extra,
  });
}
/** Select each listed id in turn with J, leaving every one mid-stage. */
async function leaveInFlight(ids: string[]) {
  for (const id of ids) {
    await waitFor(() =>
      expect(row(id).getAttribute('aria-current')).toBe('true'),
    );
    await screen.findByTestId('reinterpreting');
    await fireEvent.keyDown(document.body, { key: 'j' });
  }
}

describe('intake triage workspace edge cases', () => {
  it('keeps rows while a refresh is pending, so an in-place poll still lands and survives the older page', async () => {
    let settled = false;
    let hold: ReturnType<typeof deferred> | undefined;
    const host = backend(['b', 'c'], { b: [inFlight('b')], c: [ready('c')] });
    host.load = vi.fn(async (id: string) =>
      structuredClone(
        id === 'b'
          ? settled
            ? ready('b', 'waiting')
            : inFlight('b')
          : ready(id),
      ),
    );
    host.list = vi.fn(async () => {
      if (hold) await hold.promise;
      // A page read before the background stage finished.
      return { items: [inFlight('b').entry, ready('c').entry] };
    });
    render(IntakeWorkspace, { host, itemId: 'b', pollMs: 5 });
    await waitFor(() => expect(statusText('b')).toBe('Interpreting…'));
    hold = deferred();
    await fireEvent.click(
      within(screen.getByTestId('intake-inbox')).getByRole('button', {
        name: 'Refresh',
      }),
    );
    expect(row('b')).not.toBeNull();
    settled = true;
    await waitFor(() => expect(statusText('b')).toBe('Ready to review'));
    hold.resolve(undefined);
    await waitFor(() => expect(host.list).toHaveBeenCalledTimes(2));
    await screen.findByText('Item C');
    await sleep(20);
    // The open row keeps following its form, not the older page.
    expect(statusText('b')).toBe('Ready to review');
  });

  it('advances from the displayed rows when an apply finishes during a refresh', async () => {
    let hold: ReturnType<typeof deferred> | undefined;
    const host = backend(['a', 'b'], {
      a: [
        view(entry('a', 'waiting'), {
          reviews: { actions: [action('a', 'authorized')] },
        }),
        view(entry('a', 'completed'), {
          reviews: { actions: [action('a', 'succeeded')] },
        }),
      ],
      b: [ready('b', 'waiting')],
    });
    const list = host.list;
    host.list = vi.fn(async (input) => {
      if (hold) await hold.promise;
      return list(input);
    });
    render(IntakeWorkspace, { host, itemId: 'a' });
    const apply = await screen.findByRole('button', {
      name: 'Apply approved action',
    });
    hold = deferred();
    await fireEvent.click(
      within(screen.getByTestId('intake-inbox')).getByRole('button', {
        name: 'Refresh',
      }),
    );
    await fireEvent.click(apply);
    await waitFor(() =>
      expect(row('b').getAttribute('aria-current')).toBe('true'),
    );
    expect(screen.queryByTestId('queue-done')).toBeNull();
    hold.resolve(undefined);
  });

  it('drops a navigation that awaited the next page when the reviewer chose another item meanwhile', async () => {
    const page2 = deferred<{ items: InboxEntry[] }>();
    const host = backend(['a', 'b'], {
      a: [ready('a')],
      b: [ready('b')],
      c: [ready('c')],
    });
    host.list = vi.fn(async ({ cursor }) =>
      cursor
        ? page2.promise
        : {
            items: [ready('a').entry, ready('b').entry],
            nextCursor: 'page-2',
          },
    );
    render(IntakeWorkspace, { host, itemId: 'b' });
    await screen.findByText('Item A');
    await screen.findByRole('textbox', {
      name: 'Instructions for the assistant',
    });
    await fireEvent.keyDown(document.body, { key: 'j' });
    await waitFor(() =>
      expect(host.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: 'page-2' }),
      ),
    );
    await fireEvent.keyDown(document.body, { key: 'k' });
    await waitFor(() =>
      expect(row('a').getAttribute('aria-current')).toBe('true'),
    );
    page2.resolve({ items: [ready('c').entry] });
    await screen.findByText('Item C');
    await sleep(20);
    expect(row('a').getAttribute('aria-current')).toBe('true');
    expect(vi.mocked(host.load).mock.calls.map(([id]) => id)).not.toContain(
      'c',
    );
  });

  it('a denial clears the row status the pane produced and the item is not followed', async () => {
    const failing = view(entry('b', 'waiting'), {
      reviews: { actions: [action('b', 'waiting_review')] },
      instruction: {
        current: null,
        applied: null,
        stale: false,
        failure: 'timeout',
      },
    });
    const host = backend(['b', 'c'], { b: [failing], c: [ready('c')] });
    host.decide = vi.fn(async () => {
      throw new Error('Denied');
    });
    render(IntakeWorkspace, { host, itemId: 'b', pollMs: 5 });
    await waitFor(() => expect(statusText('b')).toBe('Failed: timeout'));
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Approve' }),
    );
    await screen.findByRole('alert');
    await waitFor(() => expect(statusText('b')).toBe('Waiting'));
    const reads = vi.mocked(host.load).mock.calls.filter(([id]) => id === 'b');
    await fireEvent.keyDown(document.body, { key: 'j' });
    await waitFor(() =>
      expect(row('c').getAttribute('aria-current')).toBe('true'),
    );
    await sleep(60);
    expect(
      vi.mocked(host.load).mock.calls.filter(([id]) => id === 'b'),
    ).toHaveLength(reads.length);
  });

  it('follows any number of left items, at most five reads per tick, in rotation', async () => {
    const ids = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7'];
    const views: Record<string, ItemReviewView[]> = { z: [ready('z')] };
    for (const id of ids) views[id] = [inFlight(id)];
    const host = backend([...ids, 'z'], views);
    const load = host.load;
    const log: Array<{ id: string; at: number }> = [];
    let recording = false;
    host.load = vi.fn(async (id: string, cursor?: string) => {
      if (recording) log.push({ id, at: performance.now() });
      return load(id, cursor);
    });
    render(IntakeWorkspace, { host, itemId: 'i1', pollMs: 40 });
    await leaveInFlight(ids);
    await waitFor(() =>
      expect(row('z').getAttribute('aria-current')).toBe('true'),
    );
    recording = true;
    await sleep(450);
    const ticks: string[][] = [];
    let last = -Infinity;
    for (const { id, at } of log) {
      if (at - last > 20) ticks.push([]);
      ticks.at(-1)!.push(id);
      last = at;
    }
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (const tick of ticks) expect(tick.length).toBeLessThanOrEqual(5);
    expect(new Set(ticks.slice(0, 2).flat())).toEqual(new Set(ids));
  });

  it('runs one watch tick at a time even when another item is left mid-tick', async () => {
    const host = backend(['b', 'c', 'd'], {
      b: [inFlight('b')],
      c: [inFlight('c')],
      d: [ready('d')],
    });
    const load = host.load;
    const hold = deferred();
    let outstanding = 0;
    let most = 0;
    // A read of an item that is not open is a follow read.
    const open = () =>
      document
        .querySelector('li[aria-current="true"]')
        ?.getAttribute('data-item-id');
    let tracking = false;
    host.load = vi.fn(async (id: string, cursor?: string) => {
      const followed = tracking && id !== open();
      if (followed) most = Math.max(most, ++outstanding);
      try {
        // The first follow read of b hangs while the reviewer moves on.
        if (followed && id === 'b') await hold.promise;
        return await load(id, cursor);
      } finally {
        if (followed) outstanding--;
      }
    });
    render(IntakeWorkspace, { host, itemId: 'b', pollMs: 5 });
    await waitFor(() =>
      expect(row('b').getAttribute('aria-current')).toBe('true'),
    );
    await screen.findByTestId('reinterpreting');
    tracking = true;
    await fireEvent.keyDown(document.body, { key: 'j' });
    await waitFor(() => expect(outstanding).toBe(1));
    await leaveInFlight(['c']);
    await waitFor(() =>
      expect(row('d').getAttribute('aria-current')).toBe('true'),
    );
    await sleep(60);
    expect(most).toBe(1);
    hold.resolve();
  });

  it('stops following after three thrown reads in a row and falls back to the listed state', async () => {
    const host = backend(['b', 'c'], { b: [inFlight('b')], c: [ready('c')] });
    const load = host.load;
    let left = false;
    host.load = vi.fn(async (id: string, cursor?: string) => {
      if (left && id === 'b') throw new Error('Unavailable');
      return load(id, cursor);
    });
    const list = host.list;
    host.list = vi.fn(async (input) => {
      const page = await list(input);
      page.items[0] = entry('b', 'unresolved');
      return page;
    });
    render(IntakeWorkspace, { host, itemId: 'b', pollMs: 5 });
    await screen.findByTestId('reinterpreting');
    left = true;
    await fireEvent.keyDown(document.body, { key: 'j' });
    await waitFor(() => expect(statusText('b')).toBe('Unresolved'));
    const failed = vi.mocked(host.load).mock.calls.filter(([id]) => id === 'b');
    await sleep(80);
    expect(
      vi.mocked(host.load).mock.calls.filter(([id]) => id === 'b'),
    ).toHaveLength(failed.length);
    // Pane read plus exactly three failed follow reads.
    expect(failed.length).toBe(4);
  });

  it('stops every timer on unmount and on a host change', async () => {
    const first = backend(['b', 'c'], { b: [inFlight('b')], c: [ready('c')] });
    const view1 = render(IntakeWorkspace, {
      host: first,
      itemId: 'b',
      pollMs: 5,
    });
    await leaveInFlight(['b']);
    await waitFor(() =>
      expect(
        vi.mocked(first.load).mock.calls.filter(([id]) => id === 'b').length,
      ).toBeGreaterThan(1),
    );
    const second = backend(['d'], { d: [ready('d')] });
    await view1.rerender({ host: second, itemId: 'd' });
    await screen.findByText('Item D');
    const reads = vi.mocked(first.load).mock.calls.length;
    await sleep(60);
    expect(vi.mocked(first.load).mock.calls.length).toBe(reads);
    const third = backend(['b', 'c'], { b: [inFlight('b')], c: [ready('c')] });
    cleanup();
    const view3 = render(IntakeWorkspace, {
      host: third,
      itemId: 'b',
      pollMs: 5,
    });
    await leaveInFlight(['b']);
    view3.unmount();
    const after = vi.mocked(third.load).mock.calls.length;
    await sleep(60);
    expect(vi.mocked(third.load).mock.calls.length).toBe(after);
  });

  it('ignores a late poll answer from the item the reviewer already left', async () => {
    const late = deferred<ItemReviewView>();
    let reads = 0;
    const host = backend(['b', 'c'], { b: [inFlight('b')], c: [ready('c')] });
    const load = host.load;
    host.load = vi.fn(async (id: string, cursor?: string) => {
      // The pane's first poll tick hangs until after the reviewer moved on.
      if (id === 'b' && ++reads === 2) return late.promise;
      return load(id, cursor);
    });
    render(IntakeWorkspace, { host, itemId: 'b', pollMs: 5 });
    await waitFor(() => expect(reads).toBe(2));
    await fireEvent.keyDown(document.body, { key: 'j' });
    await waitFor(() =>
      expect(row('c').getAttribute('aria-current')).toBe('true'),
    );
    late.resolve(
      view(entry('b', 'unresolved', { analysisRevision: 4 }), {
        analysis: analysis('b'),
        generation: generation([suggestion('needs_review', ['vendor'])]),
      }),
    );
    await sleep(30);
    expect(statusText('b')).toBe('Interpreting…');
    expect(pane().getAttribute('aria-label')).toBe('Item C');
  });

  it('handles an empty list without selecting or loading anything', async () => {
    const host = backend([], {});
    render(IntakeWorkspace, { host });
    await screen.findByText('No intake items.');
    await fireEvent.keyDown(document.body, { key: 'j' });
    expect(
      (screen.getByRole('button', { name: 'Next item' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole('button', {
          name: 'Previous item',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(/Choose an item/)).toBeTruthy();
    expect(host.load).not.toHaveBeenCalled();
  });

  it('skips a next row someone else already closed', async () => {
    const closed = (id: string) =>
      view(
        entry(id, 'resolved', {
          disposition: { state: 'resolved', at: '2026-10-23T00:00:00.000Z' },
        }),
      );
    const host = backend(['a', 'b', 'c'], {
      a: [ready('a'), closed('a')],
      b: [closed('b')],
      c: [ready('c')],
    });
    render(IntakeWorkspace, { host, itemId: 'a' });
    await fireEvent.click(
      within(
        await waitFor(() => {
          const node = screen.getByRole('group', {
            name: 'Handled, no action',
          });
          return node;
        }),
      ).getByRole('button', { name: 'Handled, no action' }),
    );
    await waitFor(() =>
      expect(row('c').getAttribute('aria-current')).toBe('true'),
    );
    expect(vi.mocked(host.load).mock.calls.map(([id]) => id)).not.toContain(
      'b',
    );
  });

  it('asks before J/K would discard unsent input, and keeps it on "Stay"', async () => {
    const host = backend(['b', 'c'], { b: [ready('b')], c: [ready('c')] });
    render(IntakeWorkspace, { host, itemId: 'b' });
    const box = await screen.findByRole('textbox', {
      name: 'Instructions for the assistant',
    });
    await fireEvent.input(box, { target: { value: 'Half a thought' } });
    await fireEvent.keyDown(document.body, { key: 'j' });
    const confirm = await screen.findByTestId('unsaved-leave');
    expect(row('b').getAttribute('aria-current')).toBe('true');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(confirm).getByRole('button', { name: 'Stay on this item' }),
      ),
    );
    await fireEvent.click(
      within(confirm).getByRole('button', { name: 'Stay on this item' }),
    );
    expect(screen.queryByTestId('unsaved-leave')).toBeNull();
    expect((box as HTMLTextAreaElement).value).toBe('Half a thought');
    await fireEvent.click(screen.getByRole('button', { name: 'Next item' }));
    await fireEvent.click(
      within(await screen.findByTestId('unsaved-leave')).getByRole('button', {
        name: 'Discard and open the other item',
      }),
    );
    await waitFor(() =>
      expect(row('c').getAttribute('aria-current')).toBe('true'),
    );
    // Clean panes move without asking, including an edited action editor
    // that was reverted.
    await fireEvent.keyDown(document.body, { key: 'k' });
    await waitFor(() =>
      expect(row('b').getAttribute('aria-current')).toBe('true'),
    );
  });

  it('asks before leaving edited action arguments', async () => {
    const host = backend(['a', 'b'], {
      a: [
        view(entry('a', 'waiting'), {
          reviews: { actions: [action('a', 'waiting_review')] },
        }),
      ],
      b: [ready('b')],
    });
    render(IntakeWorkspace, { host, itemId: 'a' });
    const args = await screen.findByRole('textbox', {
      name: 'Exact arguments (JSON)',
    });
    await fireEvent.input(args, { target: { value: '{"title":"Edited"}' } });
    await fireEvent.keyDown(document.body, { key: 'j' });
    await screen.findByTestId('unsaved-leave');
    expect(row('a').getAttribute('aria-current')).toBe('true');
  });

  it('keeps the original page across an approve', async () => {
    const host = backend(['a'], {
      a: [
        pdf(entry('a', 'waiting'), {
          reviews: { actions: [action('a', 'waiting_review')] },
        }),
        pdf(entry('a', 'waiting'), {
          reviews: { actions: [action('a', 'authorized')] },
        }),
      ],
    });
    render(IntakeWorkspace, { host, itemId: 'a' });
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Next page' }),
    );
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByRole('button', { name: 'Apply approved action' });
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();
    expect(pane().querySelector('iframe')?.getAttribute('src')).toMatch(
      /#page=2$/,
    );
  });
});

const catalogEntry = {
  id: 'draft',
  version: '1',
  description: 'Create a draft',
  kind: 'operation' as const,
  capability: null,
  argsSchema: {},
  references: {},
  operation: { model: 'Document', action: 'create', version: '1' },
};
/** An open item offering every kind of reviewer input the pane tracks. */
function editable(id: string, state: InboxState = 'waiting') {
  const generated = generation([suggestion('needs_review', ['vendor'])]);
  generated.splits = [{ evidenceId: 'e', groups: [[1]], digest: 'd' }];
  return view(entry(id, state), {
    analysis: analysis(id),
    generation: generated,
    catalog: [catalogEntry],
    reviews: { actions: [action(id, 'waiting_review')] },
  });
}
function editableHost(extra: Record<string, ItemReviewView[]> = {}) {
  const host = backend(['a', 'b'], {
    a: [editable('a')],
    b: [ready('b')],
    ...extra,
  });
  host.startAction = vi.fn(async () => {});
  host.feedback = vi.fn(async () => {});
  return host;
}

describe('triage workspace unsent input', () => {
  const sources: Array<[string, () => Promise<void>]> = [
    [
      'a suggestion draft',
      async () => {
        await fireEvent.input(
          screen.getByRole('textbox', { name: 'Suggested arguments (JSON)' }),
          { target: { value: '{"vendor":"Badger"}' } },
        );
      },
    ],
    [
      'a split draft',
      async () => {
        await fireEvent.input(
          screen.getByRole('textbox', {
            name: 'Logical page groups (JSON): e',
          }),
          { target: { value: '[[1],[2]]' } },
        );
      },
    ],
    [
      'a chosen start handler',
      async () => {
        await fireEvent.change(
          screen.getByRole('combobox', { name: 'Handler' }),
          { target: { value: 'draft@1' } },
        );
      },
    ],
    [
      'a no-action reason',
      async () => {
        await fireEvent.input(
          screen.getByRole('textbox', { name: 'Reason for no action' }),
          { target: { value: 'Duplicate' } },
        );
      },
    ],
    [
      "an action card's reason",
      async () => {
        await fireEvent.input(screen.getByRole('textbox', { name: 'Reason' }), {
          target: { value: 'Checked' },
        });
      },
    ],
    [
      "an action card's feedback comment",
      async () => {
        await fireEvent.input(
          screen.getByRole('textbox', { name: 'Feedback comment' }),
          { target: { value: 'Close call' } },
        );
      },
    ],
  ];
  const ways: Array<[string, () => Promise<void>]> = [
    [
      'J',
      async () => {
        await fireEvent.keyDown(document.body, { key: 'j' });
      },
    ],
    [
      'Next item',
      async () => {
        await fireEvent.click(
          screen.getByRole('button', { name: 'Next item' }),
        );
      },
    ],
    [
      "the row's Review button",
      async () => {
        await fireEvent.click(
          within(row('b')).getByRole('button', { name: 'Review' }),
        );
      },
    ],
  ];
  it.each(
    sources.flatMap(([source, edit]) =>
      ways.map(([way, go]) => [source, way, edit, go] as const),
    ),
  )('asks before %s is discarded by %s', async (_source, _way, edit, go) => {
    const host = editableHost();
    render(IntakeWorkspace, { host, itemId: 'a' });
    await screen.findByRole('textbox', { name: 'Suggested arguments (JSON)' });
    await screen.findByText('Item B');
    await edit();
    await go();
    await screen.findByTestId('unsaved-leave');
    expect(row('a').getAttribute('aria-current')).toBe('true');
  });

  it('asks before Previous item too, and "Stay" returns to the field', async () => {
    const host = backend(['b', 'a'], { a: [editable('a')], b: [ready('b')] });
    render(IntakeWorkspace, { host, itemId: 'a' });
    const box = await screen.findByRole('textbox', {
      name: 'Instructions for the assistant',
    });
    box.focus();
    await fireEvent.input(box, { target: { value: 'File it' } });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Previous item' }),
    );
    const confirm = await screen.findByTestId('unsaved-leave');
    // Announced once, through the focused group, not also as an alert.
    expect(within(confirm).queryByRole('alert')).toBeNull();
    await fireEvent.click(
      within(confirm).getByRole('button', { name: 'Stay on this item' }),
    );
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it('does not count a draft as clean while a reload has cleared the view', async () => {
    const host = editableHost();
    const load = host.load;
    let hold: ReturnType<typeof deferred> | undefined;
    host.load = vi.fn(async (id: string, cursor?: string) => {
      if (hold && id === 'a') await hold.promise;
      return load(id, cursor);
    });
    render(IntakeWorkspace, { host, itemId: 'a' });
    await fireEvent.input(
      await screen.findByRole('textbox', {
        name: 'Suggested arguments (JSON)',
      }),
      { target: { value: '{"vendor":"Badger"}' } },
    );
    hold = deferred();
    await fireEvent.click(
      within(pane()).getByRole('button', { name: 'Refresh' }),
    );
    expect(
      screen.queryByRole('textbox', { name: 'Suggested arguments (JSON)' }),
    ).toBeNull();
    await fireEvent.keyDown(document.body, { key: 'j' });
    await screen.findByTestId('unsaved-leave');
    hold.resolve(undefined);
  });

  it('does not ask about input the denied pane no longer shows', async () => {
    const host = editableHost();
    host.decide = vi.fn(async () => {
      throw new Error('Denied');
    });
    render(IntakeWorkspace, { host, itemId: 'a' });
    await fireEvent.input(
      await screen.findByRole('textbox', {
        name: 'Instructions for the assistant',
      }),
      { target: { value: 'File it' } },
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByRole('alert');
    expect(
      screen.queryByRole('textbox', { name: 'Instructions for the assistant' }),
    ).toBeNull();
    await fireEvent.keyDown(document.body, { key: 'j' });
    await waitFor(() =>
      expect(row('b').getAttribute('aria-current')).toBe('true'),
    );
    expect(screen.queryByTestId('unsaved-leave')).toBeNull();
  });

  it('a finished item with unsent input stays open, keeps the input and says so', async () => {
    const applied = editable('a', 'partially_completed');
    applied.reviews.actions = [action('a', 'succeeded')];
    const host = editableHost({
      a: [
        (() => {
          const authorized = editable('a');
          authorized.reviews.actions = [action('a', 'authorized')];
          return authorized;
        })(),
        applied,
      ],
    });
    render(IntakeWorkspace, { host, itemId: 'a' });
    const draft = await screen.findByRole('textbox', {
      name: 'Suggested arguments (JSON)',
    });
    await fireEvent.input(draft, { target: { value: '{"vendor":"Badger"}' } });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Apply approved action' }),
    );
    await waitFor(() => expect(host.apply).toHaveBeenCalled());
    expect((await screen.findByTestId('advance-held')).textContent).toMatch(
      /unsent input/,
    );
    expect(row('a').getAttribute('aria-current')).toBe('true');
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Suggested arguments (JSON)',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('{"vendor":"Badger"}');
    // Moving on explicitly still asks.
    await fireEvent.click(screen.getByRole('button', { name: 'Next item' }));
    await fireEvent.click(
      within(await screen.findByTestId('unsaved-leave')).getByRole('button', {
        name: 'Discard and open the other item',
      }),
    );
    await waitFor(() =>
      expect(row('b').getAttribute('aria-current')).toBe('true'),
    );
  });

  it('closing an item discards input a closed item cannot take, then advances', async () => {
    const host = editableHost({
      a: [
        editable('a', 'unresolved'),
        view(
          entry('a', 'resolved', {
            disposition: { state: 'resolved', at: '2026-10-23T00:00:00.000Z' },
          }),
        ),
      ],
    });
    render(IntakeWorkspace, { host, itemId: 'a' });
    await fireEvent.input(
      await screen.findByRole('textbox', {
        name: 'Instructions for the assistant',
      }),
      { target: { value: 'Never sent' } },
    );
    await fireEvent.click(
      within(
        screen.getByRole('group', { name: 'Handled, no action' }),
      ).getByRole('button', { name: 'Handled, no action' }),
    );
    await waitFor(() =>
      expect(row('b').getAttribute('aria-current')).toBe('true'),
    );
    expect(screen.queryByTestId('unsaved-leave')).toBeNull();
    expect(host.instruct).not.toHaveBeenCalled();
  });
});

describe('triage workspace paging failures', () => {
  function lastPage(
    host: IntakeReviewHost,
    more: () => Promise<{ items: InboxEntry[] }>,
  ) {
    host.list = vi.fn(async ({ cursor }) =>
      cursor
        ? more()
        : { items: [entry('a', 'waiting')], nextCursor: 'page-2' },
    );
  }
  const applying = () => [
    view(entry('a', 'waiting'), {
      reviews: { actions: [action('a', 'authorized')] },
    }),
    view(entry('a', 'completed'), {
      reviews: { actions: [action('a', 'succeeded')] },
    }),
  ];
  it.each([
    false,
    true,
  ])('keeps input typed during an automatic page walk (later page: %s)', async (later) => {
    const hold = deferred<{ items: InboxEntry[] }>();
    const initial = editable('a');
    initial.reviews.actions = [action('a', 'authorized')];
    const applied = editable('a', 'partially_completed');
    applied.reviews.actions = [action('a', 'succeeded')];
    const host = editableHost({ a: [initial, applied] });
    host.list = vi.fn(async ({ cursor }) => {
      if (!cursor)
        return { items: [entry('a', 'waiting')], nextCursor: 'page-1' };
      if (later && cursor === 'page-1')
        return {
          items: [entry('finished', 'completed')],
          nextCursor: 'page-2',
        };
      return hold.promise;
    });
    render(IntakeWorkspace, { host, itemId: 'a' });
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Apply approved action' }),
    );
    await waitFor(() => expect(host.list).toHaveBeenCalledTimes(later ? 3 : 2));
    const draft = await screen.findByRole('textbox', {
      name: 'Suggested arguments (JSON)',
    });
    await fireEvent.input(draft, {
      target: { value: '{"vendor":"Typed while paging"}' },
    });
    hold.resolve({ items: [entry('b', 'waiting')] });
    expect((await screen.findByTestId('advance-held')).textContent).toMatch(
      /unsent input/,
    );
    expect(row('a').getAttribute('aria-current')).toBe('true');
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Suggested arguments (JSON)',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('{"vendor":"Typed while paging"}');
    await fireEvent.click(screen.getByRole('button', { name: 'Next item' }));
    await screen.findByTestId('unsaved-leave');
    expect(row('a').getAttribute('aria-current')).toBe('true');
  });

  it('a failed page append during advance keeps the item and the rows, with a retry note', async () => {
    const host = backend(['a'], { a: applying() });
    lastPage(host, async () => {
      throw new Error('Unavailable');
    });
    render(IntakeWorkspace, { host, itemId: 'a' });
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Apply approved action' }),
    );
    expect((await screen.findByTestId('advance-held')).textContent).toMatch(
      /couldn't be loaded/,
    );
    expect(screen.queryByTestId('queue-done')).toBeNull();
    expect(row('a')).not.toBeNull();
    expect(screen.getByTestId('more-failed')).toBeTruthy();
    expect(screen.getByTestId('intake-review')).toBeTruthy();
    // The cursor survives, so Load more can be retried.
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
  });

  it('a page append that cannot start because a refresh is pending is not an empty queue', async () => {
    const host = backend(['a'], { a: applying() });
    let hold: ReturnType<typeof deferred> | undefined;
    host.list = vi.fn(async ({ cursor }) => {
      if (hold) await hold.promise;
      return cursor
        ? { items: [] }
        : { items: [entry('a', 'waiting')], nextCursor: 'page-2' };
    });
    render(IntakeWorkspace, { host, itemId: 'a' });
    const apply = await screen.findByRole('button', {
      name: 'Apply approved action',
    });
    await screen.findByText('Load more');
    hold = deferred();
    await fireEvent.click(
      within(screen.getByTestId('intake-inbox')).getByRole('button', {
        name: 'Refresh',
      }),
    );
    await fireEvent.click(apply);
    expect((await screen.findByTestId('advance-held')).textContent).toMatch(
      /couldn't be loaded/,
    );
    expect(screen.queryByTestId('queue-done')).toBeNull();
    hold.resolve(undefined);
  });

  it('a denial after Load more restores the entry as its page listed it, not a patched one', async () => {
    const failing = view(entry('b', 'waiting'), {
      reviews: { actions: [action('b', 'waiting_review')] },
      instruction: {
        current: null,
        applied: null,
        stale: false,
        failure: 'timeout',
      },
    });
    const host = backend(['b'], { b: [failing], c: [ready('c')] });
    host.list = vi.fn(async ({ cursor }) =>
      cursor
        ? { items: [entry('c', 'unresolved')] }
        : { items: [entry('b', 'unresolved')], nextCursor: 'page-2' },
    );
    host.decide = vi.fn(async () => {
      throw new Error('Denied');
    });
    render(IntakeWorkspace, { host, itemId: 'b' });
    await waitFor(() => expect(statusText('b')).toBe('Failed: timeout'));
    await fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Item C');
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByRole('alert');
    await waitFor(() => expect(statusText('b')).toBe('Unresolved'));
  });
});

describe('workspace GitHub review regressions', () => {
  it.each([
    'Reason',
    'Feedback comment',
  ])('does not Apply over an unsent action-card %s', async (name) => {
    const initial = editable('a');
    initial.reviews.actions = [action('a', 'authorized')];
    initial.reviews.actions[0].attemptId = 'attempt-a';
    const host = editableHost({ a: [initial] });
    host.editAction = vi.fn(async () => {});
    render(IntakeWorkspace, { host, itemId: 'a' });
    const apply = await screen.findByRole('button', {
      name: 'Apply approved action',
    });
    const input = screen.getByRole('textbox', { name });
    await fireEvent.input(input, { target: { value: 'Unsent note' } });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(apply);
    expect(host.apply).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('Unsent note');
    await fireEvent.input(input, { target: { value: '' } });
    await waitFor(() =>
      expect((apply as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('keeps the selected filtered row when input arrives during automatic paging', async () => {
    const hold = deferred<{ items: InboxEntry[] }>();
    const requested = deferred();
    const initial = editable('a');
    initial.reviews.actions = [action('a', 'authorized')];
    const applied = editable('a', 'partially_completed');
    applied.reviews.actions = [action('a', 'succeeded')];
    const host = editableHost({ a: [initial, applied] });
    host.list = vi.fn(async ({ cursor }) => {
      if (!cursor)
        return { items: [entry('a', 'waiting')], nextCursor: 'next' };
      requested.resolve();
      return hold.promise;
    });
    render(IntakeWorkspace, { host, itemId: 'a' });
    await screen.findByRole('button', { name: 'Apply approved action' });
    await fireEvent.change(screen.getByRole('combobox', { name: 'State' }), {
      target: { value: 'waiting' },
    });
    await waitFor(() =>
      expect(host.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'waiting' }),
      ),
    );
    await fireEvent.click(
      screen.getByRole('button', { name: 'Apply approved action' }),
    );
    await requested.promise;
    const draft = await screen.findByRole('textbox', {
      name: 'Suggested arguments (JSON)',
    });
    await fireEvent.input(draft, {
      target: { value: '{"vendor":"Keep row"}' },
    });
    hold.resolve({ items: [entry('b', 'waiting')] });
    await screen.findByTestId('advance-held');
    expect(row('a')?.getAttribute('aria-current')).toBe('true');
    expect(pane().getAttribute('aria-label')).toBe('Item A');
    expect((draft as HTMLTextAreaElement).value).toBe('{"vendor":"Keep row"}');
  });

  it('keeps a refresh newer than an already settled follow result', async () => {
    let settled = false;
    let fresh = false;
    const host = backend(['b', 'c'], { b: [inFlight('b')], c: [ready('c')] });
    const load = host.load;
    host.load = vi.fn(async (id, cursor) =>
      id === 'b' && settled ? ready('b') : load(id, cursor),
    );
    host.list = vi.fn(async () => ({
      items: [
        entry('b', fresh ? 'failed' : 'unresolved'),
        entry('c', 'waiting'),
      ],
    }));
    render(IntakeWorkspace, { host, itemId: 'b', pollMs: 5 });
    await screen.findByTestId('reinterpreting');
    await screen.findByText('Item C');
    await fireEvent.click(
      within(row('c')).getByRole('button', { name: 'Review' }),
    );
    settled = true;
    await waitFor(() => expect(statusText('b')).toBe('Ready to review'));
    fresh = true;
    await fireEvent.click(
      within(screen.getByTestId('intake-inbox')).getByRole('button', {
        name: 'Refresh',
      }),
    );
    await waitFor(() => expect(host.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(statusText('b')).toBe('Failed'));
  });
});

describe('triage workspace following bounds', () => {
  it('follows at most 20 items; the longest-followed one returns to its listed state', async () => {
    const ids = Array.from({ length: 21 }, (_, index) => `i${index + 1}`);
    const views: Record<string, ItemReviewView[]> = { z: [ready('z')] };
    for (const id of ids) views[id] = [inFlight(id)];
    const host = backend([...ids, 'z'], views);
    const list = host.list;
    host.list = vi.fn(async (input) => {
      const page = await list(input);
      return {
        items: page.items.map((row) =>
          row.item.id === 'z' ? row : entry(row.item.id, 'unresolved'),
        ),
      };
    });
    const load = host.load;
    let recording = false;
    const reads: string[] = [];
    host.load = vi.fn(async (id: string, cursor?: string) => {
      if (recording) reads.push(id);
      return load(id, cursor);
    });
    render(IntakeWorkspace, { host, itemId: 'i1', pollMs: 20 });
    await leaveInFlight(ids);
    await waitFor(() =>
      expect(row('z').getAttribute('aria-current')).toBe('true'),
    );
    expect(statusText('i1')).toBe('Unresolved');
    expect(statusText('i2')).toBe('Interpreting…');
    recording = true;
    await sleep(300);
    expect(reads).not.toContain('i1');
    expect(new Set(reads).size).toBeGreaterThan(5);
  }, 30000);

  it('does not follow or announce an item whose row the filter removed', async () => {
    const host = backend(['b', 'c'], { b: [inFlight('b')], c: [ready('c')] });
    const list = host.list;
    host.list = vi.fn(async (input) => {
      const page = await list(input);
      return {
        items: [entry('b', 'unresolved'), entry('c', 'unresolved')].filter(
          (row) => !input.state || row.state === input.state,
        ),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    });
    render(IntakeWorkspace, { host, itemId: 'b', pollMs: 5 });
    await screen.findByText('Item C');
    await fireEvent.change(screen.getByRole('combobox', { name: 'State' }), {
      target: { value: 'unresolved' },
    });
    await waitFor(() =>
      expect(host.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'unresolved' }),
      ),
    );
    await screen.findByTestId('reinterpreting');
    await fireEvent.keyDown(document.body, { key: 'j' });
    await waitFor(() =>
      expect(row('c').getAttribute('aria-current')).toBe('true'),
    );
    // Processing no longer matches "Unresolved": the row left on leaving.
    expect(row('b')).toBeNull();
    const reads = vi.mocked(host.load).mock.calls.filter(([id]) => id === 'b');
    await sleep(60);
    expect(
      vi.mocked(host.load).mock.calls.filter(([id]) => id === 'b'),
    ).toHaveLength(reads.length);
    expect(screen.getByTestId('background-update').textContent).toBe('');
  });

  it('a page read before a followed item settled does not regress its row', async () => {
    let settled = false;
    let hold: ReturnType<typeof deferred> | undefined;
    const host = backend(['b', 'c'], { b: [inFlight('b')], c: [ready('c')] });
    host.load = vi.fn(async (id: string) =>
      structuredClone(
        id === 'b'
          ? settled
            ? ready('b', 'waiting')
            : inFlight('b')
          : ready(id),
      ),
    );
    host.list = vi.fn(async () => {
      if (hold) await hold.promise;
      return { items: [inFlight('b').entry, ready('c').entry] };
    });
    render(IntakeWorkspace, { host, itemId: 'b', pollMs: 5 });
    await screen.findByTestId('reinterpreting');
    await fireEvent.keyDown(document.body, { key: 'j' });
    await waitFor(() =>
      expect(row('c').getAttribute('aria-current')).toBe('true'),
    );
    hold = deferred();
    await fireEvent.click(
      within(screen.getByTestId('intake-inbox')).getByRole('button', {
        name: 'Refresh',
      }),
    );
    settled = true;
    await waitFor(() => expect(statusText('b')).toBe('Ready to review'));
    hold.resolve(undefined);
    await waitFor(() => expect(host.list).toHaveBeenCalledTimes(2));
    await sleep(20);
    expect(statusText('b')).toBe('Ready to review');
  });
});

describe('inbox paging', () => {
  it('"Load more" continues the filter the rows were listed under, not edited inputs', async () => {
    const host = backend(['a'], { a: [ready('a')] });
    host.list = vi.fn(async ({ cursor }) => ({
      items: cursor ? [ready('b').entry] : [ready('a').entry],
      ...(cursor ? {} : { nextCursor: 'page-2' }),
    }));
    render(IntakeInbox, { host });
    await screen.findByText('Item A');
    await fireEvent.input(
      screen.getByRole('textbox', { name: 'Assignee ID' }),
      { target: { value: 'someone-else' } },
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Item B');
    expect(host.list).toHaveBeenLastCalledWith({
      state: undefined,
      assigneeId: undefined,
      cursor: 'page-2',
    });
    expect(screen.getByText('Item A')).toBeTruthy();
  });
});

describe('evidence viewer page navigation', () => {
  it('keeps every part listed by default and pages a PDF through same-origin URLs only', async () => {
    render(EvidenceViewer, {
      evidence: [
        {
          evidence: {
            id: 'pdf',
            partId: 'file',
            parentEvidenceId: null,
            mediaType: 'application/pdf',
            contentHash: 'h',
            byteLength: 1,
          },
          label: 'Two pages',
          viewUrl: '/original/pdf#toolbar=0',
        },
        {
          evidence: {
            id: 'foreign',
            partId: 'other',
            parentEvidenceId: null,
            mediaType: 'application/pdf',
            contentHash: 'h',
            byteLength: 1,
          },
          label: 'Foreign',
          viewUrl: 'https://other.example/file.pdf',
        },
      ],
      pages: { pdf: 2, foreign: 4 },
    });
    expect(screen.getByText('Two pages')).toBeTruthy();
    expect(screen.getByText('Foreign')).toBeTruthy();
    expect(screen.getAllByText('Original unavailable')).toHaveLength(1);
    expect(screen.queryByText(/Page \d of 4/)).toBeNull();
    const previous = screen.getByRole('button', { name: 'Previous page' });
    expect((previous as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Page 2 of 2')).toBeTruthy();
    expect(document.querySelector('iframe')?.getAttribute('src')).toMatch(
      /\/original\/pdf#page=2$/,
    );
    expect(
      (screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
