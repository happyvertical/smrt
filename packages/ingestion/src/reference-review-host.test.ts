import { describe, expect, it, vi } from 'vitest';
import {
  ReferenceReviewHost,
  type ReviewSession,
} from '../reference/review-host.js';
import { HandlerArgumentsInvalidError } from './proposal-errors.js';

/**
 * The maintained fixture's `preview` must refuse the same cases as the
 * published host on the human-arguments path (#4208): a failed attempt, a
 * non-interpretation stage and an unoffered handler never create an action.
 */
function analysis(
  stage: string,
  outcome: string,
  offered: unknown[],
  proposals = true,
) {
  return {
    configuration: { stage },
    result: {
      output: proposals
        ? {
            proposals: {
              outcome,
              offered,
              suggestions: [
                {
                  handlerId: 'draft',
                  handlerVersion: '1',
                  args: { body: 'Body' },
                  missingFields: ['title'],
                  disposition: 'needs_review',
                },
              ],
            },
          }
        : {},
    },
  };
}
const offered = [
  {
    handler: { id: 'draft', version: '1', kind: 'operation' },
    candidates: [],
  },
];
function fixture(current: unknown) {
  const service = {
    getCompletedAnalysis: vi.fn(async () => current),
    createAction: vi.fn(async () => 'action-1'),
    listReviews: vi.fn(async () => ({ actions: [] })),
    previewProposal: vi.fn(async () => ({ state: 'waiting_review' })),
    previewPlan: vi.fn(async () => ({ steps: [] })),
    previewGeneratedProposals: vi.fn(async () => []),
  };
  const host = Object.create(
    ReferenceReviewHost.prototype,
  ) as ReferenceReviewHost;
  Object.assign(host, { service: async () => ({ service }) });
  return { host, service };
}
const scope = {
  actorId: 'owner',
  tenantId: 'tenant',
  confidentialScopeId: 'private',
} as unknown as ReviewSession;
const input = {
  itemId: 'item',
  attemptId: 'attempt',
  index: 0,
  requestId: 'request',
  args: { title: 'Human title', body: 'Body' },
};

describe('reference review host preview with human arguments', () => {
  it('publishes completed arguments through the ordinary operation preview', async () => {
    const f = fixture(analysis('interpret', 'proposals', offered));
    const result = await f.host.preview(scope, input);
    expect(result).toEqual([
      { kind: 'operation', review: { state: 'waiting_review' } },
    ]);
    expect(f.service.createAction).toHaveBeenCalledWith('item', 'ui:0', {
      origin: 'generated-proposal',
      intentionKey: 'ui:0',
    });
    expect(f.service.previewProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'action-1',
        handlerId: 'draft',
        handlerVersion: '1',
        args: input.args,
      }),
    );
    expect(f.service.previewGeneratedProposals).not.toHaveBeenCalled();
  });
  it('maps only handler validation to a typed rejection on the review transport', async () => {
    const f = fixture(analysis('interpret', 'proposals', offered));
    f.service.previewProposal.mockRejectedValueOnce(
      new HandlerArgumentsInvalidError('Invalid handler arguments'),
    );
    await expect(f.host.previewForReview(scope, input)).resolves.toEqual({
      rejected: 'invalid',
    });
    f.service.previewProposal.mockRejectedValueOnce(new Error('Access denied'));
    await expect(f.host.previewForReview(scope, input)).rejects.toThrow(
      'Access denied',
    );
    // The programmatic `preview` contract is unchanged: it still throws.
    f.service.previewProposal.mockRejectedValueOnce(
      new HandlerArgumentsInvalidError('Invalid handler arguments'),
    );
    await expect(f.host.preview(scope, input)).rejects.toBeInstanceOf(
      HandlerArgumentsInvalidError,
    );
  });
  it.each([
    ['a failed attempt', analysis('interpret', 'provider_error', offered)],
    ['a non-interpretation stage', analysis('extract', 'proposals', offered)],
    ['an unoffered handler', analysis('interpret', 'proposals', [])],
    [
      'an interpretation without proposal output',
      analysis('interpret', 'proposals', offered, false),
    ],
  ] as const)('refuses %s before creating any action', async (_name, current) => {
    const f = fixture(current);
    await expect(f.host.preview(scope, input)).rejects.toThrow(
      'Preview unavailable',
    );
    expect(f.service.createAction).not.toHaveBeenCalled();
    expect(f.service.previewProposal).not.toHaveBeenCalled();
    expect(f.service.previewPlan).not.toHaveBeenCalled();
    expect(f.service.previewGeneratedProposals).not.toHaveBeenCalled();
  });
});
