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
    expect(IngestionInboxRecipe.group).toEqual({
      id: 'ingestion',
      label: 'Ingestion',
      summary: 'Review incoming material safely before it can change records.',
    });
    expect(IngestionInboxRecipe.section).toEqual({
      id: 'ingestion',
      label: 'Ingestion',
      icon: 'archive',
      description: 'Incoming material and its authenticated review workflow.',
    });
    expect(IngestionInboxRecipe.runtime).toBe('both');
    expect(IngestionInboxRecipe.surfaces).toEqual([
      {
        kind: 'route',
        path: '/ingestion/inbox',
        export: '@happyvertical/smrt-ingestion/svelte#IntakeInbox',
        label: 'Ingestion inbox',
      },
    ]);
    expect(IngestionInboxRecipe.providers).toBeUndefined();
    expect(IngestionInboxRecipe.demoSeed).toBeUndefined();
    expect(IngestionInboxRecipe.nav).toEqual([
      {
        label: 'Ingestion inbox',
        model: IntakeItem,
        icon: 'archive',
        description: 'Incoming material that needs authenticated attention.',
        key: 'inbox',
        noun: 'inbox item',
      },
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
    expect(IngestionReviewRecipe.group).toEqual(IngestionInboxRecipe.group);
    expect(IngestionReviewRecipe.section).toEqual(IngestionInboxRecipe.section);
    expect(IngestionReviewRecipe.runtime).toBe('both');
    expect(IngestionReviewRecipe.surfaces).toEqual([
      {
        kind: 'route',
        path: '/ingestion/review',
        export: '@happyvertical/smrt-ingestion/svelte#IntakeReview',
        label: 'Ingestion review',
      },
    ]);
    expect(IngestionReviewRecipe.providers).toBeUndefined();
    expect(IngestionReviewRecipe.demoSeed).toBeUndefined();
    expect(IngestionReviewRecipe.nav).toEqual([
      {
        label: 'Ingestion review',
        model: IntakeReviewDecision,
        icon: 'fileText',
        description: 'Revision-bound decisions on proposed actions.',
        key: 'review',
        noun: 'review decision',
      },
    ]);
    expect(IngestionReviewRecipe.help).toBe('./ingestion-review.recipe.md');
  });
});
