import { describe, expect, it, vi } from 'vitest';
import type { IntakeItemDTO } from './dto.js';
import type { ReviewerInstruction, ReviewPage } from './review-dto.js';
import { createIntakeReviewHost } from './review-host.js';
import { reviewerInstructionView } from './reviewer-instruction.js';
import {
  GenerationSnapshotStaleError,
  type IngestionService,
} from './server.js';

vi.mock('./reviewer-instruction.js', () => ({
  reviewerInstructionView: (value: unknown) => value,
}));

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
      configuration: { stage: 'interpret' } as Record<string, unknown>,
      result: { output: { proposals: { suggestions: [] } } },
    })),
    getEvidence: vi.fn(async () => []),
    listReviewerInstructions: vi.fn(async () => [] as ReviewerInstruction[]),
    getReinterpretationState: vi.fn(async () => ({
      revision: 4,
      processingState: 'completed',
      failure: null as string | null,
      generationAttemptId: null as string | null,
    })),
    recordReviewerInstruction: vi.fn(async () => ({
      id: 'analysis',
      revision: 4,
      instruction: instruction('current'),
    })),
  };
  const woken: Array<[string, number]> = [];
  const host = createIntakeReviewHost(service as unknown as IngestionService, {
    upload: async () => ({ itemId: item.id }),
    assignment: async () => ({ assigneeId: null, version: 0 }),
    assign: async () => {},
    evidence: async () => ({ label: 'Original' }),
    onInstruct: async (itemId, revision) => {
      woken.push([itemId, revision]);
    },
  });
  return { host, service, first, last, woken };
}
function instruction(id: string): ReviewerInstruction {
  return {
    id,
    text: `Instruction ${id}`,
    actorId: 'owner',
    recordedAt: '2026-10-22T00:00:00.000Z',
    supersedesId: null,
    digest: `digest-${id}`,
  };
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
  it('propagates denial rather than returning prior saved reviews', async () => {
    const f = fixture();
    f.service.getCompletedAnalysis.mockRejectedValue(new Error('Denied'));
    await expect(f.host.load('item')).rejects.toThrow('Denied');
    expect(f.service.getEvidence).not.toHaveBeenCalled();
  });
  it('records an instruction durably, wakes the host and reports the applied instruction as stale once superseded', async () => {
    const f = fixture();
    const input = {
      itemId: 'item',
      attemptId: 'attempt',
      expectedRevision: 3,
      text: 'File it, do not bill it.',
      requestId: 'request',
    };
    await f.host.instruct?.(input);
    expect(f.service.recordReviewerInstruction).toHaveBeenCalledWith(input);
    expect(f.woken).toEqual([['item', 4]]);
    expect((await f.host.load('item')).instruction).toBeUndefined();
    f.service.listReviewerInstructions.mockResolvedValue([
      instruction('current'),
      instruction('old'),
    ]);
    f.service.getCompletedAnalysis.mockResolvedValue({
      configuration: {
        stage: 'interpret',
        reviewerInstruction: instruction('old'),
      },
      result: { output: { proposals: { suggestions: [] } } },
    });
    expect((await f.host.load('item')).instruction).toEqual({
      current: instruction('current'),
      applied: instruction('old'),
      stale: true,
    });
    f.service.listReviewerInstructions.mockResolvedValue([instruction('old')]);
    expect((await f.host.load('item')).instruction).toMatchObject({
      stale: false,
    });
    expect(reviewerInstructionView(instruction('old'))).toEqual(
      instruction('old'),
    );
  });
});
