import { describe, expect, it } from 'vitest';
import { IngestionInboxRecipe, IngestionReviewRecipe } from './index.js';
import {
  IntakeAction,
  IntakeAnalysis,
  IntakeEvidence,
  IntakeItem,
  IntakeReviewDecision,
} from './models.js';

describe('ingestion recipes', () => {
  it('exports the scoped inbox workflow declaration', () => {
    expect(IngestionInboxRecipe.id).toBe('ingestion.inbox');
    expect(IngestionInboxRecipe.models).toEqual([IntakeItem, IntakeEvidence]);
    expect(IngestionInboxRecipe.nav).toEqual([
      { label: 'Ingestion inbox', model: IntakeItem },
    ]);
    expect(IngestionInboxRecipe.help).toBe('./ingestion-inbox.recipe.md');
  });

  it('exports the revision-bound review workflow declaration', () => {
    expect(IngestionReviewRecipe.id).toBe('ingestion.review');
    expect(IngestionReviewRecipe.models).toEqual([
      IntakeItem,
      IntakeEvidence,
      IntakeAnalysis,
      IntakeAction,
      IntakeReviewDecision,
    ]);
    expect(IngestionReviewRecipe.nav).toEqual([
      { label: 'Ingestion review', model: IntakeReviewDecision },
    ]);
    expect(IngestionReviewRecipe.help).toBe('./ingestion-review.recipe.md');
  });
});
