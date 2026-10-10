import type { IntakeItemDTO } from '../src/dto.js';
import type { InboxState, ReviewPage } from '../src/review-dto.js';
import type { IngestionService } from '../src/server.js';

/** Whole-item state requires each page's live handler, parent and target gates. */
export async function loadReviewSummary(
  service: IngestionService,
  item: IntakeItemDTO,
  requestedCursor?: string,
): Promise<{ reviews: ReviewPage; state: InboxState }> {
  let requested: ReviewPage | undefined;
  if (requestedCursor !== undefined)
    requested = await service.listReviews(item.id, { cursor: requestedCursor });
  let cursor: string | undefined;
  let total = 0,
    succeeded = 0,
    deferred = 0,
    failed = 0;
  const cursors = new Set<string>();
  do {
    const page = await service.listReviews(item.id, { cursor });
    if (requestedCursor === undefined && cursor === undefined) requested = page;
    for (const action of page.actions) {
      total++;
      if (action.review.state === 'succeeded') succeeded++;
      if (action.review.state === 'deferred') deferred++;
      if (['failed', 'outcome_unknown'].includes(action.review.state)) failed++;
    }
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor))
      throw new Error('Repeated review cursor');
    if (cursor) cursors.add(cursor);
    // Other pages are discarded; only scalar state and the requested page survive.
  } while (cursor);
  const current = await service.getItem(item.id);
  if (!requested) throw new Error('Review page unavailable');
  const state: InboxState = total
    ? succeeded === total
      ? 'completed'
      : succeeded
        ? 'partially_completed'
        : deferred
          ? 'deferred'
          : failed
            ? 'failed'
            : 'waiting'
    : ['queued', 'running'].includes(current.processingState)
      ? 'processing'
      : current.processingState === 'needs_attention'
        ? 'failed'
        : 'unresolved';
  return { reviews: requested, state };
}
