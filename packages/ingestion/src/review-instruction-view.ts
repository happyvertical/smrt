/** Server-side projection of an item's reviewer-instruction state for review hosts. */
import type { CompletedAnalysisSnapshot } from './proposal-dto.js';
import type { ReviewerInstructionView } from './review-dto.js';
import { reviewerInstructionView } from './reviewer-instruction.js';
import type { IngestionService } from './server.js';

/**
 * Project `ItemReviewView.instruction`. History and reinterpretation state are
 * separate reads, so an instruction recorded between them would otherwise look
 * like a dropped one: when the in-effect id names a different instruction the
 * history is re-read, and `dropped` is set only when nothing is in effect.
 */
export async function loadInstructionView(
  service: Pick<
    IngestionService,
    'listReviewerInstructions' | 'getReinterpretationState'
  >,
  itemId: string,
  analysis: CompletedAnalysisSnapshot | undefined,
): Promise<ReviewerInstructionView | undefined> {
  let [latest] = await service.listReviewerInstructions(itemId);
  // Only a generation "applies" an instruction; a completed extraction
  // carries the same record but has produced no suggestions yet.
  const applied =
    analysis?.configuration.stage === 'interpret' &&
    analysis.configuration.reviewerInstruction
      ? reviewerInstructionView(analysis.configuration.reviewerInstruction)
      : null;
  if (!latest && !applied) return undefined;
  const state = await service.getReinterpretationState(itemId);
  if (
    state.instructionInEffect !== null &&
    state.instructionInEffect !== latest?.id
  )
    // An instruction was recorded between the two reads: re-read history.
    [latest] = await service.listReviewerInstructions(itemId);
  const current =
    latest && latest.id === state.instructionInEffect ? latest : null;
  return {
    current,
    applied,
    stale: !!analysis && !!current && current.id !== applied?.id,
    // Dropped means no instruction is in effect (a host reprocess), never
    // "superseded by a newer instruction".
    ...(latest && state.instructionInEffect === null
      ? { dropped: latest }
      : {}),
    ...(state.failure ? { failure: state.failure } : {}),
    ...(state.reinterpreting ? { reinterpreting: true } : {}),
    // Without a displayable generation the reviewer can still retry or change
    // the instruction against the latest completed generation.
    ...(analysis?.configuration.stage !== 'interpret' &&
    state.generationAttemptId
      ? {
          binding: {
            attemptId: state.generationAttemptId,
            expectedRevision: state.revision,
          },
        }
      : {}),
  };
}
