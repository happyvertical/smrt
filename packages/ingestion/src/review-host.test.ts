import { describe, expect, it, vi } from 'vitest';
import type { IntakeEvidenceDTO, IntakeItemDTO } from './dto.js';
import type { ReviewPage } from './review-dto.js';
import {
  createIntakeReviewHost,
  type IntakeReviewHostOptions,
  primaryEvidence,
  type RowEvidenceRequest,
  type RowEvidenceView,
} from './review-host.js';
import {
  GenerationSnapshotStaleError,
  type IngestionService,
  type IntakeItemPage,
  IntakeScanLimitError,
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
      scanned: page.length,
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

function fixture(overrides: Partial<IntakeReviewHostOptions> = {}) {
  const item = { id: 'item', processingState: 'completed' } as IntakeItemDTO;
  const first = { actions: [], nextCursor: 'next' } as ReviewPage;
  const last = { actions: [] } as ReviewPage;
  const service = {
    getItem: vi.fn(async () => item),
    listItemsPage: vi.fn(pageSource([{ id: 'item', state: 'completed' }])),
    listReviews: vi.fn(async (_id: string, page: { cursor?: string }) =>
      page.cursor ? last : first,
    ),
    getCompletedAnalysis: vi.fn(async () => ({
      configuration: { stage: 'interpret' },
      result: { output: { proposals: { suggestions: [] } } },
    })),
    getEvidence: vi.fn(async (): Promise<IntakeEvidenceDTO[]> => []),
    listEvidence: vi.fn(
      async (_itemIds: string[]) => new Map<string, IntakeEvidenceDTO[]>(),
    ),
  };
  // The existing per-part adapter; `list` must never call it.
  const evidence = vi.fn(async (part: IntakeEvidenceDTO) => ({
    label: part.partId,
    viewUrl: `/original/${part.id}`,
    text: 'never on a row',
    ...(part.mediaType.startsWith('image/')
      ? { thumbnailUrl: `/thumb/${part.id}` }
      : {}),
  }));
  const host = createIntakeReviewHost(service as unknown as IngestionService, {
    upload: async () => ({ itemId: item.id }),
    assignment: async () => ({ assigneeId: null, version: 0 }),
    assign: async () => {},
    evidence,
    ...overrides,
  });
  return { host, service, first, last, item, evidence };
}
function part(
  id: string,
  partId: string,
  mediaType: string,
  parentEvidenceId: string | null = null,
): IntakeEvidenceDTO {
  return {
    id,
    partId,
    parentEvidenceId,
    mediaType,
    contentHash: 'hash',
    byteLength: 1,
  };
}

describe('inbox primary evidence', () => {
  it('prefers the shallowest non-metadata part and falls back to metadata', () => {
    const capture = part('capture', 'capture', 'application/json');
    const file = part('file', 'file', 'application/pdf', 'capture');
    expect(primaryEvidence([capture, file])).toBe(file);
    const message = part('message', 'message', 'application/json');
    const second = part('b', 'attachment:1', 'image/tiff', 'message');
    const first = part('a', 'attachment:0', 'application/pdf', 'message');
    expect(primaryEvidence([message, second, first])).toBe(first);
    expect(primaryEvidence([message])).toBe(message);
    expect(primaryEvidence([])).toBeUndefined();
  });
  it('chooses the original by role, not media type, so JSON originals are not mistaken for records', () => {
    // An uploaded .json file is the original, not its JSON capture record.
    const capture = part('capture', 'capture', 'application/json');
    const jsonFile = part('file', 'file', 'application/json', 'capture');
    expect(primaryEvidence([capture, jsonFile])).toBe(jsonFile);
    // A JSON-only email: the attachment, not the message record.
    const message = part('message', 'message', 'application/json');
    const jsonAttachment = part(
      'a',
      'attachment:0',
      'application/json',
      'message',
    );
    expect(primaryEvidence([message, jsonAttachment])).toBe(jsonAttachment);
    // Attachment ids sort numerically: attachment:2 precedes attachment:10.
    const tenth = part('j', 'attachment:10', 'application/pdf', 'message');
    const second = part('b', 'attachment:2', 'application/pdf', 'message');
    expect(primaryEvidence([message, tenth, second])).toBe(second);
    // Without any child part, the first root part is the original.
    const folderFile = part('o', 'original', 'application/pdf');
    expect(primaryEvidence([folderFile])).toBe(folderFile);
    const owner = part('w', 'owner', 'application/pdf');
    const long = part('l', 'long', 'application/pdf');
    expect(primaryEvidence([owner, long])).toBe(long);
  });
  it('without rowEvidence, list reads metadata once for labels but never the per-part adapter or a link', async () => {
    const f = fixture();
    const page = await f.host.list({});
    // One metadata read per page so labels can use the filename (#4214).
    expect(f.service.listEvidence).toHaveBeenCalledTimes(1);
    expect(f.service.getEvidence).not.toHaveBeenCalled();
    expect(f.evidence).not.toHaveBeenCalled();
    expect(page.items[0].evidence).toBeUndefined();
  });
  it('with rowEvidence, reads the page once and asks the host once, never the per-part adapter', async () => {
    const rowEvidence = vi.fn(
      async (rows: readonly RowEvidenceRequest[]) =>
        new Map(
          rows.map((row) => [
            row.itemId,
            {
              label: row.evidence.partId,
              viewUrl: `/original/${row.evidence.id}`,
              thumbnailUrl: `/thumb/${row.evidence.id}`,
              // A host value that tries to put text on a row is ignored.
              text: 'never on a row',
            } as RowEvidenceView,
          ]),
        ),
    );
    const f = fixture({ rowEvidence });
    const file = part('file', 'file', 'image/png', 'capture');
    f.service.listEvidence.mockResolvedValue(
      new Map([
        ['item', [part('capture', 'capture', 'application/json'), file]],
      ]),
    );
    const page = await f.host.list({});
    expect(f.service.listEvidence).toHaveBeenCalledTimes(1);
    expect(f.service.listEvidence).toHaveBeenCalledWith(['item']);
    expect(rowEvidence).toHaveBeenCalledTimes(1);
    expect(rowEvidence).toHaveBeenCalledWith([
      { itemId: 'item', evidence: file },
    ]);
    expect(f.evidence).not.toHaveBeenCalled();
    expect(f.service.getEvidence).not.toHaveBeenCalled();
    expect(page.items[0].evidence).toEqual({
      evidence: file,
      label: 'file',
      viewUrl: '/original/file',
      thumbnailUrl: '/thumb/file',
    });
    expect(page.items[0].evidence).not.toHaveProperty('text');
  });
  it('with rowEvidence, skips the host call for a page without evidence and lists when it throws', async () => {
    const empty = vi.fn(async () => new Map<string, RowEvidenceView>());
    const none = fixture({ rowEvidence: empty });
    expect((await none.host.list({})).items[0].evidence).toBeUndefined();
    expect(empty).not.toHaveBeenCalled();
    const failing = fixture({
      rowEvidence: async () => {
        throw new Error('preview service down');
      },
    });
    failing.service.listEvidence.mockResolvedValue(
      new Map([['item', [part('file', 'file', 'application/pdf')]]]),
    );
    const page = await failing.host.list({});
    expect(page.items.map((entry) => entry.item.id)).toEqual(['item']);
    expect(page.items[0].evidence).toBeUndefined();
  });
  it('leaves load unchanged: every part through evidence(part), no row preview on the entry', async () => {
    const f = fixture();
    f.service.getEvidence.mockResolvedValue([
      part('message', 'message', 'application/json'),
      part('att', 'attachment:0', 'application/pdf', 'message'),
    ]);
    const view = await f.host.load('item');
    expect(view.entry).not.toHaveProperty('evidence');
    expect(view.evidence.map((e) => e.evidence.id)).toEqual(['message', 'att']);
    expect(f.evidence).toHaveBeenCalledTimes(2);
  });
  it('gives no preview to a row without durable parts, even if the host answers for it', async () => {
    const other = {
      id: 'other',
      processingState: 'completed',
    } as IntakeItemDTO;
    const rowEvidence = vi.fn(
      async () =>
        new Map<string, RowEvidenceView>([
          ['item', { label: 'Original', viewUrl: '/original/item' }],
          // Answers for a row that has no durable parts on this page.
          ['other', { label: 'Phantom', viewUrl: '/original/other' }],
        ]),
    );
    const f = fixture({ rowEvidence });
    f.service.listItemsPage.mockImplementation(
      pageSource([{ id: f.item.id, state: 'completed' }, { id: other.id }]),
    );
    f.service.listEvidence.mockResolvedValue(
      new Map([['item', [part('file', 'file', 'application/pdf')]]]),
    );
    const page = await f.host.list({});
    expect(rowEvidence).toHaveBeenCalledWith([
      { itemId: 'item', evidence: part('file', 'file', 'application/pdf') },
    ]);
    expect(page.items[0].evidence?.viewUrl).toBe('/original/item');
    expect(page.items[1].evidence).toBeUndefined();
  });
  it('still lists the page when rowEvidence returns a malformed answer', async () => {
    for (const answer of [
      null,
      {},
      [['item', { label: 'Original' }]],
      new Map([['item', { label: 42 }]]),
    ]) {
      const f = fixture({
        rowEvidence: async () =>
          answer as unknown as ReadonlyMap<string, RowEvidenceView>,
      });
      f.service.listEvidence.mockResolvedValue(
        new Map([['item', [part('file', 'file', 'application/pdf')]]]),
      );
      const page = await f.host.list({});
      expect(page.items.map((entry) => entry.item.id)).toEqual(['item']);
      expect(page.items[0].evidence).toBeUndefined();
    }
  });
});

describe('labels from original names', () => {
  it('labels a row and a view by the primary original filename by default', async () => {
    const f = fixture();
    const parts = [
      part('capture', 'capture', 'application/json'),
      {
        ...part('file', 'file', 'application/pdf', 'capture'),
        filename: 'Acme March.pdf',
      },
    ];
    f.service.listEvidence.mockResolvedValue(new Map([['item', parts]]));
    expect((await f.host.list({})).items[0].label).toBe('Acme March.pdf');
    f.service.getEvidence.mockResolvedValue(parts);
    expect((await f.host.load('item')).entry.label).toBe('Acme March.pdf');
    f.service.listEvidence.mockResolvedValue(new Map());
    expect((await f.host.list({})).items[0].label).toBe('Intake item');
  });
  it('without rowEvidence, a failing evidence read lists with item labels instead of rejecting', async () => {
    const f = fixture();
    f.service.listEvidence.mockRejectedValue(new Error('Intake unavailable'));
    const page = await f.host.list({});
    expect(page.items.map((entry) => entry.item.id)).toEqual(['item']);
    expect(page.items[0].label).toBe('Intake item');
    expect(page.items[0].evidence).toBeUndefined();
    // A host label gets no evidence, as for a row without parts.
    const label = vi.fn(() => 'custom');
    const custom = fixture({ label });
    custom.service.listEvidence.mockRejectedValue(new Error('down'));
    expect((await custom.host.list({})).items[0].label).toBe('custom');
    expect(label).toHaveBeenCalledWith(custom.item, []);
  });
  it('with rowEvidence, a failing evidence read still rejects the page, as #4213 defines', async () => {
    const f = fixture({ rowEvidence: async () => new Map() });
    f.service.listEvidence.mockRejectedValue(new Error('Intake unavailable'));
    await expect(f.host.list({})).rejects.toThrow('Intake unavailable');
  });
  it('labels only from the primary part, never from another part with a name', async () => {
    const f = fixture();
    // The primary part (the attachment) has no name; the message record does.
    const parts = [
      {
        ...part('message', 'message', 'application/json'),
        filename: 'record.json',
      },
      part('att', 'attachment:0', 'application/pdf', 'message'),
    ];
    f.service.listEvidence.mockResolvedValue(new Map([['item', parts]]));
    expect((await f.host.list({})).items[0].label).toBe('Intake item');
    f.service.getEvidence.mockResolvedValue(parts);
    expect((await f.host.load('item')).entry.label).toBe('Intake item');
  });
  it('passes the evidence, primary part first, to a host label callback', async () => {
    const f = fixture();
    const label = vi.fn(
      (item: IntakeItemDTO, evidence: IntakeEvidenceDTO[]) =>
        `${item.id}:${evidence.map((part) => part.partId).join(',')}`,
    );
    const host = createIntakeReviewHost(
      f.service as unknown as IngestionService,
      {
        upload: async () => ({ itemId: 'item' }),
        assignment: async () => ({ assigneeId: null, version: 0 }),
        assign: async () => {},
        evidence: async () => ({ label: 'Original' }),
        label,
      },
    );
    f.service.listEvidence.mockResolvedValue(
      new Map([
        [
          'item',
          [
            part('message', 'message', 'application/json'),
            part('att', 'attachment:0', 'application/pdf', 'message'),
          ],
        ],
      ]),
    );
    expect((await host.list({})).items[0].label).toBe(
      'item:attachment:0,message',
    );
    expect(label).toHaveBeenCalledTimes(1);
  });
});

describe('published review host projection', () => {
  it('lists from one service page without per-row review or evidence reads', async () => {
    const f = fixture();
    const page = await f.host.list({});
    expect(page.items[0].state).toBe('completed');
    expect(page.nextCursor).toBeUndefined();
    expect(f.service.listItemsPage).toHaveBeenCalledTimes(1);
    expect(f.service.listItemsPage).toHaveBeenCalledWith({
      limit: 20,
      cursor: undefined,
      state: undefined,
      itemIds: undefined,
      scanLimit: 1000,
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
    f.service.listItemsPage.mockImplementation(pageSource(rows));
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
    expect(f.service.listItemsPage).toHaveBeenCalledTimes(3);
  });
  it('reads assignments once per page and pushes the assignee filter down when the host can', async () => {
    const f = fixture();
    const uid = (n: number) =>
      `0b6e1c1e-5b9b-4a1e-9b1e-${String(n).padStart(12, '0')}`;
    const rows = Array.from({ length: 6 }, (_, index) => ({ id: uid(index) }));
    const mine = [uid(2), uid(4)];
    f.service.listItemsPage.mockImplementation(pageSource(rows));
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
    expect(f.service.listItemsPage).toHaveBeenCalledTimes(1);
    expect(f.service.listItemsPage).toHaveBeenCalledWith(
      expect.objectContaining({ itemIds: mine }),
    );
    expect(assignments).toHaveBeenCalledTimes(1);
    expect(assignments).toHaveBeenCalledWith(mine);
  });
  it('labels and previews rows on every list return path', async () => {
    const rowEvidence = vi.fn(
      async (rows: readonly RowEvidenceRequest[]) =>
        new Map<string, RowEvidenceView>(
          rows.map((row) => [row.itemId, { label: 'Original', viewUrl: '/o' }]),
        ),
    );
    const f = fixture({
      rowEvidence,
      assignment: async (itemId) => ({
        assigneeId: itemId === '0003' ? 'me' : null,
        version: 0,
      }),
    });
    f.service.listEvidence.mockImplementation(
      async (ids: string[]) =>
        new Map(
          ids.map((id) => [
            id,
            [
              {
                ...part(`p-${id}`, 'file', 'application/pdf'),
                filename: `${id}.pdf`,
              },
            ],
          ]),
        ),
    );
    const decorated = (page: Awaited<ReturnType<typeof f.host.list>>) =>
      page.items.map((entry) => [entry.label, entry.evidence?.viewUrl]);
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: String(index).padStart(4, '0'),
    }));
    // Full page with a continuation.
    f.service.listItemsPage.mockImplementation(pageSource(rows));
    const full = await f.host.list({ limit: 2 });
    expect(full.nextCursor).toBe('0001');
    expect(decorated(full)).toEqual([
      ['0000.pdf', '/o'],
      ['0001.pdf', '/o'],
    ]);
    // Last page, no cursor.
    f.service.listItemsPage.mockImplementation(pageSource(rows.slice(0, 1)));
    const last = await f.host.list({});
    expect(last.nextCursor).toBeUndefined();
    expect(decorated(last)).toEqual([['0000.pdf', '/o']]);
    // Short, budget-stopped service page.
    f.service.listItemsPage.mockResolvedValueOnce({
      items: [
        {
          item: { id: '0005', processingState: 'completed' } as IntakeItemDTO,
          state: 'unresolved',
          cursor: '0005',
        },
      ],
      scanned: 1000,
      nextCursor: '0005',
    });
    const short = await f.host.list({});
    expect(short.nextCursor).toBe('0005');
    expect(decorated(short)).toEqual([['0005.pdf', '/o']]);
    // A later call that fails without progress keeps what was collected.
    let calls = 0;
    f.service.listItemsPage.mockImplementation(async (input = {}) => {
      calls++;
      if (calls === 2) throw new IntakeScanLimitError();
      return { ...(await pageSource(rows)(input)), scanned: 999 };
    });
    const kept = await f.host.list({ assigneeId: 'me', limit: 20 });
    expect(kept.nextCursor).toBe('0019');
    expect(decorated(kept)).toEqual([['0003.pdf', '/o']]);
    expect(rowEvidence).toHaveBeenCalledTimes(4);
    // Without the opt-in, the same paths call no row-evidence host code and
    // never the per-part `evidence` adapter.
    const plain = fixture();
    plain.service.listItemsPage.mockImplementation(pageSource(rows));
    await plain.host.list({ limit: 2 });
    expect(plain.evidence).not.toHaveBeenCalled();
  });
  it('clamps the requested page size to the service range instead of failing', async () => {
    const f = fixture();
    for (const [requested, sent] of [
      [500, 100],
      [0, 1],
      [2.7, 2],
      [Number.NaN, 20],
      [Number.POSITIVE_INFINITY, 100],
    ] as const) {
      f.service.listItemsPage.mockClear();
      await f.host.list({ limit: requested });
      expect(f.service.listItemsPage).toHaveBeenCalledWith(
        expect.objectContaining({ limit: sent }),
      );
    }
  });
  it('keeps collected items when a later service call fails without progress', async () => {
    const f = fixture();
    const rows = Array.from({ length: 300 }, (_, index) => ({
      id: String(index).padStart(4, '0'),
    }));
    let calls = 0;
    f.service.listItemsPage.mockImplementation(async (input = {}) => {
      calls++;
      if (calls === 2) throw new IntakeScanLimitError();
      const page = await pageSource(rows)(input);
      return { ...page, scanned: 999 };
    });
    const host = createIntakeReviewHost(
      f.service as unknown as IngestionService,
      {
        upload: async () => ({ itemId: 'x' }),
        assignment: async (itemId) => ({
          assigneeId: itemId === '0003' ? 'me' : null,
          version: 0,
        }),
        assign: async () => {},
        evidence: async () => ({ label: 'Original' }),
      },
    );
    // The first call scans 999 rows and yields one match; the second, with a
    // one-row budget, fails without progress. The host returns the match and
    // the position the first call reached.
    const page = await host.list({ assigneeId: 'me', limit: 20 });
    expect(page.items.map((entry) => entry.item.id)).toEqual(['0003']);
    expect(page.nextCursor).toBe('0019');
    expect(calls).toBe(2);
    // Failing on the very first call has no position to hand back.
    calls = 1;
    await expect(host.list({ assigneeId: 'me', limit: 20 })).rejects.toThrow(
      'Intake scan limit',
    );
  });
  it('returns a short service page with its cursor instead of scanning past the service ceiling', async () => {
    const f = fixture();
    f.service.listItemsPage.mockResolvedValue({
      items: [],
      scanned: 1000,
      nextCursor: 'ceiling',
    });
    expect(await f.host.list({})).toEqual({ items: [], nextCursor: 'ceiling' });
    expect(f.service.listItemsPage).toHaveBeenCalledTimes(1);
    const assignment = vi.fn(async () => ({ assigneeId: null, version: 0 }));
    const host = createIntakeReviewHost(
      f.service as unknown as IngestionService,
      {
        upload: async () => ({ itemId: 'x' }),
        assignment,
        assign: async () => {},
        evidence: async () => ({ label: 'Original' }),
      },
    );
    expect(await host.list({ assigneeId: 'me' })).toEqual({
      items: [],
      nextCursor: 'ceiling',
    });
    expect(f.service.listItemsPage).toHaveBeenCalledTimes(2);
  });
  it('caps the assignee scan fallback at the scan ceiling and hands back the cursor', async () => {
    const f = fixture();
    const rows = Array.from({ length: 2000 }, (_, index) => ({
      id: String(index).padStart(4, '0'),
    }));
    f.service.listItemsPage.mockImplementation(pageSource(rows));
    const host = createIntakeReviewHost(
      f.service as unknown as IngestionService,
      {
        upload: async () => ({ itemId: 'x' }),
        assignment: async () => ({ assigneeId: null, version: 0 }),
        assign: async () => {},
        evidence: async () => ({ label: 'Original' }),
      },
    );
    const page = await host.list({ assigneeId: 'nobody', limit: 100 });
    // 1000 rows examined in ten 100-row service pages, then the call ends
    // with the continuation; the caller decides whether to keep scanning.
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBe('0999');
    expect(f.service.listItemsPage).toHaveBeenCalledTimes(10);
    // The cap counts rows the service scanned, not rows it returned: full
    // pages that each cost 500 denied rows stop after two service calls.
    let calls = 0;
    f.service.listItemsPage.mockImplementation(async (input = {}) => {
      calls++;
      const page = await pageSource(rows)(input);
      return { ...page, scanned: 500 };
    });
    const costly = await host.list({ assigneeId: 'nobody', limit: 100 });
    expect(costly.items).toEqual([]);
    expect(costly.nextCursor).toBe('0199');
    expect(calls).toBe(2);
    // The remaining budget travels with each call: after 999 scanned rows the
    // next service call may scan one, and the host stops there.
    const budgets: Array<number | undefined> = [];
    f.service.listItemsPage.mockImplementation(async (input = {}) => {
      budgets.push(input.scanLimit);
      const page = await pageSource(rows)(input);
      return { ...page, scanned: budgets.length === 1 ? 999 : 1 };
    });
    const capped = await host.list({ assigneeId: 'nobody', limit: 100 });
    expect(capped.items).toEqual([]);
    expect(capped.nextCursor).toBe('0199');
    expect(budgets).toEqual([1000, 1]);
  });
  it('drops junk ids from the assignee pushdown instead of failing the list', async () => {
    const f = fixture();
    const rows = [
      { id: '0b6e1c1e-5b9b-4a1e-9b1e-000000000001' },
      { id: '0b6e1c1e-5b9b-4a1e-9b1e-000000000002' },
    ];
    f.service.listItemsPage.mockImplementation(pageSource(rows));
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
    expect(f.service.listItemsPage).toHaveBeenCalledWith(
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
    f.service.listItemsPage.mockImplementation(pageSource(rows));
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
