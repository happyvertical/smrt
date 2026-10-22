import { describe, expect, it, vi } from 'vitest';
import type { IntakeItemDTO } from './dto.js';
import type { ReviewPage } from './review-dto.js';
import { createIntakeReviewHost } from './review-host.js';
import {
  GenerationSnapshotStaleError,
  type IngestionService,
} from './server.js';

function fixture() {
  const item = { id: 'item', processingState: 'completed' } as IntakeItemDTO;
  const first = { actions: [], nextCursor: 'next' } as ReviewPage;
  const last = { actions: [] } as ReviewPage;
  const service = {
    getItem: vi.fn(async () => item),
    listItems: vi.fn(async () => [item]),
    listReviews: vi.fn(async (_id: string, page: { cursor?: string }) =>
      page.cursor ? last : first,
    ),
    getCompletedAnalysis: vi.fn(async () => ({
      configuration: { stage: 'interpret' },
      result: { output: { proposals: { suggestions: [] } } },
    })),
    getEvidence: vi.fn(async () => []),
    createAction: vi.fn(async () => 'action-1'),
    previewProposal: vi.fn(async () => ({ state: 'waiting_review' })),
    previewPlan: vi.fn(async () => ({ steps: [] })),
    previewGeneratedProposals: vi.fn(async () => []),
  };
  const host = createIntakeReviewHost(service as unknown as IngestionService, {
    upload: async () => ({ itemId: item.id }),
    assignment: async () => ({ assigneeId: null, version: 0 }),
    assign: async () => {},
    evidence: async () => ({ label: 'Original' }),
  });
  return { host, service, first, last };
}

describe('published review host projection', () => {
  it('aggregates pages without reading original bytes for an inbox', async () => {
    const f = fixture();
    f.last.actions.push({
      review: { state: 'succeeded' },
    } as ReviewPage['actions'][number]);
    expect((await f.host.list({})).items[0].state).toBe('completed');
    expect(f.service.getEvidence).not.toHaveBeenCalled();
  });
  it('keeps a continuation cursor when filters exclude the entire scanned page', async () => {
    const f = fixture();
    f.service.listItems.mockResolvedValue(
      Array.from(
        { length: 21 },
        (_, index) =>
          ({
            id: String(index).padStart(2, '0'),
            processingState: 'completed',
          }) as IntakeItemDTO,
      ),
    );
    const page = await f.host.list({ state: 'failed' });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBe('19');
  });
  it('rejects repeating page cursors', async () => {
    const f = fixture();
    f.last.nextCursor = 'next';
    await expect(f.host.list({})).rejects.toThrow('Repeated review cursor');
  });
  it('keeps successful review history but omits stale generation output', async () => {
    const f = fixture();
    f.first.actions.push({
      review: { actionId: 'completed-action', state: 'succeeded' },
    } as ReviewPage['actions'][number]);
    f.service.getCompletedAnalysis.mockRejectedValue(
      new GenerationSnapshotStaleError(),
    );
    const view = await f.host.load('item');
    expect(view.generation).toBeUndefined();
    expect(view.analysis).toBeUndefined();
    expect(view.reviews).toBe(f.first);
    expect(view.reviews.actions[0].review).toMatchObject({
      actionId: 'completed-action',
      state: 'succeeded',
    });
    expect(f.service.listReviews).toHaveBeenCalledTimes(3);
  });
  function generation(
    disposition: 'ready_for_review' | 'needs_review',
    outcome = 'proposals',
  ) {
    return {
      configuration: { stage: 'interpret' },
      result: {
        output: {
          proposals: {
            outcome,
            offered: [
              {
                handler: { id: 'draft', version: '1', kind: 'operation' },
                candidates: [],
              },
            ],
            suggestions: [
              {
                handlerId: 'draft',
                handlerVersion: '1',
                args: { body: 'Body' },
                missingFields: disposition === 'needs_review' ? ['title'] : [],
                disposition,
              },
            ],
          },
        },
      },
    };
  }
  const previewInput = {
    itemId: 'item',
    attemptId: 'attempt',
    index: 0,
    requestId: 'request',
  };
  it('publishes human-completed arguments for a needs_review suggestion through the explicit preview (#4208)', async () => {
    const f = fixture();
    f.service.getCompletedAnalysis.mockResolvedValue(
      generation('needs_review') as never,
    );
    await f.host.preview({
      ...previewInput,
      args: { body: 'Body', title: 'Human title' },
    });
    expect(f.service.createAction).toHaveBeenCalledWith('item', 'ui:0', {
      origin: 'generated-proposal',
      intentionKey: 'ui:0',
    });
    expect(f.service.previewProposal).toHaveBeenCalledWith({
      itemId: 'item',
      actionId: 'action-1',
      attemptId: 'attempt',
      expectedRevision: 0,
      requestId: 'request',
      handlerId: 'draft',
      handlerVersion: '1',
      args: { body: 'Body', title: 'Human title' },
    });
    expect(f.service.previewGeneratedProposals).not.toHaveBeenCalled();
  });
  it('previews a needs_review suggestion from the generated snapshot when no arguments are supplied', async () => {
    const f = fixture();
    f.service.getCompletedAnalysis.mockResolvedValue(
      generation('needs_review') as never,
    );
    await f.host.preview(previewInput);
    expect(f.service.previewGeneratedProposals).toHaveBeenCalledWith({
      itemId: 'item',
      attemptId: 'attempt',
      selections: [
        {
          index: 0,
          intentionKey: 'ui:0',
          expectedRevision: 0,
          requestId: 'request',
        },
      ],
    });
    expect(f.service.previewProposal).not.toHaveBeenCalled();
  });
  it.each([
    ['a failed attempt', generation('needs_review', 'provider_error'), {}],
    [
      'an interpretation without proposal output',
      { configuration: { stage: 'interpret' }, result: { output: {} } },
      {},
    ],
    [
      'a foreign stage',
      {
        ...generation('ready_for_review'),
        configuration: { stage: 'extract' },
      },
      {},
    ],
    ['array arguments', generation('needs_review'), { args: [] }],
    [
      'an unoffered handler with human arguments',
      {
        ...generation('needs_review'),
        result: {
          output: {
            proposals: {
              ...generation('needs_review').result.output.proposals,
              offered: [],
            },
          },
        },
      },
      { args: { title: 'x', body: 'y' } },
    ],
  ] as const)('refuses preview for %s', async (_name, analysis, extra) => {
    const f = fixture();
    f.service.getCompletedAnalysis.mockResolvedValue(analysis as never);
    await expect(
      f.host.preview({ ...previewInput, ...(extra as object) }),
    ).rejects.toThrow(/Preview unavailable|Invalid preview/);
    expect(f.service.createAction).not.toHaveBeenCalled();
    expect(f.service.previewProposal).not.toHaveBeenCalled();
    expect(f.service.previewGeneratedProposals).not.toHaveBeenCalled();
  });
  it('propagates denial rather than returning prior saved reviews', async () => {
    const f = fixture();
    f.service.getCompletedAnalysis.mockRejectedValue(new Error('Denied'));
    await expect(f.host.load('item')).rejects.toThrow('Denied');
    expect(f.service.getEvidence).not.toHaveBeenCalled();
  });
});
