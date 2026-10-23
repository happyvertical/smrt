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
