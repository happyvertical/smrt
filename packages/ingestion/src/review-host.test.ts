import { describe, expect, it, vi } from 'vitest';
import type { IntakeItemDTO } from './dto.js';
import type { ReviewPage } from './review-dto.js';
import { createIntakeReviewHost } from './review-host.js';
import {
  GenerationSnapshotStaleError,
  type IngestionService,
  type IntakeItemPage,
  type ListItemsInput,
} from './server.js';

/** A fake service page source: newest-first rows cut by limit/cursor/itemIds. */
function pageSource(rows: Array<{ id: string; state?: string }>) {
  return async (input: ListItemsInput = {}): Promise<IntakeItemPage> => {
    const limit = input.limit ?? 20;
    let candidates = rows
      .filter(
        (row) => !input.state || (row.state ?? 'unresolved') === input.state,
      )
      .filter((row) => !input.itemIds || input.itemIds.includes(row.id));
    if (input.cursor) {
      const index = candidates.findIndex((row) => row.id === input.cursor);
      candidates = candidates.slice(index + 1);
    }
    const page = candidates.slice(0, limit);
    return {
      items: page.map((row) => ({
        item: { id: row.id, processingState: 'completed' } as IntakeItemDTO,
        state: (row.state ??
          'unresolved') as IntakeItemPage['items'][0]['state'],
        cursor: row.id,
      })),
      ...(candidates.length > limit ? { nextCursor: page.at(-1)!.id } : {}),
    };
  };
}

function fixture() {
  const item = { id: 'item', processingState: 'completed' } as IntakeItemDTO;
  const first = { actions: [], nextCursor: 'next' } as ReviewPage;
  const last = { actions: [] } as ReviewPage;
  const service = {
    getItem: vi.fn(async () => item),
    listItems: vi.fn(pageSource([{ id: 'item', state: 'completed' }])),
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
  it('lists from one service page without per-row review or evidence reads', async () => {
    const f = fixture();
    const page = await f.host.list({});
    expect(page.items[0].state).toBe('completed');
    expect(page.nextCursor).toBeUndefined();
    expect(f.service.listItems).toHaveBeenCalledTimes(1);
    expect(f.service.listItems).toHaveBeenCalledWith({
      limit: 20,
      cursor: undefined,
      state: undefined,
      itemIds: undefined,
    });
    expect(f.service.listReviews).not.toHaveBeenCalled();
    expect(f.service.getItem).not.toHaveBeenCalled();
    expect(f.service.getEvidence).not.toHaveBeenCalled();
  });
  it('pushes limit, cursor and state into the service page query', async () => {
    const f = fixture();
    const rows = Array.from({ length: 30 }, (_, index) => ({
      id: String(index).padStart(2, '0'),
      state: index % 2 ? 'failed' : 'completed',
    }));
    f.service.listItems.mockImplementation(pageSource(rows));
    const first = await f.host.list({ state: 'failed', limit: 5 });
    expect(first.items.map((entry) => entry.item.id)).toEqual([
      '01',
      '03',
      '05',
      '07',
      '09',
    ]);
    expect(first.nextCursor).toBe('09');
    const second = await f.host.list({
      state: 'failed',
      limit: 5,
      cursor: first.nextCursor,
    });
    expect(second.items.map((entry) => entry.item.id)).toEqual([
      '11',
      '13',
      '15',
      '17',
      '19',
    ]);
    const last = await f.host.list({
      state: 'failed',
      limit: 10,
      cursor: '19',
    });
    expect(last.items).toHaveLength(5);
    expect(last.nextCursor).toBeUndefined();
    expect(f.service.listItems).toHaveBeenCalledTimes(3);
  });
  it('reads assignments once per page and pushes the assignee filter down when the host can', async () => {
    const f = fixture();
    const uid = (n: number) =>
      `0b6e1c1e-5b9b-4a1e-9b1e-${String(n).padStart(12, '0')}`;
    const rows = Array.from({ length: 6 }, (_, index) => ({ id: uid(index) }));
    const mine = [uid(2), uid(4)];
    f.service.listItems.mockImplementation(pageSource(rows));
    const assignments = vi.fn(
      async (itemIds: string[]) =>
        new Map(
          itemIds.map((id) => [
            id,
            { assigneeId: mine.includes(id) ? 'me' : null, version: 1 },
          ]),
        ),
    );
    const assignedItemIds = vi.fn(async () => mine);
    const host = createIntakeReviewHost(
      f.service as unknown as IngestionService,
      {
        upload: async () => ({ itemId: 'x' }),
        assignment: async () => {
          throw new Error('per-row assignment must not run');
        },
        assignments,
        assignedItemIds,
        assign: async () => {},
        evidence: async () => ({ label: 'Original' }),
      },
    );
    const page = await host.list({ assigneeId: 'me' });
    expect(page.items.map((entry) => entry.item.id)).toEqual(mine);
    expect(page.items[0].assignment).toEqual({ assigneeId: 'me', version: 1 });
    expect(assignedItemIds).toHaveBeenCalledWith('me');
    expect(f.service.listItems).toHaveBeenCalledTimes(1);
    expect(f.service.listItems).toHaveBeenCalledWith(
      expect.objectContaining({ itemIds: mine }),
    );
    expect(assignments).toHaveBeenCalledTimes(1);
    expect(assignments).toHaveBeenCalledWith(mine);
  });
  it('drops junk ids from the assignee pushdown instead of failing the list', async () => {
    const f = fixture();
    const rows = [
      { id: '0b6e1c1e-5b9b-4a1e-9b1e-000000000001' },
      { id: '0b6e1c1e-5b9b-4a1e-9b1e-000000000002' },
    ];
    f.service.listItems.mockImplementation(pageSource(rows));
    const host = createIntakeReviewHost(
      f.service as unknown as IngestionService,
      {
        upload: async () => ({ itemId: 'x' }),
        assignment: async () => ({ assigneeId: 'me', version: 1 }),
        assignedItemIds: async () => ['not-an-id', rows[1].id, rows[1].id, ''],
        assign: async () => {},
        evidence: async () => ({ label: 'Original' }),
      },
    );
    const page = await host.list({ assigneeId: 'me' });
    expect(page.items.map((entry) => entry.item.id)).toEqual([rows[1].id]);
    expect(f.service.listItems).toHaveBeenCalledWith(
      expect.objectContaining({ itemIds: [rows[1].id] }),
    );
    const none = createIntakeReviewHost(
      f.service as unknown as IngestionService,
      {
        upload: async () => ({ itemId: 'x' }),
        assignment: async () => ({ assigneeId: 'me', version: 1 }),
        assignedItemIds: async () => ['junk'],
        assign: async () => {},
        evidence: async () => ({ label: 'Original' }),
      },
    );
    expect(await none.list({ assigneeId: 'me' })).toEqual({ items: [] });
  });
  it('fills a filtered page across service pages when the assignee filter cannot be pushed down', async () => {
    const f = fixture();
    const rows = Array.from({ length: 12 }, (_, index) => ({
      id: String(index).padStart(2, '0'),
    }));
    f.service.listItems.mockImplementation(pageSource(rows));
    const assignment = vi.fn(async (itemId: string) => ({
      assigneeId: Number(itemId) % 4 === 3 ? 'me' : null,
      version: 0,
    }));
    const host = createIntakeReviewHost(
      f.service as unknown as IngestionService,
      {
        upload: async () => ({ itemId: 'x' }),
        assignment,
        assign: async () => {},
        evidence: async () => ({ label: 'Original' }),
      },
    );
    const page = await host.list({ assigneeId: 'me', limit: 2 });
    expect(page.items.map((entry) => entry.item.id)).toEqual(['03', '07']);
    expect(page.nextCursor).toBe('07');
    const rest = await host.list({
      assigneeId: 'me',
      limit: 2,
      cursor: page.nextCursor,
    });
    expect(rest.items.map((entry) => entry.item.id)).toEqual(['11']);
    expect(rest.nextCursor).toBeUndefined();
  });
  it('rejects repeating review page cursors while projecting an item view', async () => {
    const f = fixture();
    f.last.nextCursor = 'next';
    await expect(f.host.load('item')).rejects.toThrow('Repeated review cursor');
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
});
