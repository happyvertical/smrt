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
  it('reacquires saved reviews after a typed stale generation failure', async () => {
    const f = fixture();
    f.service.getCompletedAnalysis.mockRejectedValue(
      new GenerationSnapshotStaleError(),
    );
    const view = await f.host.load('item');
    expect(view.generation).toBeUndefined();
    expect(view.reviews).toBe(f.first);
    expect(f.service.listReviews).toHaveBeenCalledTimes(3);
  });
  it('propagates denial rather than returning prior saved reviews', async () => {
    const f = fixture();
    f.service.getCompletedAnalysis.mockRejectedValue(new Error('Denied'));
    await expect(f.host.load('item')).rejects.toThrow('Denied');
    expect(f.service.getEvidence).not.toHaveBeenCalled();
  });
});
