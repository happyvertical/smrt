import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet, tick } from 'svelte';
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
  function instructionView(
    id: string,
  ): NonNullable<ItemReviewView['instruction']>['current'] {
    return {
      id,
      text: `Instruction ${id}`,
      actorId: 'owner',
      recordedAt: '2026-10-22T00:00:00.000Z',
      supersedesId: null,
      digest: `digest-${id}`,
    };
  }
  function generationFor(view: ItemReviewView) {
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
    return view;
  }
  it.each([
    true,
    false,
  ])('renders the host review annotation with held=%s without invoking an action', async (held) => {
    const view = generationFor(page());
    view.generation!.suggestions = [
      {
        handlerId: 'draft',
        handlerVersion: '1',
        args: { title: 'Invoice' },
        evidence: [],
        alternatives: [],
        missingFields: [],
        explanation: 'An invoice draft.',
        disposition: held ? 'needs_review' : 'ready_for_review',
        hostReview: {
          held,
          reasons: ['total_not_in_text'],
          prefilled: ['title'],
        },
      },
    ];
    const callbacks = host(view);
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const annotation = await screen.findByTestId('host-review');
    expect(annotation.textContent).toContain('title');
    expect(annotation.textContent).toContain('total_not_in_text');
    expect(annotation.textContent?.includes('held for review')).toBe(held);
    expect(callbacks.preview).not.toHaveBeenCalled();
    expect(callbacks.decide).not.toHaveBeenCalled();
    expect(callbacks.apply).not.toHaveBeenCalled();
  });
  it('records reviewer instructions against the current analysis revision and polls until the background reinterpretation lands in place', async () => {
    const before = generationFor(page());
    const processing: ItemReviewView = {
      ...page(),
      entry: {
        ...page().entry,
        state: 'processing',
        item: { ...page().entry.item, processingState: 'running' },
      },
      instruction: {
        current: instructionView('new'),
        applied: null,
        stale: false,
      },
    };
    const after = generationFor(page());
    after.instruction = {
      current: instructionView('new'),
      applied: instructionView('new'),
      stale: false,
    };
    const callbacks = host(before);
    const sequence = [before, processing, processing, after];
    const load = vi.fn(async () =>
      structuredClone(sequence.length > 1 ? sequence.shift()! : sequence[0]),
    );
    callbacks.load = load;
    callbacks.instruct = vi.fn(async () => {});
    render(IntakeReview, { host: callbacks, itemId: 'item', pollMs: 5 });
    const box = await screen.findByRole('textbox', {
      name: 'Instructions for the assistant',
    });
    const button = screen.getByRole('button', {
      name: 'Re-read with these instructions',
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    await fireEvent.input(box, { target: { value: '  ' } });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.input(box, {
      target: { value: 'Customer PO from Badger. File it, do not bill it.' },
    });
    await fireEvent.click(button);
    await waitFor(() =>
      expect(callbacks.instruct).toHaveBeenCalledWith({
        itemId: 'item',
        attemptId: 'generation-attempt',
        expectedRevision: 9,
        text: 'Customer PO from Badger. File it, do not bill it.',
        requestId: expect.any(String),
      }),
    );
    await screen.findByTestId('reinterpreting');
    expect(screen.getByTestId('pending-instruction').textContent).toContain(
      'Instruction new',
    );
    await screen.findByTestId('applied-instruction');
    expect(screen.queryByTestId('reinterpreting')).toBeNull();
    expect(screen.queryByTestId('instruction-stale')).toBeNull();
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(callbacks.decide).not.toHaveBeenCalled();
    expect(callbacks.preview).not.toHaveBeenCalled();
  });
  it('shows which instruction produced the current suggestions and marks a superseded one as stale', async () => {
    const view = generationFor(page());
    view.instruction = {
      current: instructionView('later'),
      applied: instructionView('earlier'),
      stale: true,
    };
    const callbacks = host(view);
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    expect(
      (await screen.findByTestId('applied-instruction')).textContent,
    ).toContain('Instruction earlier');
    expect(screen.getByTestId('instruction-stale')).toBeTruthy();
    expect(screen.getByTestId('pending-instruction').textContent).toContain(
      'Instruction later',
    );
    expect(screen.queryByTestId('reinterpreting')).toBeNull();
    // Without an instruct callback the control is absent; presence confers nothing.
    expect(
      screen.queryByRole('textbox', { name: 'Instructions for the assistant' }),
    ).toBeNull();
  });
  it('polls in place after an instruction when an action already exists, keeping drafts and never blanking the view', async () => {
    const before = generationFor(page());
    const processing = generationFor(page());
    processing.analysis = undefined;
    processing.generation = undefined;
    processing.entry = {
      ...processing.entry,
      state: 'waiting',
      item: { ...processing.entry.item, processingState: 'running' },
    };
    processing.reviews.actions[0].review.state = 'stale';
    processing.instruction = {
      current: instructionView('new'),
      applied: null,
      stale: false,
      binding: { attemptId: 'generation-attempt', expectedRevision: 10 },
    };
    const after = generationFor(page());
    after.instruction = {
      current: instructionView('new'),
      applied: instructionView('new'),
      stale: false,
    };
    const callbacks = host(before);
    const sequence = [before, processing, processing, processing, after];
    const load = vi.fn(async () =>
      structuredClone(sequence.length > 1 ? sequence.shift()! : sequence[0]),
    );
    callbacks.load = load;
    callbacks.instruct = vi.fn(async () => {});
    render(IntakeReview, { host: callbacks, itemId: 'item', pollMs: 5 });
    const box = await screen.findByRole('textbox', {
      name: 'Instructions for the assistant',
    });
    await fireEvent.input(box, { target: { value: 'File it.' } });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Re-read with these instructions' }),
    );
    await screen.findByTestId('reinterpreting');
    // The earlier action is still listed (stale) and the state is not processing,
    // yet the item-level processing flag drives the poll.
    expect(screen.getByText('Waiting')).toBeTruthy();
    const draftBox = screen.getByRole('textbox', {
      name: 'Instructions for the assistant',
    }) as HTMLTextAreaElement;
    expect(draftBox.value).toBe('');
    await fireEvent.input(draftBox, { target: { value: 'second thoughts' } });
    // A second record cannot be minted while a stage is in flight.
    expect(
      (
        screen.getByRole('button', {
          name: 'Re-read with these instructions',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    const loadsBefore = load.mock.calls.length;
    await screen.findByTestId('applied-instruction');
    expect(load.mock.calls.length).toBeGreaterThan(loadsBefore);
    // Patched in place: the same textarea element and its draft survive, and
    // no loading placeholder was rendered between ticks.
    expect(
      screen.getByRole('textbox', { name: 'Instructions for the assistant' }),
    ).toBe(draftBox);
    expect(draftBox.value).toBe('second thoughts');
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.queryByTestId('reinterpreting')).toBeNull();
    const settled = load.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(load.mock.calls.length).toBe(settled);
  });
  it('shows the safe failure and keeps the instruction form usable against the latest completed generation', async () => {
    const view = page();
    view.entry = {
      ...view.entry,
      state: 'failed',
      item: { ...view.entry.item, processingState: 'needs_attention' },
    };
    view.instruction = {
      current: instructionView('failed-run'),
      applied: null,
      stale: false,
      failure: 'unavailable',
      binding: { attemptId: 'last-generation', expectedRevision: 12 },
    };
    const callbacks = host(view);
    callbacks.instruct = vi.fn(async () => {});
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const failure = await screen.findByTestId('instruction-failure');
    expect(failure.textContent).toContain('unavailable');
    expect(screen.getByTestId('pending-instruction').textContent).toContain(
      'Instruction failed-run',
    );
    expect(screen.queryByTestId('reinterpreting')).toBeNull();
    const box = screen.getByRole('textbox', {
      name: 'Instructions for the assistant',
    });
    await fireEvent.input(box, { target: { value: 'Try again, file it.' } });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Re-read with these instructions' }),
    );
    await waitFor(() =>
      expect(callbacks.instruct).toHaveBeenCalledWith({
        itemId: 'item',
        attemptId: 'last-generation',
        expectedRevision: 12,
        text: 'Try again, file it.',
        requestId: expect.any(String),
      }),
    );
  });
  it('caps poll backoff at 5x, keeps the view through a transient error and fails closed after repeated errors', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const processing = page();
      processing.entry = {
        ...processing.entry,
        state: 'processing',
        item: { ...processing.entry.item, processingState: 'running' },
      };
      processing.instruction = {
        current: instructionView('running'),
        applied: null,
        stale: false,
      };
      let failures = 0;
      const load = vi.fn(async () => {
        if (failures > 0) {
          failures--;
          throw new Error('Temporarily unavailable');
        }
        return structuredClone(processing);
      });
      const callbacks = host(processing);
      callbacks.load = load;
      render(IntakeReview, { host: callbacks, itemId: 'item', pollMs: 200 });
      await vi.advanceTimersByTimeAsync(0);
      expect(load).toHaveBeenCalledTimes(1);
      // 200 * 1.5^n, capped at 5x = 1000.
      const delays = [200, 300, 450, 675, 1000, 1000, 1000];
      for (const [index, delay] of delays.entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(load).toHaveBeenCalledTimes(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(load).toHaveBeenCalledTimes(index + 2);
      }
      // One thrown tick keeps the view and shows a non-blocking note.
      failures = 1;
      await vi.advanceTimersByTimeAsync(1000);
      await tick();
      expect(screen.getByText('Private invoice')).toBeTruthy();
      expect(screen.getByTestId('refresh-retrying')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      // The next tick (still capped) recovers and clears the note.
      await vi.advanceTimersByTimeAsync(1000);
      await tick();
      expect(screen.queryByTestId('refresh-retrying')).toBeNull();
      expect(screen.getByText('Private invoice')).toBeTruthy();
      // Three consecutive thrown ticks fail closed and stop polling.
      failures = 3;
      await vi.advanceTimersByTimeAsync(3000);
      await tick();
      expect(screen.queryByText('Private invoice')).toBeNull();
      expect(screen.getByRole('alert').textContent).toContain('unavailable');
      const stopped = load.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10000);
      expect(load.mock.calls.length).toBe(stopped);
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps edited split drafts across an in-place refresh but replaces untouched ones with the new generation', async () => {
    const first = generationFor(page());
    first.entry = {
      ...first.entry,
      item: { ...first.entry.item, processingState: 'running' },
    };
    first.generation!.splits = [
      { evidenceId: 'original', groups: [[1], [2]], digest: 'a' },
      { evidenceId: 'second', groups: [[1, 2]], digest: 'b' },
    ];
    const next = structuredClone(first);
    next.entry.item.processingState = 'completed';
    next.generation!.splits = [
      { evidenceId: 'original', groups: [[1, 2, 3]], digest: 'c' },
      { evidenceId: 'second', groups: [[1], [2], [3]], digest: 'd' },
    ];
    const callbacks = host(first);
    const sequence = [first, next];
    callbacks.load = vi.fn(async () =>
      structuredClone(sequence.length > 1 ? sequence.shift()! : sequence[0]),
    );
    render(IntakeReview, { host: callbacks, itemId: 'item', pollMs: 5 });
    const edited = (await screen.findByRole('textbox', {
      name: 'Logical page groups (JSON): original',
    })) as HTMLTextAreaElement;
    const untouched = screen.getByRole('textbox', {
      name: 'Logical page groups (JSON): second',
    }) as HTMLTextAreaElement;
    await fireEvent.input(edited, { target: { value: '[[2],[1]]' } });
    await waitFor(() => expect(untouched.value).toBe('[[1],[2],[3]]'));
    expect(edited.value).toBe('[[2],[1]]');
  });
  it('keeps polling with re-read disabled through the gap between extraction and interpretation', async () => {
    const before = generationFor(page());
    // Between stages: extraction completed, interpretation not yet appended.
    // The item and the inbox state look settled; only the server's own
    // predicate (instruction.reinterpreting) says the work is still in flight.
    const gap = page();
    gap.entry = {
      ...gap.entry,
      state: 'unresolved',
      item: { ...gap.entry.item, processingState: 'completed' },
    };
    gap.reviews.actions[0].review.state = 'stale';
    gap.analysis = {
      ...currentAnalysis(),
      attemptId: 'extraction-attempt',
      configuration: { stage: 'extract' },
    };
    gap.instruction = {
      current: instructionView('new'),
      applied: null,
      stale: true,
      reinterpreting: true,
      binding: { attemptId: 'generation-attempt', expectedRevision: 10 },
    };
    const after = generationFor(page());
    after.instruction = {
      current: instructionView('new'),
      applied: instructionView('new'),
      stale: false,
    };
    const callbacks = host(before);
    const sequence = [gap, gap, after];
    const load = vi.fn(async () =>
      structuredClone(sequence.length > 1 ? sequence.shift()! : sequence[0]),
    );
    callbacks.load = load;
    callbacks.instruct = vi.fn(async () => {});
    render(IntakeReview, { host: callbacks, itemId: 'item', pollMs: 5 });
    await screen.findByTestId('reinterpreting');
    const button = screen.getByRole('button', {
      name: 'Re-read with these instructions',
    }) as HTMLButtonElement;
    await fireEvent.input(
      screen.getByRole('textbox', { name: 'Instructions for the assistant' }),
      { target: { value: 'Another instruction' } },
    );
    expect(button.disabled).toBe(true);
    await fireEvent.click(button);
    expect(callbacks.instruct).not.toHaveBeenCalled();
    // Polling did not stop in the gap: the interpretation lands in place.
    await screen.findByTestId('applied-instruction');
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByTestId('reinterpreting')).toBeNull();
  });
  it('treats a stale instruction result as refresh-and-retry, not a denial, and offers a retry when interpretation never started', async () => {
    const view = page();
    view.entry = {
      ...view.entry,
      state: 'unresolved',
      item: { ...view.entry.item, processingState: 'completed' },
    };
    view.analysis = {
      ...currentAnalysis(),
      attemptId: 'extraction-attempt',
      configuration: { stage: 'extract' },
    };
    view.instruction = {
      current: instructionView('wedged'),
      applied: null,
      stale: true,
      failure: 'not_started',
      binding: { attemptId: 'generation-attempt', expectedRevision: 10 },
    };
    const callbacks = host(view);
    callbacks.instruct = vi.fn(async () => ({ stale: true as const }));
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    expect(
      (await screen.findByTestId('instruction-failure')).textContent,
    ).toContain('did not start');
    const box = screen.getByRole('textbox', {
      name: 'Instructions for the assistant',
    });
    await fireEvent.input(box, { target: { value: 'Try again.' } });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Re-read with these instructions' }),
    );
    // The retry targets the server's anchor, not the displayed extraction.
    await waitFor(() =>
      expect(callbacks.instruct).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptId: 'generation-attempt',
          expectedRevision: 10,
        }),
      ),
    );
    // The reload answering the click already shows the item settled, so the
    // busy note is cleared at once; the view stays up and is not denied.
    await waitFor(() => expect(callbacks.load).toHaveBeenCalledTimes(2));
    await screen.findByTestId('instruction-failure');
    expect(screen.queryByTestId('instruction-busy')).toBeNull();
    expect(screen.getByText('Private invoice')).toBeTruthy();
    expect(screen.queryByText(/This view is unavailable/)).toBeNull();
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Instructions for the assistant',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('Try again.');
  });
  it('clears the still-being-re-read note once a later reload shows the item settled', async () => {
    const wedged = page();
    wedged.entry = {
      ...wedged.entry,
      state: 'unresolved',
      item: { ...wedged.entry.item, processingState: 'completed' },
    };
    wedged.analysis = {
      ...currentAnalysis(),
      attemptId: 'extraction-attempt',
      configuration: { stage: 'extract' },
    };
    wedged.instruction = {
      current: instructionView('wedged'),
      applied: null,
      stale: true,
      failure: 'not_started',
      binding: { attemptId: 'generation-attempt', expectedRevision: 10 },
    };
    // Another reviewer's retry is in flight when this one is refused...
    const inFlightView = structuredClone(wedged);
    inFlightView.instruction = {
      current: instructionView('other'),
      applied: null,
      stale: true,
      reinterpreting: true,
    };
    // ...and then lands.
    const settled = generationFor(page());
    settled.instruction = {
      current: instructionView('other'),
      applied: instructionView('other'),
      stale: false,
    };
    const callbacks = host(wedged);
    const sequence = [wedged, inFlightView, inFlightView, settled];
    callbacks.load = vi.fn(async () =>
      structuredClone(sequence.length > 1 ? sequence.shift()! : sequence[0]),
    );
    callbacks.instruct = vi.fn(async () => ({ stale: true as const }));
    render(IntakeReview, { host: callbacks, itemId: 'item', pollMs: 5 });
    await fireEvent.input(
      await screen.findByRole('textbox', {
        name: 'Instructions for the assistant',
      }),
      { target: { value: 'Try again.' } },
    );
    await fireEvent.click(
      screen.getByRole('button', { name: 'Re-read with these instructions' }),
    );
    // The reload answering the click keeps the note while work is in flight.
    await screen.findByTestId('instruction-busy');
    await screen.findByTestId('reinterpreting');
    expect(screen.getByTestId('instruction-busy')).toBeTruthy();
    // Once a poll shows the item settled, the note is gone.
    await screen.findByTestId('applied-instruction');
    expect(screen.queryByTestId('instruction-busy')).toBeNull();
    expect(screen.queryByTestId('reinterpreting')).toBeNull();
  });
  it('limits instruction length client-side and shows a server validation result inline without denying', async () => {
    const view = generationFor(page());
    const callbacks = host(view);
    callbacks.instruct = vi.fn(async () => ({ invalid: true as const }));
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const box = (await screen.findByRole('textbox', {
      name: 'Instructions for the assistant',
    })) as HTMLTextAreaElement;
    expect(box.maxLength).toBe(4000);
    const button = screen.getByRole('button', {
      name: 'Re-read with these instructions',
    }) as HTMLButtonElement;
    // A paste or script can still exceed maxlength; the client check holds.
    await fireEvent.input(box, { target: { value: 'x'.repeat(4001) } });
    expect(screen.getByTestId('instruction-length').textContent).toContain(
      '4001 / 4000',
    );
    expect(button.disabled).toBe(true);
    await fireEvent.click(button);
    expect(callbacks.instruct).not.toHaveBeenCalled();
    // At the limit it may be sent; the server's validation result is inline.
    await fireEvent.input(box, { target: { value: 'y'.repeat(4000) } });
    expect(button.disabled).toBe(false);
    await fireEvent.click(button);
    await screen.findByTestId('instruction-invalid');
    expect(callbacks.instruct).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Private invoice')).toBeTruthy();
    expect(screen.queryByText(/This view is unavailable/)).toBeNull();
    const kept = screen.getByRole('textbox', {
      name: 'Instructions for the assistant',
    }) as HTMLTextAreaElement;
    expect(kept.value).toBe('y'.repeat(4000));
    // Editing the draft clears the note.
    await fireEvent.input(kept, { target: { value: 'File it.' } });
    expect(screen.queryByTestId('instruction-invalid')).toBeNull();
  });
  it('keeps a not-recorded note on the draft after another reinterpretation wins, until the reviewer edits it', async () => {
    const before = generationFor(page());
    const other = generationFor(page());
    other.instruction = {
      current: instructionView('other'),
      applied: instructionView('other'),
      stale: false,
    };
    const callbacks = host(before);
    const sequence = [before, other];
    callbacks.load = vi.fn(async () =>
      structuredClone(sequence.length > 1 ? sequence.shift()! : sequence[0]),
    );
    callbacks.instruct = vi.fn(async () => ({ stale: true as const }));
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    await fireEvent.input(
      await screen.findByRole('textbox', {
        name: 'Instructions for the assistant',
      }),
      { target: { value: 'My instruction.' } },
    );
    await fireEvent.click(
      screen.getByRole('button', { name: 'Re-read with these instructions' }),
    );
    // The answering reload is already settled under someone else's instruction.
    await screen.findByTestId('applied-instruction');
    expect(
      (await screen.findByTestId('instruction-not-recorded')).textContent,
    ).toContain('was not recorded');
    expect(screen.queryByTestId('instruction-busy')).toBeNull();
    // It persists across a manual reload...
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(callbacks.load).toHaveBeenCalledTimes(3));
    expect(await screen.findByTestId('instruction-not-recorded')).toBeTruthy();
    // ...until the reviewer edits the draft.
    await fireEvent.input(
      screen.getByRole('textbox', { name: 'Instructions for the assistant' }),
      { target: { value: 'My revised instruction.' } },
    );
    expect(screen.queryByTestId('instruction-not-recorded')).toBeNull();
  });
  it('stops a superseded poll tick from fetching further pages after a newer load overtakes it', async () => {
    let inFlight = true;
    const pageFor = (cursor?: string) => {
      const view = cursor ? reviewPage(2, 4) : reviewPage(0, 2, 'page-2');
      view.entry = {
        ...view.entry,
        state: inFlight ? 'processing' : 'waiting',
        item: {
          ...view.entry.item,
          processingState: inFlight ? 'running' : 'completed',
        },
      };
      return view;
    };
    const requested: Array<string | undefined> = [];
    let park: ReturnType<typeof deferred<ItemReviewView>> | undefined;
    const callbacks = host(pageFor());
    callbacks.load = vi.fn(async (_itemId: string, cursor?: string) => {
      requested.push(cursor);
      if (!cursor && park) return park.promise;
      return pageFor(cursor);
    });
    render(IntakeReview, { host: callbacks, itemId: 'item', pollMs: 200 });
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Load more' }),
    );
    await waitFor(() =>
      expect(requested).toEqual([undefined, undefined, 'page-2']),
    );
    // The next poll tick parks on its first page.
    const parked = deferred<ItemReviewView>();
    park = parked;
    await waitFor(() => expect(requested).toHaveLength(4), { timeout: 2000 });
    park = undefined;
    // A newer load overtakes it and settles the item, so no later poll runs.
    inFlight = false;
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(requested).toEqual([
        undefined,
        undefined,
        'page-2',
        undefined,
        undefined,
        'page-2',
      ]),
    );
    await screen.findByText('Waiting');
    // The superseded tick resolves late: it must not request page 2.
    parked.resolve(pageFor());
    await new Promise((resolve) => setTimeout(resolve, 50));
    await tick();
    expect(requested).toHaveLength(6);
    expect(screen.getByText('Waiting')).toBeTruthy();
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
    // A resolved item is terminal: no suggestion preview or split re-extraction.
    cleanup();
    view.entry.item.disposition = {
      state: 'resolved',
      at: '2026-10-22T00:00:00.000Z',
    };
    render(IntakeReview, { host: host(view), itemId: 'item' });
    // Without the review-surface disposition only the closed state is shown.
    expect((await screen.findByTestId('disposition')).textContent).toBe(
      'Handled, no action',
    );
    expect(screen.queryByRole('button', { name: 'Prepare review' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Save split and reprocess' }),
    ).toBeNull();
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
  it('preserves same-attempt suggestion drafts during polling and prunes them after reinterpretation', async () => {
    vi.useFakeTimers();
    try {
      const first = needsReviewView(['title']);
      first.entry.item.processingState = 'running';
      const callbacks = host(first);
      let latest = first;
      callbacks.load = vi.fn(async () => structuredClone(latest));
      render(IntakeReview, { host: callbacks, itemId: 'item', pollMs: 200 });
      await vi.advanceTimersByTimeAsync(0);
      const draft = screen.getByRole('textbox', {
        name: 'Suggested arguments (JSON)',
      }) as HTMLTextAreaElement;
      const typed = JSON.stringify({ body: 'Minutes', title: 'Typed' });
      await fireEvent.input(draft, { target: { value: typed } });
      latest = structuredClone(first);
      latest.entry.label = 'Updated label';
      await vi.advanceTimersByTimeAsync(200);
      await tick();
      expect(draft.value).toBe(typed);
      expect(screen.getByText('Updated label')).toBeTruthy();
      latest = structuredClone(first);
      latest.entry.item.processingState = 'completed';
      latest.analysis!.attemptId = 'new-attempt';
      latest.generation!.suggestions[0].args = { body: 'New generation' };
      await vi.advanceTimersByTimeAsync(300);
      await tick();
      expect(
        (
          screen.getByRole('textbox', {
            name: 'Suggested arguments (JSON)',
          }) as HTMLTextAreaElement
        ).value,
      ).toBe(JSON.stringify({ body: 'New generation' }, null, 2));
    } finally {
      vi.useRealTimers();
    }
  });
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
    // The schema draws `destination` as a reference field (#4503): search it
    // and choose the candidate by its label.
    await fireEvent.input(
      screen.getByRole('combobox', { name: 'destination' }),
      { target: { value: 'Auth' } },
    );
    await fireEvent.click(
      await screen.findByRole('option', { name: 'Authorized destination' }),
    );
    expect(
      (
        screen.getByRole('combobox', {
          name: 'destination',
        }) as HTMLInputElement
      ).value,
    ).toBe('Authorized destination');
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
  it('treats a thrown HandlerArgumentsInvalidError as the inline refusal', async () => {
    const callbacks = host(needsReviewView(['title']));
    vi.mocked(callbacks.preview).mockRejectedValue(
      Object.assign(new Error('Invalid handler payload'), {
        name: 'HandlerArgumentsInvalidError',
      }),
    );
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
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Suggested arguments (JSON)',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe(typed);
    expect(callbacks.load).toHaveBeenCalledTimes(1);
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
    await fireEvent.input(
      screen.getByRole('combobox', { name: 'destination' }),
      { target: { value: 'Any' } },
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
    // Absent confidence draws nothing (#4503).
    expect(screen.queryByText('Confidence unavailable')).toBeNull();
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
    // Absent confidence draws nothing (#4503).
    expect(screen.queryByText('Confidence unavailable')).toBeNull();
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
  function catalogView(): ItemReviewView {
    const view = page();
    view.analysis = currentAnalysis();
    view.reviews.actions = [];
    view.catalog = [
      {
        id: 'host:draft',
        version: '1',
        description: 'Create a draft document',
        kind: 'operation',
        capability: null,
        argsSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'body'],
          properties: { title: { type: 'string' }, body: { type: 'string' } },
        },
        references: {},
        operation: { model: 'Document', action: 'create', version: '1' },
      },
      {
        id: 'host:attach',
        version: '1',
        description: 'Attach the original',
        kind: 'operation',
        capability: null,
        argsSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['contentId', 'evidenceId'],
          properties: {
            contentId: { type: 'string' },
            evidenceId: { type: 'string' },
          },
        },
        references: { evidenceId: { kind: 'evidence' } },
        operation: { model: 'Document', action: 'addAsset', version: '1' },
      },
      {
        id: 'host:plan',
        version: '1',
        description: 'Plans go through previewPlan',
        kind: 'plan',
        capability: null,
        argsSchema: {},
        references: {},
        operation: { playbookKey: 'plan', definitionHash: 'hash' },
      },
    ];
    return view;
  }
  it('starts a reviewer-chosen handler with pre-filled arguments and surfaces missing fields, never approving', async () => {
    const view = catalogView();
    view.generation = {
      version: 1,
      outcome: 'needs_review',
      suggestions: [
        {
          handlerId: 'host:draft',
          handlerVersion: '1',
          args: { title: 'Customer PO 17' },
          evidence: [],
          alternatives: [],
          missingFields: ['body'],
          explanation: 'Body unknown',
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
    const callbacks = host(view);
    callbacks.startAction = vi.fn(async () => {});
    callbacks.resolve = vi.fn(async () => {});
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const picker = await screen.findByRole('combobox', { name: 'Handler' });
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Handler', 'host:draft', 'host:attach']);
    await fireEvent.change(picker, { target: { value: 'host:attach@1' } });
    const args = (await screen.findByRole('textbox', {
      name: 'Initial arguments (JSON)',
    })) as HTMLTextAreaElement;
    expect(JSON.parse(args.value)).toEqual({ evidenceId: 'original' });
    const start = screen.getByRole('group', { name: 'Start action as…' });
    expect(within(start).getByText('Missing information')).toBeTruthy();
    expect(within(start).getByText('contentId')).toBeTruthy();
    await fireEvent.change(picker, { target: { value: 'host:draft@1' } });
    await waitFor(() =>
      expect(
        JSON.parse(
          (
            screen.getByRole('textbox', {
              name: 'Initial arguments (JSON)',
            }) as HTMLTextAreaElement
          ).value,
        ),
      ).toEqual({ title: 'Customer PO 17' }),
    );
    expect(within(start).getByText('body')).toBeTruthy();
    const editor = screen.getByRole('textbox', {
      name: 'Initial arguments (JSON)',
    });
    await fireEvent.input(editor, { target: { value: '{bad json' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Start action' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(callbacks.startAction).not.toHaveBeenCalled();
    await fireEvent.input(editor, {
      target: {
        value: JSON.stringify({ title: 'Customer PO 17', body: 'Acme' }),
      },
    });
    await fireEvent.input(screen.getByRole('textbox', { name: 'Reason' }), {
      target: { value: 'Customer PO, not a bill' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Start action' }));
    await waitFor(() =>
      expect(callbacks.startAction).toHaveBeenCalledWith({
        itemId: 'item',
        handlerId: 'host:draft',
        handlerVersion: '1',
        args: { title: 'Customer PO 17', body: 'Acme' },
        requestId: expect.any(String),
        reason: 'Customer PO, not a bill',
      }),
    );
    expect(callbacks.decide).not.toHaveBeenCalled();
    expect(callbacks.apply).not.toHaveBeenCalled();
    expect(callbacks.resolve).not.toHaveBeenCalled();
    await waitFor(() => expect(callbacks.load).toHaveBeenCalledTimes(2));
  });
  async function startWith(callbacks: IntakeReviewHost, typed: string) {
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const picker = await screen.findByRole('combobox', { name: 'Handler' });
    await fireEvent.change(picker, { target: { value: 'host:draft@1' } });
    const editor = await screen.findByRole('textbox', {
      name: 'Initial arguments (JSON)',
    });
    await fireEvent.input(editor, { target: { value: typed } });
    await fireEvent.input(screen.getByRole('textbox', { name: 'Reason' }), {
      target: { value: 'Customer PO' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Start action' }));
  }
  function startDraftKept(typed: string) {
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Initial arguments (JSON)',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe(typed);
    expect(
      (screen.getByRole('combobox', { name: 'Handler' }) as HTMLSelectElement)
        .value,
    ).toBe('host:draft@1');
    expect(
      (screen.getByRole('textbox', { name: 'Reason' }) as HTMLInputElement)
        .value,
    ).toBe('Customer PO');
    expect(screen.getByTestId('evidence-viewer')).toBeTruthy();
  }
  it('keeps the start form and draft inline when the handler refuses the arguments (#4281)', async () => {
    const callbacks = host(catalogView());
    const typed = JSON.stringify({ title: '', body: 'Acme' });
    callbacks.startAction = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Invalid handler payload'), {
          name: 'HandlerArgumentsInvalidError',
          issues: [
            { path: '/title', keyword: 'minLength' },
            { path: '/title', keyword: 'pattern' },
            { path: 7 },
          ],
        }),
      )
      .mockResolvedValueOnce(undefined);
    await startWith(callbacks, typed);
    const refusal = await screen.findByTestId('start-rejected');
    expect(refusal.getAttribute('role')).toBe('alert');
    expect(refusal.textContent).toContain(
      'did not pass the handler validation',
    );
    expect(refusal.textContent).toContain('Fields to check');
    expect(
      within(refusal)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['title']);
    startDraftKept(typed);
    expect(callbacks.load).toHaveBeenCalledTimes(1);
    // A corrected retry publishes normally and clears the inline refusal.
    const corrected = JSON.stringify({ title: 'Customer PO 17', body: 'Acme' });
    await fireEvent.input(
      screen.getByRole('textbox', { name: 'Initial arguments (JSON)' }),
      { target: { value: corrected } },
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Start action' }));
    await waitFor(() => expect(callbacks.load).toHaveBeenCalledTimes(2));
    expect(callbacks.startAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: { title: 'Customer PO 17', body: 'Acme' },
      }),
    );
    expect(screen.queryByTestId('start-rejected')).toBeNull();
  });
  it('treats a resolved { rejected: invalid } from startAction as the same inline refusal (#4281)', async () => {
    const callbacks = host(catalogView());
    const typed = JSON.stringify({ title: '', body: 'Acme' });
    callbacks.startAction = vi.fn(async () => ({
      rejected: 'invalid' as const,
    }));
    await startWith(callbacks, typed);
    const refusal = await screen.findByTestId('start-rejected');
    expect(refusal.textContent).not.toContain('Fields to check');
    startDraftKept(typed);
    expect(callbacks.load).toHaveBeenCalledTimes(1);
  });
  it('bounds the refused-field list and shows root paths like missing fields (#4281)', async () => {
    const callbacks = host(catalogView());
    const typed = JSON.stringify({ title: '', body: 'Acme' });
    callbacks.startAction = vi.fn(async () => ({
      rejected: 'invalid' as const,
      issues: [
        { path: '/' },
        { path: '/a~1b~0c' },
        { path: '/vendor/a~1b~0c' },
        { path: `/${'x'.repeat(160)}` },
        { path: '' },
        ...Array.from({ length: 25 }, (_, index) => ({ path: `/f${index}` })),
      ],
    }));
    await startWith(callbacks, typed);
    const refusal = await screen.findByTestId('start-rejected');
    const shown = within(refusal)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    // Only the first 20 entries are read; a 161-character or empty path is dropped.
    expect(shown).toEqual([
      '/',
      'a/b~c',
      '/vendor/a~1b~0c',
      ...Array.from({ length: 15 }, (_, index) => `f${index}`),
    ]);
  });
  it('sends one start while the previous start is pending (#4281)', async () => {
    const callbacks = host(catalogView());
    let finish: (() => void) | undefined;
    callbacks.startAction = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const picker = await screen.findByRole('combobox', { name: 'Handler' });
    await fireEvent.change(picker, { target: { value: 'host:draft@1' } });
    await fireEvent.input(
      await screen.findByRole('textbox', { name: 'Initial arguments (JSON)' }),
      { target: { value: JSON.stringify({ title: 'T', body: 'B' }) } },
    );
    const start = screen.getByRole('button', { name: 'Start action' });
    // Both clicks land before the disabled attribute renders; the Button
    // reads its live `disabled={pending || ...}` prop and drops the second.
    void fireEvent.click(start);
    void fireEvent.click(start);
    await waitFor(() =>
      expect((start as HTMLButtonElement).disabled).toBe(true),
    );
    expect(callbacks.startAction).toHaveBeenCalledTimes(1);
    finish?.();
    await waitFor(() => expect(callbacks.load).toHaveBeenCalledTimes(2));
    expect(callbacks.startAction).toHaveBeenCalledTimes(1);
  });
  it('still fails closed when startAction throws any other error (#4281)', async () => {
    const callbacks = host(catalogView());
    callbacks.startAction = vi.fn(async () => {
      throw Object.assign(new Error('Item resolved'), {
        issues: [{ path: '/title' }],
      });
    });
    await startWith(callbacks, JSON.stringify({ title: 'T', body: 'B' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This view is unavailable',
    );
    expect(screen.queryByTestId('start-rejected')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Handler' })).toBeNull();
  });
  it('closes an item as handled without action from review and inbox with an optional reason', async () => {
    const view = catalogView();
    const callbacks = host(view);
    callbacks.resolve = vi.fn(async () => {});
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const reason = await screen.findByRole('textbox', {
      name: 'Reason for no action',
    });
    await fireEvent.input(reason, { target: { value: 'Already paid' } });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Handled, no action' }),
    );
    await waitFor(() =>
      expect(callbacks.resolve).toHaveBeenCalledWith({
        itemId: 'item',
        disposition: 'resolve_no_action',
        requestId: expect.any(String),
        reason: 'Already paid',
      }),
    );
    expect(callbacks.decide).not.toHaveBeenCalled();
    cleanup();
    const inbox = host(view);
    inbox.resolve = vi.fn(async () => {});
    render(IntakeInbox, { host: inbox });
    await screen.findByText('Private invoice');
    expect(
      within(screen.getByRole('combobox', { name: 'State' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toContain('Handled, no action');
    await fireEvent.click(
      screen.getByRole('button', { name: 'Handled, no action' }),
    );
    await waitFor(() =>
      expect(inbox.resolve).toHaveBeenCalledWith({
        itemId: 'item',
        disposition: 'resolve_no_action',
        requestId: expect.any(String),
      }),
    );
  });
  it('keeps incomplete suggestion completion hidden after a no-action disposition', async () => {
    const view = needsReviewView(['title']);
    view.entry.state = 'resolved';
    view.entry.item.processingState = 'queued';
    view.entry.item.disposition = {
      state: 'resolved',
      at: '2026-10-22T00:00:00.000Z',
    };
    const callbacks = host(view);
    callbacks.instruct = vi.fn(async () => {});
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    await screen.findByTestId('disposition');
    expect(
      screen.queryByRole('button', { name: 'Re-read with these instructions' }),
    ).toBeNull();
    expect(callbacks.instruct).not.toHaveBeenCalled();
    expect(screen.queryByTestId('reinterpreting')).toBeNull();
    expect(
      screen.queryByRole('textbox', { name: 'Suggested arguments (JSON)' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Prepare review' })).toBeNull();
    expect(callbacks.preview).not.toHaveBeenCalled();
  });
  it('shows the disposition instead of start controls and labels reviewer-started actions', async () => {
    const view = catalogView();
    view.entry.state = 'resolved';
    view.entry.item.disposition = {
      state: 'resolved',
      at: '2026-10-22T00:00:00.000Z',
    };
    view.disposition = {
      kind: 'resolved_no_action',
      reviewer: 'owner',
      reason: 'Already paid',
      decidedAt: '2026-10-22T00:00:00.000Z',
    };
    view.reviews.actions = [
      { ...page().reviews.actions[0], origin: 'reviewer-selected' },
    ];
    const callbacks = host(view);
    callbacks.startAction = vi.fn(async () => {});
    callbacks.resolve = vi.fn(async () => {});
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    expect((await screen.findByTestId('disposition')).textContent).toContain(
      'Closed without action by owner: Already paid',
    );
    expect(screen.queryByRole('combobox', { name: 'Handler' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Handled, no action' }),
    ).toBeNull();
    expect(screen.getByText('Started by a reviewer')).toBeTruthy();
    // A reviewer-selected action is a routing choice, not a model suggestion to judge.
    expect(screen.queryByText('Explicit correctness feedback')).toBeNull();
    // Terminal: the leftover waiting action can only be rejected.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Defer' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Save edits for new review' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
    cleanup();
    const bare = host(catalogView());
    delete bare.startAction;
    delete bare.resolve;
    render(IntakeReview, { host: bare, itemId: 'item' });
    await screen.findByText('No saved reviews.');
    expect(screen.queryByRole('combobox', { name: 'Handler' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Handled, no action' }),
    ).toBeNull();
  });
  it('renders the host original link and preview on a row from page data, never from load', async () => {
    const view = page();
    view.entry.evidence = {
      evidence: view.evidence[0].evidence,
      label: 'Email original',
      viewUrl: '/original',
      thumbnailUrl: '/thumbnail.png',
    };
    const callbacks = host(view);
    const { container } = render(IntakeInbox, { host: callbacks });
    await screen.findByText('Private invoice');
    // Each row's link names the item it opens, so a list of them is usable.
    const link = screen.getByRole('link', {
      name: 'Open original: Private invoice',
    });
    expect(link.textContent).toBe('Open original');
    expect(link.getAttribute('href')).toBe(`${location.origin}/original`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    // Not a landmark per row.
    expect(container.querySelector('aside')).toBeNull();
    const image = container.querySelector(
      'li .row-aside img',
    ) as HTMLImageElement;
    expect(image.getAttribute('src')).toBe(`${location.origin}/thumbnail.png`);
    expect(image.getAttribute('alt')).toBe('Email original');
    expect(callbacks.load).not.toHaveBeenCalled();
  });
  it('refuses off-origin row evidence URLs and renders nothing without evidence', async () => {
    const view = page();
    view.entry.evidence = {
      evidence: view.evidence[0].evidence,
      label: 'Foreign',
      viewUrl: 'https://evil.example/original',
      thumbnailUrl: 'javascript:alert(1)',
    };
    const { container, unmount } = render(IntakeInbox, { host: host(view) });
    await screen.findByText('Private invoice');
    expect(screen.queryByRole('link', { name: /^Open original/ })).toBeNull();
    // With both URLs refused there is nothing to show, so no empty wrapper.
    expect(container.querySelector('li .row-aside')).toBeNull();
    unmount();
    const bare = page();
    const second = render(IntakeInbox, { host: host(bare) });
    await screen.findByText('Private invoice');
    expect(second.container.querySelector('li .row-aside')).toBeNull();
  });
  it('renders a host rowAside snippet with the page entry instead of the default aside', async () => {
    const view = page();
    view.entry.evidence = {
      evidence: view.evidence[0].evidence,
      label: 'Email original',
      viewUrl: '/original',
    };
    const rowAside = createRawSnippet((entry: () => typeof view.entry) => ({
      render: () =>
        `<span data-testid="row-aside">${entry().item.id}:${entry().evidence?.evidence.id ?? ''}</span>`,
    }));
    const { container } = render(IntakeInbox, {
      host: host(view),
      rowAside,
    });
    await screen.findByText('Private invoice');
    expect(screen.getByTestId('row-aside').textContent).toBe('item:original');
    expect(screen.queryByRole('link', { name: /^Open original/ })).toBeNull();
    expect(container.querySelectorAll('li .row-aside')).toHaveLength(1);
    expect(container.querySelector('aside')).toBeNull();
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
