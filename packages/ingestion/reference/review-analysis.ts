import type { IntakeItemDTO } from '../src/dto.js';
import type { ReviewPage } from '../src/review-dto.js';
import type { IngestionService } from '../src/server.js';
/** Known stale saved targets cannot authorize disclosure of old generation output. */
export async function loadReviewAnalysis(service: IngestionService, item: IntakeItemDTO, reviews: ReviewPage) {
  if (!['completed','partial'].includes(item.processingState) || reviews.generationStale || (reviews.actions.length > 0 && reviews.actions.every(({review})=>review.state === 'succeeded'))) return undefined;
  return service.getCompletedAnalysis(item.id);
}
