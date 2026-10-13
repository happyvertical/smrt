import { ObjectRegistry } from '@happyvertical/smrt-core';
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
  it('offers host routes without advertising unavailable generated model screens', () => {
    for (const recipe of [IngestionInboxRecipe, IngestionReviewRecipe]) {
      for (const model of recipe.models) {
        const registered = ObjectRegistry.getClass(model.name);
        expect(registered, model.name).toBeDefined();
        expect(registered?.config.api).toBe(false);
        expect(registered?.config.cli).toBe(false);
        expect(registered?.config.mcp).toBe(false);
      }
      expect(recipe.nav).toEqual([]);
      expect(recipe.surfaces).toHaveLength(1);
      expect(recipe.surfaces[0].kind).toBe('route');
      expect(recipe.surfaces[0].path).toMatch(/^\/ingestion\//);
    }
  });

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
    expect(IngestionInboxRecipe.nav).toEqual([]);
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
    expect(IngestionReviewRecipe.nav).toEqual([]);
    expect(IngestionReviewRecipe.help).toBe('./ingestion-review.recipe.md');
  });
});
