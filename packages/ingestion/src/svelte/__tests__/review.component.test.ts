import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EvidenceView,
  IntakeReviewHost,
  ItemReviewView,
} from '../../review-dto.js';
import { EvidenceViewer, IntakeInbox, IntakeReview } from '../index.js';
import { evidenceUrl } from '../view-utils.js';

afterEach(cleanup);
function page(): ItemReviewView {
  return {
    entry: {
      item: {
        id: 'item',
        receiptState: 'ready',
        processingState: 'completed',
        analysisRevision: 2,
        cancelled: false,
        traceId: 'trace',
      },
      label: 'Private invoice',
      state: 'waiting',
      assignment: { assigneeId: null, version: 3 },
    },
    availability: 'available',
    evidence: [
      {
        evidence: {
          id: 'original',
          partId: 'body',
          parentEvidenceId: null,
          mediaType: 'message/rfc822',
          contentHash: 'hash',
          byteLength: 42,
        },
        label: 'Email original',
        text: '<img src=x onerror=alert(1)> confidential',
        viewUrl: '/original',
      },
    ],
    reviews: {
      actions: [
        {
          review: {
            actionId: 'action',
            proposalId: 'proposal',
            revision: 2,
            reviewVersion: 4,
            bindingHash: 'binding',
            display: { operation: 'Create draft' },
            state: 'waiting_review',
          },
          args: { title: 'Invoice' },
          handlerId: 'draft',
          handlerVersion: '1',
        },
      ],
    },
  };
}
function currentAnalysis(): NonNullable<ItemReviewView['analysis']> {
  return {
    itemId: 'item',
    attemptId: 'generation-attempt',
    revision: 9,
    inputDigest: 'generation-input',
    outputDigest: 'generation-output',
    evidenceDigest: 'evidence',
    configuration: {},
    evidence: [],
    result: {
      status: 'completed',
      provider: 'fixture',
      model: 'fixture',
      version: '1',
      output: {},
      usage: {},
    },
  };
}
function host(view = page()): IntakeReviewHost {
  return {
    list: vi.fn(async () => ({ items: [view.entry] })),
    load: vi.fn(async () => structuredClone(view)),
    upload: vi.fn(async () => ({ itemId: 'uploaded' })),
    preview: vi.fn(async () => {}),
    decide: vi.fn(async () => {}),
    apply: vi.fn(async () => ({
      actionId: 'action',
      state: 'succeeded' as const,
    })),
    candidates: vi.fn(async () => ({ items: [], truncated: false })),
    assign: vi.fn(async () => {}),
    split: vi.fn(async () => {}),
    feedback: vi.fn(async () => {}),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function reviewPage(
  start: number,
  end: number,
  cursor?: string,
): ItemReviewView {
  const view = page();
  const original = view.reviews.actions[0];
  view.reviews.actions = Array.from({ length: end - start }, (_, offset) => {
    const index = start + offset;
    return {
      ...structuredClone(original),
      handlerId: `effect-${index}`,
      review: { ...original.review, actionId: `action-${index}` },
      ...(index >= 19
        ? {
            plan: {
              id: 'cross-page-plan',
              key: 'plan',
              revision: 7,
              stepIndex: index - 19,
              args: { title: 'Parent plan' },
              handlerId: 'plan-handler',
              handlerVersion: '1',
              attemptId: 'attempt',
            },
          }
        : {}),
    };
  });
  if (cursor) view.reviews.nextCursor = cursor;
  return view;
}
describe('intake review host boundary', () => {
  it('pagination freshly reloads all 21 actions with dynamic cursors, dedupes cross-page plan steps and preserves exact mutation bindings', async () => {
    const callbacks = host();
    callbacks.editPlan = vi.fn(async () => {});
    let firstReads = 0;
    callbacks.load = vi.fn(async (_item, cursor) => {
      if (!cursor) {
        const view = reviewPage(
          0,
          20,
          ++firstReads === 1 ? 'old-cursor' : 'fresh-cursor',
        );
        view.reviews.actions[0].review.revision = firstReads === 1 ? 2 : 3;
        return view;
      }
      return reviewPage(19, 21);
    });
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Load more' }),
    );
    await screen.findByRole('heading', { name: 'effect-20' });
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(21);
    expect(screen.getAllByRole('heading', { name: 'effect-19' })).toHaveLength(
      1,
    );
    expect(
      screen.getAllByRole('button', {
        name: 'Edit the plan and review its new steps',
      }),
    ).toHaveLength(1);
    expect(vi.mocked(callbacks.load).mock.calls.slice(0, 3)).toEqual([
      ['item', undefined],
      ['item', undefined],
      ['item', 'fresh-cursor'],
    ]);
    const first = screen
      .getByRole('heading', { name: 'effect-0' })
      .closest('article')!;
    await fireEvent.click(
      within(first).getByRole('button', { name: 'Approve' }),
    );
    await waitFor(() =>
      expect(callbacks.decide).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: 'action-0', expectedRevision: 3 }),
      ),
    );
    await screen.findByRole('heading', { name: 'effect-20' });
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(21);
  });
  it.each([
    'first',
    'later',
  ])('pagination clears every displayed page on fresh %s-page revocation', async (deniedPage) => {
    const callbacks = host();
    let reads = 0;
    callbacks.load = vi.fn(async (_item, cursor) => {
      if (++reads > 1 && (deniedPage === 'first' ? !cursor : !!cursor))
        throw new Error('private revoked detail');
      return cursor ? reviewPage(20, 21) : reviewPage(0, 20, 'next');
    });
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Load more' }),
    );
    await screen.findByRole('alert');
    expect(screen.queryByText('Private invoice')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'effect-0' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'effect-20' })).toBeNull();
    expect(screen.queryByText(/private revoked detail/)).toBeNull();
  });
  it('pagination fences late page completions after authenticated context changes', async () => {
    const callbacks = host();
    const late = deferred<ItemReviewView>();
    let changed = false;
    callbacks.load = vi.fn(async (_item, cursor) => {
      if (cursor) return late.promise;
      const result = changed ? reviewPage(30, 31) : reviewPage(0, 20, 'next');
      if (changed) result.entry.label = 'Current context';
      return result;
    });
    const component = render(IntakeReview, {
      host: callbacks,
      itemId: 'item',
      contextKey: 'old',
    });
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Load more' }),
    );
    await waitFor(() =>
      expect(callbacks.load).toHaveBeenCalledWith('item', 'next'),
    );
    changed = true;
    await component.rerender({
      host: callbacks,
      itemId: 'item',
      contextKey: 'new',
    });
    await screen.findByText('Current context');
    late.resolve(reviewPage(20, 21));
    await late.promise;
    await tick();
    expect(screen.queryByRole('heading', { name: 'effect-20' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'effect-0' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'effect-30' })).toBeTruthy();
  });
  it('submits the exact displayed binding through keyboard approval, never implicit apply or feedback', async () => {
    const callbacks = host();
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const approve = await screen.findByRole('button', { name: 'Approve' });
    approve.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(callbacks.decide).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'action',
          expectedRevision: 2,
          expectedReviewVersion: 4,
          bindingHash: 'binding',
          decision: 'approve',
          requestId: expect.any(String),
        }),
      ),
    );
    expect(callbacks.apply).not.toHaveBeenCalled();
    expect(callbacks.feedback).not.toHaveBeenCalled();
  });
  it('requires saving edited arguments and reloading before a separate approval', async () => {
    const callbacks = host();
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const editor = await screen.findByRole('textbox', {
      name: 'Exact arguments (JSON)',
    });
    await fireEvent.input(editor, {
      target: { value: '{"title":"Corrected"}' },
    });
    expect(
      (screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await fireEvent.click(
      screen.getByRole('button', { name: 'Save edits for new review' }),
    );
    await waitFor(() =>
      expect(callbacks.decide).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'correct',
          correctedArgs: { title: 'Corrected' },
          expectedReviewVersion: 4,
        }),
      ),
    );
    expect(callbacks.decide).toHaveBeenCalledTimes(1);
    expect(callbacks.apply).not.toHaveBeenCalled();
  });
  it('clears sensitive content on rejected stale mutation and never renders raw errors', async () => {
    const callbacks = host();
    vi.mocked(callbacks.decide).mockRejectedValue(
      new Error('SECRET backend credential'),
    );
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Approve' }),
    );
    await screen.findByRole('alert');
    expect(screen.queryByText('Private invoice')).toBeNull();
    expect(screen.queryByText(/confidential/)).toBeNull();
    expect(screen.queryByText(/SECRET/)).toBeNull();
    expect(
      screen.queryByRole('textbox', { name: 'Exact arguments (JSON)' }),
    ).toBeNull();
  });
  it('fences old load completion after host context changes', async () => {
    const old = deferred<ItemReviewView>();
    const callbacks = host();
    vi.mocked(callbacks.load)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue({ ...page(), availability: 'revoked' });
    const component = render(IntakeReview, {
      host: callbacks,
      itemId: 'item',
      contextKey: 'tenant-a',
    });
    await waitFor(() => expect(callbacks.load).toHaveBeenCalledTimes(1));
    await component.rerender({
      host: callbacks,
      itemId: 'item',
      contextKey: 'tenant-b',
    });
    await screen.findByText('Access revoked');
    old.resolve(page());
    await waitFor(() =>
      expect(screen.queryByText('Private invoice')).toBeNull(),
    );
    expect(screen.queryByTestId('evidence-viewer')).toBeNull();
  });
  it('rejects malformed argument edits locally', async () => {
    const callbacks = host();
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    await fireEvent.input(
      await screen.findByRole('textbox', { name: 'Exact arguments (JSON)' }),
      { target: { value: '[]' } },
    );
    await fireEvent.click(
      screen.getByRole('button', { name: 'Save edits for new review' }),
    );
    await screen.findByRole('alert');
    expect(callbacks.decide).not.toHaveBeenCalled();
  });
  it.each([
    'stale',
    'revoked',
    'expired',
    'unavailable',
  ] as const)('redacts %s host projections even if they contain stale data', async (availability) => {
    render(IntakeReview, {
      host: host({ ...page(), availability }),
      itemId: 'item',
    });
    await screen.findByRole('alert');
    expect(screen.queryByText('Private invoice')).toBeNull();
    expect(screen.queryByTestId('evidence-viewer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
  it('only renders safe authorized media URLs and escapes hostile email', () => {
    const evidence: EvidenceView[] = [
      'application/pdf',
      'image/png',
      'audio/wav',
      'message/rfc822',
    ].map((mediaType, index) => ({
      evidence: {
        ...page().evidence[0].evidence,
        id: String(index),
        mediaType,
      },
      label: `Original ${index}`,
      viewUrl: `/media/${index}`,
      text:
        index === 3 ? '<script>window.compromised=true</script>' : undefined,
    }));
    const { container } = render(EvidenceViewer, { evidence });
    expect(container.querySelectorAll('iframe').length).toBe(1);
    expect(container.querySelectorAll('img').length).toBe(1);
    expect(container.querySelectorAll('audio').length).toBe(1);
    expect(container.querySelector('script')).toBeNull();
    expect(
      screen.getByText('<script>window.compromised=true</script>'),
    ).toBeTruthy();
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,evil',
      'https://other.example/file',
      '//other.example/file',
    ])
      expect(evidenceUrl(url, 'https://host.example')).toBeUndefined();
  });
  it('shows authorized candidates and saves destination correction without approval', async () => {
    const view = page();
    view.generation = {
      version: 1,
      outcome: 'proposals',
      suggestions: [],
      splits: [],
      warnings: [],
      omittedSuggestions: 0,
      source: {
        attemptId: 'attempt',
        revision: 2,
        inputDigest: 'in',
        outputDigest: 'out',
        evidenceDigest: 'evidence',
      },
      offered: [
        {
          handler: {
            id: 'draft',
            version: '1',
            description: 'Draft',
            kind: 'operation',
            capability: null,
            argsSchema: {},
            references: {
              destination: { kind: 'candidate', model: 'Document' },
            },
            operation: { model: 'Document', action: 'create', version: '1' },
          },
          candidates: [],
        },
      ],
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
    };
    const callbacks = host(view);
    vi.mocked(callbacks.candidates).mockResolvedValue({
      items: [
        {
          key: 'target',
          model: 'Document',
          id: 'authorized-id',
          revision: '1',
          label: 'Authorized destination',
        },
      ],
      truncated: false,
    });
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    await fireEvent.change(
      await screen.findByRole('combobox', { name: 'Argument field' }),
      { target: { value: 'destination' } },
    );
    await fireEvent.click(
      screen.getByRole('button', { name: 'Search destinations' }),
    );
    await screen.findByText('Authorized destination');
    await fireEvent.click(
      screen.getByRole('button', { name: 'Choose destination' }),
    );
    await fireEvent.click(
      screen.getByRole('button', { name: 'Save edits for new review' }),
    );
    await waitFor(() =>
      expect(callbacks.decide).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'correct',
          correctedArgs: { title: 'Invoice', destination: 'authorized-id' },
        }),
      ),
    );
  });
  it('uploads explicit files and opens the returned item without guessing review state', async () => {
    const callbacks = host();
    const onselect = vi.fn();
    const { container } = render(IntakeInbox, { host: callbacks, onselect });
    await screen.findByText('Private invoice');
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    await fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [new File(['PDF'], 'invoice.pdf', { type: 'application/pdf' })],
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(onselect).toHaveBeenCalledWith('uploaded'));
    expect(callbacks.decide).not.toHaveBeenCalled();
    expect(callbacks.apply).not.toHaveBeenCalled();
  });
  it('displays persisted results after explicit apply and does not infer correctness', async () => {
    const view = page();
    view.reviews.actions[0].review.state = 'authorized';
    const callbacks = host(view);
    vi.mocked(callbacks.apply).mockImplementation(async () => {
      view.reviews.actions[0].result = {
        actionId: 'action',
        state: 'succeeded',
        result: { id: 'created-record' },
      };
      view.reviews.actions[0].review.state = 'succeeded';
      return view.reviews.actions[0].result;
    });
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Apply approved action' }),
    );
    await screen.findByText(/created-record/);
    expect(callbacks.apply).toHaveBeenCalledWith('action');
    expect(callbacks.feedback).not.toHaveBeenCalled();
  });
  it('requires fresh explicit arguments to recover a stale operation without approving it', async () => {
    const view = page();
    view.reviews.actions = [
      {
        review: {
          ...view.reviews.actions[0].review,
          state: 'stale',
          display: {},
        },
        attemptId: 'current-attempt',
        handlerId: 'draft',
        handlerVersion: '1',
      },
    ];
    const callbacks = host(view);
    callbacks.editAction = vi.fn(async () => {});
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const editor = await screen.findByRole('textbox', {
      name: 'Exact arguments (JSON)',
    });
    expect((editor as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    await fireEvent.input(editor, {
      target: { value: '{"title":"Fresh human input"}' },
    });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Save edits for new review' }),
    );
    await waitFor(() =>
      expect(callbacks.editAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'action',
          attemptId: 'current-attempt',
          expectedRevision: 2,
          args: { title: 'Fresh human input' },
        }),
      ),
    );
    expect(callbacks.decide).not.toHaveBeenCalled();
    expect(callbacks.apply).not.toHaveBeenCalled();
  });
  it('recovers a stale plan only from authorized reload identity and fresh arguments', async () => {
    const view = page();
    view.reviews.actions = [
      {
        review: {
          ...view.reviews.actions[0].review,
          state: 'stale',
          display: {},
        },
        attemptId: 'generation-attempt',
        stalePlan: {
          id: 'plan',
          key: 'parent',
          revision: 7,
          handlerId: 'plan-handler',
          handlerVersion: '1',
        },
      },
    ];
    const callbacks = host(view);
    callbacks.editPlan = vi.fn(async () => {});
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const editor = await screen.findByRole('textbox', {
      name: 'Plan arguments (JSON)',
    });
    expect((editor as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Apply approved action' }),
    ).toBeNull();
    await fireEvent.input(editor, {
      target: { value: '{"title":"Fresh explicit plan"}' },
    });
    await fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit the plan and review its new steps',
      }),
    );
    await waitFor(() =>
      expect(callbacks.editPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'item',
          planKey: 'parent',
          attemptId: 'generation-attempt',
          expectedRevision: 7,
          handlerId: 'plan-handler',
          handlerVersion: '1',
          args: { title: 'Fresh explicit plan' },
        }),
      ),
    );
    expect(callbacks.decide).not.toHaveBeenCalled();
    expect(callbacks.apply).not.toHaveBeenCalled();
  });
  it('edits parent plans through re-expansion, never step correction', async () => {
    const view = page();
    view.reviews.actions[0].plan = {
      id: 'plan',
      key: 'parent',
      revision: 7,
      stepIndex: 0,
      args: { title: 'Plan' },
      handlerId: 'plan-handler',
      handlerVersion: '1',
      attemptId: 'attempt',
    };
    const callbacks = host(view);
    callbacks.editPlan = vi.fn(async () => {});
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const editor = await screen.findByRole('textbox', {
      name: 'Exact arguments (JSON)',
    });
    expect((editor as HTMLTextAreaElement).readOnly).toBe(true);
    expect(
      screen.queryByRole('button', { name: 'Save edits for new review' }),
    ).toBeNull();
    await fireEvent.input(
      screen.getByRole('textbox', { name: 'Plan arguments (JSON)' }),
      { target: { value: '{"title":"Changed plan"}' } },
    );
    await fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit the plan and review its new steps',
      }),
    );
    await waitFor(() =>
      expect(callbacks.editPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'item',
          planKey: 'parent',
          attemptId: 'attempt',
          expectedRevision: 7,
          handlerId: 'plan-handler',
          handlerVersion: '1',
          args: { title: 'Changed plan' },
        }),
      ),
    );
    expect(callbacks.decide).not.toHaveBeenCalled();
  });
  it('submits edited logical groups with the current analysis revision and retains originals until reload', async () => {
    const view = page();
    view.generation = {
      version: 1,
      outcome: 'needs_review',
      suggestions: [],
      splits: [{ evidenceId: 'original', groups: [[1], [2]], digest: 'split' }],
      warnings: [],
      omittedSuggestions: 0,
      source: {
        attemptId: 'attempt',
        revision: 2,
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
    };
    view.analysis = currentAnalysis();
    const callbacks = host(view);
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const groups = await screen.findByRole('textbox', {
      name: 'Logical page groups (JSON): original',
    });
    await fireEvent.input(groups, { target: { value: '[[0]]' } });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Save split and reprocess' }),
    );
    expect(callbacks.split).not.toHaveBeenCalled();
    await fireEvent.input(groups, { target: { value: '[[1,2]]' } });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Save split and reprocess' }),
    );
    await waitFor(() =>
      expect(callbacks.split).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'item',
          attemptId: 'generation-attempt',
          expectedRevision: 9,
          evidenceId: 'original',
          groups: [[1, 2]],
          requestId: expect.any(String),
        }),
      ),
    );
    await screen.findByText(/confidential/);
    expect(callbacks.decide).not.toHaveBeenCalled();
  });
  it('previews the current generation attempt rather than its extraction source pin', async () => {
    const view = page();
    view.generation = {
      version: 1,
      outcome: 'needs_review',
      suggestions: [],
      splits: [{ evidenceId: 'original', groups: [[1], [2]], digest: 'split' }],
      warnings: [],
      omittedSuggestions: 0,
      source: {
        attemptId: 'attempt',
        revision: 2,
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
    };
    view.analysis = currentAnalysis();
    view.generation.suggestions = [
      {
        handlerId: 'draft',
        handlerVersion: '1',
        args: { title: 'Invoice' },
        evidence: [],
        alternatives: [],
        missingFields: [],
        explanation: 'Draft proposal',
        disposition: 'ready_for_review',
      },
    ];
    const callbacks = host(view);
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Prepare review' }),
    );
    await waitFor(() =>
      expect(callbacks.preview).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'item',
          attemptId: 'generation-attempt',
          index: 0,
        }),
      ),
    );
    expect(view.generation.source.attemptId).toBe('attempt');
  });
  it.each([
    'missing-analysis',
    'provider-error',
  ] as const)('does not offer misleading preview for %s', async (reason) => {
    const view = page();
    view.generation = {
      version: 1,
      outcome: 'needs_review',
      suggestions: [],
      splits: [{ evidenceId: 'original', groups: [[1], [2]], digest: 'split' }],
      warnings: [],
      omittedSuggestions: 0,
      source: {
        attemptId: 'attempt',
        revision: 2,
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
    };
    if (reason !== 'missing-analysis') view.analysis = currentAnalysis();
    if (reason === 'provider-error') view.generation.outcome = 'provider_error';
    view.generation.suggestions = [
      {
        handlerId: 'draft',
        handlerVersion: '1',
        args: {},
        evidence: [],
        alternatives: [],
        missingFields: [],
        explanation: 'Proposal',
        disposition: 'ready_for_review',
      },
    ];
    const callbacks = host(view);
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const prepare = await screen.findByRole('button', {
      name: 'Prepare review',
    });
    expect((prepare as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(prepare);
    expect(callbacks.preview).not.toHaveBeenCalled();
  });
  function needsReviewView(missingFields: string[]) {
    const view = page();
    view.analysis = currentAnalysis();
    view.generation = {
      version: 1,
      outcome: 'needs_review',
      suggestions: [
        {
          handlerId: 'draft',
          handlerVersion: '1',
          args: { body: 'Minutes' },
          evidence: [],
          alternatives: [],
          missingFields,
          explanation: 'Incomplete proposal',
          disposition: 'needs_review',
        },
      ],
      splits: [],
      warnings: [],
      omittedSuggestions: 0,
      source: {
        attemptId: 'attempt',
        revision: 2,
        inputDigest: 'in',
        outputDigest: 'out',
        evidenceDigest: 'evidence',
      },
      offered: [
        {
          handler: {
            id: 'draft',
            version: '1',
            description: 'Draft',
            kind: 'operation',
            capability: null,
            argsSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'body'],
              properties: { title: {}, body: {}, destination: {} },
            },
            references: {
              destination: { kind: 'candidate', model: 'Document' },
            },
            operation: { model: 'Document', action: 'create', version: '1' },
          },
          candidates: [],
        },
      ],
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
    };
    view.reviews.actions = [];
    return view;
  }
  it('lets a reviewer complete a needs_review suggestion before preview (#4208)', async () => {
    const callbacks = host(needsReviewView(['title']));
    vi.mocked(callbacks.candidates).mockResolvedValue({
      items: [
        {
          key: 'target',
          model: 'Document',
          id: 'authorized-id',
          revision: '1',
          label: 'Authorized destination',
        },
      ],
      truncated: false,
    });
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const prepare = await screen.findByRole('button', {
      name: 'Prepare review',
    });
    expect(screen.getByText('Missing information')).toBeTruthy();
    expect(screen.getByText('title')).toBeTruthy();
    expect((prepare as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.change(
      screen.getByRole('combobox', { name: 'Argument field' }),
      { target: { value: 'destination' } },
    );
    await fireEvent.click(
      screen.getByRole('button', { name: 'Search destinations' }),
    );
    await screen.findByText('Authorized destination');
    await fireEvent.click(
      screen.getByRole('button', { name: 'Choose destination' }),
    );
    const draft = screen.getByRole('textbox', {
      name: 'Suggested arguments (JSON)',
    }) as HTMLTextAreaElement;
    expect(JSON.parse(draft.value)).toEqual({
      body: 'Minutes',
      destination: 'authorized-id',
    });
    await fireEvent.input(draft, {
      target: {
        value: JSON.stringify({
          body: 'Minutes',
          destination: 'authorized-id',
          title: 'Human title',
        }),
      },
    });
    await waitFor(() =>
      expect((prepare as HTMLButtonElement).disabled).toBe(false),
    );
    await fireEvent.click(prepare);
    await waitFor(() =>
      expect(callbacks.preview).toHaveBeenCalledWith({
        itemId: 'item',
        attemptId: 'generation-attempt',
        index: 0,
        requestId: expect.any(String),
        args: {
          body: 'Minutes',
          destination: 'authorized-id',
          title: 'Human title',
        },
      }),
    );
    expect(callbacks.decide).not.toHaveBeenCalled();
    expect(callbacks.apply).not.toHaveBeenCalled();
  });
  it('previews a complete needs_review suggestion without inventing arguments', async () => {
    const view = needsReviewView([]);
    view.generation!.suggestions[0].args = { title: 'Minutes', body: 'Body' };
    const callbacks = host(view);
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const prepare = await screen.findByRole('button', {
      name: 'Prepare review',
    });
    expect((prepare as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.click(prepare);
    await waitFor(() => expect(callbacks.preview).toHaveBeenCalledTimes(1));
    expect(vi.mocked(callbacks.preview).mock.calls[0][0]).not.toHaveProperty(
      'args',
    );
  });
  it('rejects an unparsable suggestion draft locally without calling the host', async () => {
    const callbacks = host(needsReviewView(['title']));
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const prepare = await screen.findByRole('button', {
      name: 'Prepare review',
    });
    await fireEvent.input(
      screen.getByRole('textbox', { name: 'Suggested arguments (JSON)' }),
      { target: { value: '{"title":' } },
    );
    await waitFor(() =>
      expect((prepare as HTMLButtonElement).disabled).toBe(false),
    );
    await fireEvent.click(prepare);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(callbacks.preview).not.toHaveBeenCalled();
  });
  it('fails closed when a preview throws, clearing originals and the view', async () => {
    const callbacks = host(needsReviewView(['title']));
    vi.mocked(callbacks.preview).mockRejectedValue(new Error('Denied'));
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const prepare = await screen.findByRole('button', {
      name: 'Prepare review',
    });
    await fireEvent.input(
      screen.getByRole('textbox', { name: 'Suggested arguments (JSON)' }),
      {
        target: {
          value: JSON.stringify({ body: 'Minutes', title: 'Human title' }),
        },
      },
    );
    await waitFor(() =>
      expect((prepare as HTMLButtonElement).disabled).toBe(false),
    );
    await fireEvent.click(prepare);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This view is unavailable',
    );
    expect(screen.queryByTestId('evidence-viewer')).toBeNull();
    expect(
      screen.queryByRole('textbox', { name: 'Suggested arguments (JSON)' }),
    ).toBeNull();
    expect(screen.queryByText('confidential', { exact: false })).toBeNull();
  });
  it('keeps the typed draft and shows an inline refusal when the handler rejects the arguments', async () => {
    const callbacks = host(needsReviewView(['title']));
    vi.mocked(callbacks.preview).mockResolvedValue({ rejected: 'invalid' });
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const prepare = await screen.findByRole('button', {
      name: 'Prepare review',
    });
    const typed = JSON.stringify({ body: 'Minutes', title: 'Human title' });
    await fireEvent.input(
      screen.getByRole('textbox', { name: 'Suggested arguments (JSON)' }),
      { target: { value: typed } },
    );
    await waitFor(() =>
      expect((prepare as HTMLButtonElement).disabled).toBe(false),
    );
    await fireEvent.click(prepare);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'did not pass the handler validation',
    );
    expect(screen.getByTestId('evidence-viewer')).toBeTruthy();
    expect(callbacks.preview).toHaveBeenCalledTimes(1);
    expect(callbacks.load).toHaveBeenCalledTimes(1);
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Suggested arguments (JSON)',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe(typed);
    expect(screen.getByText('Missing information')).toBeTruthy();
    expect((prepare as HTMLButtonElement).disabled).toBe(false);
  });
  it('keeps Prepare review disabled until every schema-required argument is in the draft', async () => {
    const callbacks = host(needsReviewView(['title']));
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const prepare = await screen.findByRole('button', {
      name: 'Prepare review',
    });
    const draft = screen.getByRole('textbox', {
      name: 'Suggested arguments (JSON)',
    });
    // Edited, but `title` is still absent: the handler schema would reject it.
    await fireEvent.input(draft, {
      target: { value: JSON.stringify({ body: 'Minutes', note: 'x' }) },
    });
    await tick();
    expect((prepare as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.input(draft, {
      target: { value: JSON.stringify({ body: 'Minutes', title: 'T' }) },
    });
    await waitFor(() =>
      expect((prepare as HTMLButtonElement).disabled).toBe(false),
    );
    expect(callbacks.preview).not.toHaveBeenCalled();
  });
  it('fails closed when a destination search throws, keeping only the in-memory draft', async () => {
    const callbacks = host(needsReviewView(['title']));
    vi.mocked(callbacks.candidates).mockRejectedValue(new Error('Denied'));
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const draft = (await screen.findByRole('textbox', {
      name: 'Suggested arguments (JSON)',
    })) as HTMLTextAreaElement;
    const typed = JSON.stringify({ body: 'Minutes', title: 'Keep me' });
    await fireEvent.input(draft, { target: { value: typed } });
    await fireEvent.change(
      screen.getByRole('combobox', { name: 'Argument field' }),
      { target: { value: 'destination' } },
    );
    await fireEvent.click(
      screen.getByRole('button', { name: 'Search destinations' }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This view is unavailable',
    );
    expect(screen.queryByTestId('evidence-viewer')).toBeNull();
    expect(
      screen.queryByRole('textbox', { name: 'Suggested arguments (JSON)' }),
    ).toBeNull();
    // After an authorized refresh the reviewer's own typing is still there.
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(
      (
        (await screen.findByRole('textbox', {
          name: 'Suggested arguments (JSON)',
        })) as HTMLTextAreaElement
      ).value,
    ).toBe(typed);
  });
  it('keeps every card draft across a failed action and the following refresh', async () => {
    const view = needsReviewView(['title']);
    view.generation!.suggestions.push({
      ...structuredClone(view.generation!.suggestions[0]),
      args: { body: 'Second' },
    });
    view.generation!.splits = [
      { evidenceId: 'original', groups: [[1]], digest: 'split' },
    ];
    const callbacks = host(view);
    vi.mocked(callbacks.split).mockRejectedValue(new Error('Denied'));
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const drafts = (await screen.findAllByRole('textbox', {
      name: 'Suggested arguments (JSON)',
    })) as HTMLTextAreaElement[];
    expect(drafts).toHaveLength(2);
    const first = JSON.stringify({ body: 'Minutes', title: 'A' });
    const second = JSON.stringify({ body: 'Second', title: 'B' });
    await fireEvent.input(drafts[0], { target: { value: first } });
    await fireEvent.input(drafts[1], { target: { value: second } });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Save split and reprocess' }),
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const restored = (await screen.findAllByRole('textbox', {
      name: 'Suggested arguments (JSON)',
    })) as HTMLTextAreaElement[];
    expect(restored.map((area) => area.value)).toEqual([first, second]);
    expect(callbacks.preview).not.toHaveBeenCalled();
  });
  it.each([
    ['unavailable', true],
    ['stale', true],
    ['revoked', false],
    ['expired', false],
  ] as const)('a %s refresh keeps drafts: %s', async (availability, kept) => {
    const ready = needsReviewView(['title']);
    const callbacks = host(ready);
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const draft = (await screen.findByRole('textbox', {
      name: 'Suggested arguments (JSON)',
    })) as HTMLTextAreaElement;
    const typed = JSON.stringify({ body: 'Minutes', title: 'Typed' });
    await fireEvent.input(draft, { target: { value: typed } });
    vi.mocked(callbacks.load).mockResolvedValueOnce({
      ...structuredClone(ready),
      availability,
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(callbacks.load).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByRole('textbox', { name: 'Suggested arguments (JSON)' }),
      ).toBeNull(),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const restored = (await screen.findByRole('textbox', {
      name: 'Suggested arguments (JSON)',
    })) as HTMLTextAreaElement;
    expect(restored.value).toBe(
      kept ? typed : JSON.stringify({ body: 'Minutes' }, null, 2),
    );
  });
  it('keeps unsent drafts across Refresh and clears the JSON alert once the draft parses', async () => {
    const callbacks = host(needsReviewView(['title']));
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const draft = (await screen.findByRole('textbox', {
      name: 'Suggested arguments (JSON)',
    })) as HTMLTextAreaElement;
    await fireEvent.input(draft, { target: { value: '{"title":' } });
    const prepare = screen.getByRole('button', { name: 'Prepare review' });
    await waitFor(() =>
      expect((prepare as HTMLButtonElement).disabled).toBe(false),
    );
    await fireEvent.click(prepare);
    expect(await screen.findByRole('alert')).toBeTruthy();
    const typed = JSON.stringify({ body: 'Minutes', title: 'Fixed' });
    await fireEvent.input(draft, { target: { value: typed } });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(callbacks.load).toHaveBeenCalledTimes(2));
    expect(
      (
        (await screen.findByRole('textbox', {
          name: 'Suggested arguments (JSON)',
        })) as HTMLTextAreaElement
      ).value,
    ).toBe(typed);
    expect(callbacks.preview).not.toHaveBeenCalled();
  });
  it('shows required arguments missing from an action draft while editing', async () => {
    const view = page();
    view.generation = needsReviewView([]).generation;
    view.generation!.suggestions = [];
    view.reviews.actions[0].args = { title: 'Invoice', body: 'Body' };
    render(IntakeReview, { host: host(view), itemId: 'item' });
    const args = (await screen.findByRole('textbox', {
      name: 'Exact arguments (JSON)',
    })) as HTMLTextAreaElement;
    expect(screen.queryByText('Missing information')).toBeNull();
    await fireEvent.input(args, { target: { value: '{"body":"x"}' } });
    expect(await screen.findByText('Missing information')).toBeTruthy();
    expect(screen.getByText('title')).toBeTruthy();
  });
  it('re-previews approved edits with exact action revision and dependencies, requiring new approval', async () => {
    const view = page();
    const action = view.reviews.actions[0];
    action.review.state = 'authorized';
    action.review.revision = 7;
    action.attemptId = 'generation-attempt';
    action.dependencies = {
      parent: {
        actionId: 'parent-action',
        proposalRevision: 3,
        resultField: 'id',
        expectedModel: 'Document',
      },
    };
    const callbacks = host(view);
    callbacks.editAction = vi.fn(async (input) => {
      action.args = input.args;
      action.review = {
        ...action.review,
        revision: 8,
        reviewVersion: 5,
        bindingHash: 'new-binding',
        state: 'waiting_review',
      };
    });
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const editor = await screen.findByRole('textbox', {
      name: 'Exact arguments (JSON)',
    });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    await fireEvent.input(editor, {
      target: { value: '{"title":"Changed approved args"}' },
    });
    expect(
      (
        screen.getByRole('button', {
          name: 'Apply approved action',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await fireEvent.click(
      screen.getByRole('button', { name: 'Save edits for new review' }),
    );
    await waitFor(() =>
      expect(callbacks.editAction).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'item',
          actionId: 'action',
          attemptId: 'generation-attempt',
          expectedRevision: 7,
          handlerId: 'draft',
          handlerVersion: '1',
          args: { title: 'Changed approved args' },
          dependencies: action.dependencies,
        }),
      ),
    );
    await screen.findByRole('button', { name: 'Approve' });
    expect(callbacks.decide).not.toHaveBeenCalled();
    expect(callbacks.apply).not.toHaveBeenCalled();
  });
  it('omits absent reason from direct review callbacks', async () => {
    const callbacks = host();
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Approve' }),
    );
    await waitFor(() => expect(callbacks.decide).toHaveBeenCalled());
    expect(
      Object.hasOwn(vi.mocked(callbacks.decide).mock.calls[0][0], 'reason'),
    ).toBe(false);
  });
  it('does not render correctness controls without an explicit feedback callback', async () => {
    const callbacks = host();
    delete callbacks.feedback;
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    await screen.findByRole('button', { name: 'Approve' });
    expect(screen.queryByText('Explicit correctness feedback')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Correct$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Incorrect$/ })).toBeNull();
  });
  it('renders extracted text and supplied locations without internal metadata or invented confidence', async () => {
    const view = page();
    view.analysis = currentAnalysis();
    view.analysis.result.output = {
      configurationRevision: 'INTERNAL_CONFIG',
      results: [
        {
          evidence: { id: 'original' },
          provenance: { model: 'INTERNAL_MODEL' },
          segments: [
            {
              text: 'Extracted invoice text',
              location: { kind: 'page', page: 3 },
              confidence: null,
            },
          ],
        },
      ],
    };
    render(IntakeReview, { host: host(view), itemId: 'item' });
    await screen.findByText('Extracted invoice text');
    expect(screen.getByText('Confidence unavailable')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Page 3' })).toBeTruthy();
    expect(screen.queryByText(/INTERNAL_/)).toBeNull();
  });
  it('links only supplied valid audio times and leaves absent or invalid offsets unlinked', async () => {
    const view = page();
    view.evidence = [
      {
        ...view.evidence[0],
        evidence: {
          ...view.evidence[0].evidence,
          id: 'audio',
          mediaType: 'audio/wav',
        },
        viewUrl: '/media/audio',
      },
    ];
    view.analysis = currentAnalysis();
    view.analysis.result.output = {
      results: [
        {
          evidence: { id: 'audio' },
          segments: [
            {
              text: 'Spoken words',
              location: { kind: 'time', startMs: 1200, endMs: 3400 },
            },
            { text: 'No timestamp', location: { kind: 'source' } },
            {
              text: 'Invalid timestamp',
              location: { kind: 'time', startMs: 5000, endMs: 1000 },
            },
          ],
        },
      ],
    };
    const { container } = render(IntakeReview, {
      host: host(view),
      itemId: 'item',
    });
    const link = await screen.findByRole('link', { name: '1.2–3.4 seconds' });
    expect(link.getAttribute('href')).toMatch(/\/media\/audio#t=1\.2,3\.4$/);
    expect(container.querySelectorAll('a[href*="#t="]')).toHaveLength(1);
    expect(screen.getByText('No timestamp')).toBeTruthy();
    expect(screen.getByText('Invalid timestamp')).toBeTruthy();
  });
  it('does not dump interpretation metadata as extracted information', async () => {
    const view = page();
    view.analysis = currentAnalysis();
    view.analysis.result.output = {
      proposals: {
        source: { inputDigest: 'INTERNAL_DIGEST' },
        configuration: 'INTERNAL_CONFIGURATION',
      },
    };
    view.generation = {
      version: 1,
      outcome: 'needs_review',
      suggestions: [],
      splits: [{ evidenceId: 'original', groups: [[1], [2]], digest: 'split' }],
      warnings: [],
      omittedSuggestions: 0,
      source: {
        attemptId: 'attempt',
        revision: 2,
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
    };
    render(IntakeReview, { host: host(view), itemId: 'item' });
    await screen.findByRole('button', { name: 'Approve' });
    expect(screen.queryByText('Extracted information')).toBeNull();
    expect(screen.getByText('Confidence unavailable')).toBeTruthy();
    expect(screen.queryByText(/INTERNAL_/)).toBeNull();
  });
  it('binds explicit correctness to the displayed action revision and never submits approval', async () => {
    const callbacks = host();
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const editor = (await screen.findByRole('textbox', {
      name: 'Exact arguments (JSON)',
    })) as HTMLTextAreaElement;
    const saved = editor.value;
    await fireEvent.input(editor, {
      target: { value: '{"title":"Unsaved correction"}' },
    });
    expect(
      (screen.getByRole('button', { name: /^Correct$/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: /^Incorrect$/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(callbacks.feedback).not.toHaveBeenCalled();
    await fireEvent.input(editor, { target: { value: saved } });
    await fireEvent.click(
      await screen.findByRole('button', { name: /^Incorrect$/ }),
    );
    await waitFor(() =>
      expect(callbacks.feedback).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'item',
          actionId: 'action',
          expectedRevision: 2,
          expectedReviewVersion: 4,
          bindingHash: 'binding',
          judgment: 'incorrect',
        }),
      ),
    );
    expect(callbacks.decide).not.toHaveBeenCalled();
    expect(callbacks.apply).not.toHaveBeenCalled();
  });
  it('filters and assigns using the host assignment version', async () => {
    const callbacks = host();
    render(IntakeInbox, { host: callbacks });
    await screen.findByText('Private invoice');
    await fireEvent.change(screen.getByRole('combobox', { name: 'State' }), {
      target: { value: 'deferred' },
    });
    await waitFor(() =>
      expect(callbacks.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'deferred' }),
      ),
    );
    await fireEvent.input(
      await screen.findByRole('textbox', {
        name: 'Assignee ID: Private invoice',
      }),
      { target: { value: 'operator' } },
    );
    await fireEvent.click(
      screen.getByRole('button', { name: 'Save assignment' }),
    );
    await waitFor(() =>
      expect(callbacks.assign).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'item',
          expectedVersion: 3,
          assigneeId: 'operator',
        }),
      ),
    );
  });
});
