import { ATTACH } from '../reference/handlers.js';
import type { ReferenceReviewHost } from '../reference/review-host.js';
import type { ItemReviewView } from '../src/review-dto.js';
import { EVALUATION_SCOPE } from './reference-case.js';
/** Scripted reviewer against the frozen authored training oracle. This runs only
 * after raw model output has been retained; it never alters measured predictions.
 */
export async function recordTrainingCorrection(
  host: ReferenceReviewHost,
  view: ItemReviewView,
  expectedTarget: string | null,
  candidates: Readonly<Record<string, string>>,
) {
  if (!view.generation || !view.analysis)
    return { available: false, reason: 'no_generation', changedFields: 0 };
  const index = view.generation.suggestions.findIndex(
    (suggestion) =>
      suggestion.disposition === 'ready_for_review' &&
      (expectedTarget === null || suggestion.handlerId === ATTACH),
  );
  if (index < 0)
    return {
      available: false,
      reason: 'no_compatible_reviewable_offer',
      changedFields: 0,
    };
  const original = view.generation.suggestions[index];
  const preview = await host.preview(EVALUATION_SCOPE, {
    itemId: view.entry.item.id,
    attemptId: view.analysis.attemptId,
    index,
    requestId: 'evaluation-training-preview',
  });
  if (preview.length !== 1 || preview[0].kind !== 'operation')
    throw Error('Unexpected training review');
  let review = preview[0].review,
    changedFields = 0;
  const reviewer = { ...EVALUATION_SCOPE, actorId: 'reviewer' };
  if (expectedTarget === null) {
    review = await host.decide(reviewer, {
      actionId: review.actionId,
      expectedRevision: review.revision,
      expectedReviewVersion: review.reviewVersion,
      bindingHash: review.bindingHash,
      requestId: 'evaluation-training-reject',
      decision: 'reject',
      reason: 'Agent-authored frozen training oracle expects no action',
    });
  } else {
    const expected = candidates[expectedTarget];
    if (!expected) throw Error('Frozen training target unavailable');
    if (original.args.contentId !== expected) {
      changedFields = 1;
      review = await host.decide(reviewer, {
        actionId: review.actionId,
        expectedRevision: review.revision,
        expectedReviewVersion: review.reviewVersion,
        bindingHash: review.bindingHash,
        requestId: 'evaluation-training-correct',
        decision: 'correct',
        correctedArgs: { ...original.args, contentId: expected },
        reason:
          'Scripted correction against agent-authored frozen training oracle',
      });
    }
  }
  const { service } = await host.service(reviewer);
  const feedback = await service.recordFeedback({
    itemId: view.entry.item.id,
    actionId: review.actionId,
    expectedRevision: review.revision,
    expectedReviewVersion: review.reviewVersion,
    bindingHash: review.bindingHash,
    judgment: expectedTarget === null ? 'incorrect' : 'correct',
    requestId: 'evaluation-training-judgment',
    comment:
      'Scripted authenticated evaluation judgment; not observed human participation',
  });
  return {
    available: true,
    changedFields,
    feedback,
    review,
    original,
    expectedTarget,
  };
}
