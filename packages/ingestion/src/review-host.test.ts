import { describe, expect, it, vi } from 'vitest';
import type { IntakeEvidenceDTO, IntakeItemDTO } from './dto.js';
import type { ReviewerInstruction, ReviewPage } from './review-dto.js';
import {
  createIntakeReviewHost,
  type IntakeReviewHostOptions,
  primaryEvidence,
  type RowEvidenceRequest,
  type RowEvidenceView,
} from './review-host.js';
import {
  ReviewerInstructionInvalidError,
  ReviewerInstructionStaleError,
  reviewerInstructionView,
} from './reviewer-instruction.js';
import {
  GenerationSnapshotStaleError,
  type IngestionService,
} from './server.js';

vi.mock('./reviewer-instruction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./reviewer-instruction.js')>()),
  reviewerInstructionView: (value: unknown) => value,
}));

function fixture(overrides: Partial<IntakeReviewHostOptions> = {}) {
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
    getEvidence: vi.fn(async (): Promise<IntakeEvidenceDTO[]> => []),
    listEvidence: vi.fn(async () => new Map<string, IntakeEvidenceDTO[]>()),
    listReviewerInstructions: vi.fn(async () => [] as ReviewerInstruction[]),
    getReinterpretationState: vi.fn(async () => ({
      revision: 4,
      processingState: 'completed',
      failure: null as string | null,
      reinterpreting: false,
      generationAttemptId: null as string | null,
      instructionInEffect: 'current' as string | null,
    })),
    recordReviewerInstruction: vi.fn(async () => ({
      id: 'analysis',
      revision: 4,
      instruction: instruction('current'),
    })),
  };
  const woken: Array<[string, number]> = [];
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
    onInstruct: async (itemId, revision) => {
      woken.push([itemId, revision]);
    },
    ...overrides,
  });
  return { host, service, first, last, item, evidence, woken };
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
    f.service.listItems.mockResolvedValue([f.item, other]);
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
  it('turns a stale instruction into a refresh signal and projects the in-flight gap', async () => {
    const f = fixture();
    f.service.recordReviewerInstruction.mockRejectedValueOnce(
      new ReviewerInstructionStaleError(),
    );
    const input = {
      itemId: 'item',
      attemptId: 'attempt',
      expectedRevision: 3,
      text: 'File it.',
      requestId: 'stale',
    };
    await expect(f.host.instruct?.(input)).resolves.toEqual({ stale: true });
    f.service.recordReviewerInstruction.mockRejectedValueOnce(
      new ReviewerInstructionInvalidError(),
    );
    await expect(f.host.instruct?.(input)).resolves.toEqual({ invalid: true });
    expect(f.woken).toEqual([]);
    f.service.recordReviewerInstruction.mockRejectedValueOnce(
      new Error('Intake unavailable'),
    );
    await expect(f.host.instruct?.(input)).rejects.toThrow(
      'Intake unavailable',
    );
    // Between stages: the displayed analysis is the extraction, so the host
    // offers the retry anchor and marks the item as still reinterpreting.
    f.service.listReviewerInstructions.mockResolvedValue([
      instruction('current'),
    ]);
    f.service.getCompletedAnalysis.mockResolvedValue({
      configuration: { stage: 'extract' },
      result: { output: {} },
    } as never);
    f.service.getReinterpretationState.mockResolvedValue({
      revision: 7,
      processingState: 'completed',
      failure: null,
      reinterpreting: true,
      generationAttemptId: 'generation',
      instructionInEffect: 'current',
    });
    expect((await f.host.load('item')).instruction).toEqual({
      current: instruction('current'),
      applied: null,
      stale: true,
      reinterpreting: true,
      binding: { attemptId: 'generation', expectedRevision: 7 },
    });
  });
  it('reports a reprocess-dropped instruction as dropped, not pending', async () => {
    const f = fixture();
    f.service.listReviewerInstructions.mockResolvedValue([
      instruction('dropped'),
    ]);
    f.service.getReinterpretationState.mockResolvedValue({
      revision: 9,
      processingState: 'completed',
      failure: null,
      reinterpreting: false,
      generationAttemptId: 'generation',
      instructionInEffect: null,
    });
    expect((await f.host.load('item')).instruction).toEqual({
      current: null,
      applied: null,
      stale: false,
      dropped: instruction('dropped'),
    });
  });
});
