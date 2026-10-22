import { describe, expect, it, vi } from 'vitest';
import type { IntakeEvidenceDTO, IntakeItemDTO } from './dto.js';
import type { ReviewPage } from './review-dto.js';
import { createIntakeReviewHost, primaryEvidence } from './review-host.js';
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
    getEvidence: vi.fn(async (): Promise<IntakeEvidenceDTO[]> => []),
    listEvidence: vi.fn(async () => new Map<string, IntakeEvidenceDTO[]>()),
  };
  const host = createIntakeReviewHost(service as unknown as IngestionService, {
    upload: async () => ({ itemId: item.id }),
    assignment: async () => ({ assigneeId: null, version: 0 }),
    assign: async () => {},
    evidence: async (part) => ({
      label: part.partId,
      viewUrl: `/original/${part.id}`,
      text: 'never on a row',
      ...(part.mediaType.startsWith('image/')
        ? { thumbnailUrl: `/thumb/${part.id}` }
        : {}),
    }),
  });
  return { host, service, first, last };
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
  it('projects one batched evidence read onto the page instead of a load per row', async () => {
    const f = fixture();
    f.service.listEvidence.mockResolvedValue(
      new Map([
        [
          'item',
          [
            part('capture', 'capture', 'application/json'),
            part('file', 'file', 'image/png', 'capture'),
          ],
        ],
      ]),
    );
    const page = await f.host.list({});
    expect(f.service.listEvidence).toHaveBeenCalledTimes(1);
    expect(f.service.listEvidence).toHaveBeenCalledWith(['item']);
    expect(f.service.getEvidence).not.toHaveBeenCalled();
    expect(page.items[0].evidence).toEqual({
      evidence: part('file', 'file', 'image/png', 'capture'),
      label: 'file',
      viewUrl: '/original/file',
      thumbnailUrl: '/thumb/file',
    });
    expect(page.items[0].evidence).not.toHaveProperty('text');
  });
  it('omits evidence for rows without durable parts and mirrors it on load', async () => {
    const f = fixture();
    expect((await f.host.list({})).items[0].evidence).toBeUndefined();
    f.service.getEvidence.mockResolvedValue([
      part('message', 'message', 'application/json'),
      part('att', 'attachment:0', 'application/pdf', 'message'),
    ]);
    const view = await f.host.load('item');
    expect(view.entry.evidence?.evidence.id).toBe('att');
    expect(view.entry.evidence).not.toHaveProperty('text');
    expect(view.evidence.map((e) => e.evidence.id)).toEqual(['message', 'att']);
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
});
