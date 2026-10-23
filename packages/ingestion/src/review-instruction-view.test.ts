import { describe, expect, it, vi } from 'vitest';
import type { ReviewerInstruction } from './review-dto.js';
import { loadInstructionView } from './review-instruction-view.js';

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
function service(
  histories: ReviewerInstruction[][],
  instructionInEffect: string | null,
) {
  const queue = [...histories];
  return {
    listReviewerInstructions: vi.fn(async () =>
      structuredClone(queue.length > 1 ? queue.shift()! : queue[0]),
    ),
    getReinterpretationState: vi.fn(async () => ({
      revision: 4,
      processingState: 'queued',
      failure: null,
      reinterpreting: true,
      generationAttemptId: 'generation',
      instructionInEffect,
    })),
  };
}

/** Shared by the published host and the maintained reference host. */
describe('reviewer instruction view projection', () => {
  it('re-reads history when an instruction is recorded between the two reads instead of reporting a drop', async () => {
    // History read sees A; B is recorded; the state read sees B in effect.
    const s = service(
      [[instruction('a')], [instruction('b'), instruction('a')]],
      'b',
    );
    const view = await loadInstructionView(s, 'item', undefined);
    expect(s.listReviewerInstructions).toHaveBeenCalledTimes(2);
    expect(view).toMatchObject({ current: instruction('b'), applied: null });
    expect(view).not.toHaveProperty('dropped');
  });
  it('reports dropped only when no instruction is in effect', async () => {
    const s = service([[instruction('a')]], null);
    expect(await loadInstructionView(s, 'item', undefined)).toMatchObject({
      current: null,
      dropped: instruction('a'),
    });
    expect(s.listReviewerInstructions).toHaveBeenCalledTimes(1);
  });
  it('never reports a superseded instruction as dropped even if another record lands during the re-read', async () => {
    const s = service(
      [[instruction('a')], [instruction('c'), instruction('b')]],
      'b',
    );
    const view = await loadInstructionView(s, 'item', undefined);
    expect(view).toMatchObject({ current: null, applied: null });
    expect(view).not.toHaveProperty('dropped');
  });
  it('projects nothing without history or an applied instruction', async () => {
    const s = service([[]], null);
    expect(await loadInstructionView(s, 'item', undefined)).toBeUndefined();
    expect(s.getReinterpretationState).not.toHaveBeenCalled();
  });
});
