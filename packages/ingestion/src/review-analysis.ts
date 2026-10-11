import type { IntakeItemDTO } from './dto.js';
import type { CompletedAnalysisSnapshot } from './proposal-dto.js';
import { GenerationSnapshotStaleError } from './proposal-errors.js';
import type { ReviewPage } from './review-dto.js';
import type { IngestionService } from './server.js';
/** Optional generation availability never substitutes for current saved-review authority. */
export async function loadReviewAnalysis(
  service: IngestionService,
  item: IntakeItemDTO,
  reviews: ReviewPage,
  cursor?: string,
): Promise<{ reviews: ReviewPage; analysis?: CompletedAnalysisSnapshot }> {
  if (
    !['completed', 'partial'].includes(item.processingState) ||
    reviews.generationStale
  )
    return { reviews };
  try {
    return { reviews, analysis: await service.getCompletedAnalysis(item.id) };
  } catch (error) {
    if (!(error instanceof GenerationSnapshotStaleError)) throw error;
    // The old page is not a fallback: authority may have changed during snapshot reads.
    return { reviews: await service.listReviews(item.id, { cursor }) };
  }
}
