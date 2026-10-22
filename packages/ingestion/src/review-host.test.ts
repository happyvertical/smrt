import { describe, expect, it, vi } from 'vitest';
import type { IntakeItemDTO, ItemDisposition } from './dto.js';
import type { ReviewPage } from './review-dto.js';
import { createIntakeReviewHost } from './review-host.js';
import {
  GenerationSnapshotStaleError,
  type IngestionService,
  ProposalsNotConfiguredError,
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
    listHandlers: vi.fn(async () => [{ id: 'host:draft', version: '1' }]),
    startReviewerAction: vi.fn(async () => ({})),
    resolveItem: vi.fn(async () => ({})),
    getItemDisposition: vi.fn(
      async (): Promise<ItemDisposition | undefined> => undefined,
    ),
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
  it('exposes the offered catalog and forwards reviewer-chosen actions and dispositions unchanged', async () => {
    const f = fixture();
    const view = await f.host.load('item');
    expect(view.catalog).toEqual([{ id: 'host:draft', version: '1' }]);
    const start = {
      itemId: 'item',
      handlerId: 'host:draft',
      handlerVersion: '1',
      args: { title: 'Customer PO' },
      requestId: 'start',
      reason: 'Customer PO',
    };
    await f.host.startAction?.(start);
    expect(f.service.startReviewerAction).toHaveBeenCalledWith(start);
    const close = {
      itemId: 'item',
      disposition: 'resolve_no_action' as const,
      requestId: 'close',
    };
    await f.host.resolve?.(close);
    expect(f.service.resolveItem).toHaveBeenCalledWith(close);
    f.service.listHandlers.mockRejectedValueOnce(
      new ProposalsNotConfiguredError(),
    );
    expect((await f.host.load('item')).catalog).toBeUndefined();
    // Any catalog failure hides only the picker; saved reviews stay reviewable.
    f.service.listHandlers.mockRejectedValueOnce(
      new Error('Authorized catalog exceeds configured bound'),
    );
    const degraded = await f.host.load('item');
    expect(degraded.catalog).toBeUndefined();
    expect(degraded.reviews).toBe(f.first);
  });
  it('projects a reviewer disposition as the terminal resolved inbox state', async () => {
    const f = fixture();
    const full = {
      kind: 'resolved_no_action' as const,
      reviewer: 'owner',
      reason: 'Already paid',
      decidedAt: '2026-10-22T00:00:00.000Z',
    };
    f.service.getItemDisposition.mockResolvedValue(full);
    f.service.getItem.mockResolvedValue({
      id: 'item',
      processingState: 'completed',
      disposition: { state: 'resolved', at: '2026-10-22T00:00:00.000Z' },
    } as IntakeItemDTO);
    expect((await f.host.list({})).items[0].state).toBe('resolved');
    expect((await f.host.list({ state: 'waiting' })).items).toEqual([]);
    // The inbox never asks for reviewer content.
    expect(f.service.getItemDisposition).not.toHaveBeenCalled();
    // The item view loads reviewer and reason through the review surface, and a
    // denial there hides only that detail.
    expect((await f.host.load('item')).disposition).toEqual(full);
    f.service.getItemDisposition.mockRejectedValueOnce(new Error('Denied'));
    const reader = await f.host.load('item');
    expect(reader.disposition).toBeUndefined();
    expect(reader.entry.state).toBe('resolved');
  });
  it('propagates denial rather than returning prior saved reviews', async () => {
    const f = fixture();
    f.service.getCompletedAnalysis.mockRejectedValue(new Error('Denied'));
    await expect(f.host.load('item')).rejects.toThrow('Denied');
    expect(f.service.getEvidence).not.toHaveBeenCalled();
  });
});
