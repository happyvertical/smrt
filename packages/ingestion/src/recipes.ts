/**
 * Declared ingestion workflows for applications that provide an authenticated
 * intake-review host (#3725).
 *
 * These recipes describe the user-facing inbox and review work. They do not
 * expose the ingestion records as generic CRUD models: all reads and writes
 * continue through the host's scoped service callbacks.
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import {
  IntakeAction,
  IntakeAnalysis,
  IntakeEvidence,
  IntakeItem,
  IntakeReviewDecision,
} from './models.js';

/** Incoming material that needs authenticated human attention. */
export class IngestionInboxRecipe extends SmrtRecipe {
  static id = 'ingestion.inbox';
  static help = './ingestion-inbox.recipe.md';
  static label = 'Ingestion inbox';
  static summary =
    'Review incoming material and see which items need attention.';
  static synonyms = ['intake inbox', 'incoming documents', 'review queue'];
  static group = {
    id: 'ingestion',
    label: 'Ingestion',
    summary: 'Review incoming material safely before it can change records.',
  };
  static section = {
    id: 'ingestion',
    label: 'Ingestion',
    icon: 'archive',
    description: 'Incoming material and its authenticated review workflow.',
  };
  static models = [IntakeItem, IntakeEvidence];
  static runtime = 'browser' as const;
  static surfaces = [
    {
      kind: 'route',
      path: '/ingestion/inbox',
      export: '@happyvertical/smrt-ingestion/svelte#IntakeInbox',
      label: 'Ingestion inbox',
    },
  ] as const;
  static nav = [
    {
      label: 'Ingestion inbox',
      model: IntakeItem,
      icon: 'archive',
      description: 'Incoming material that needs authenticated attention.',
      key: 'inbox',
      noun: 'inbox item',
    },
  ];
}

/** Revision-bound human review of proposed actions. */
export class IngestionReviewRecipe extends SmrtRecipe {
  static id = 'ingestion.review';
  static help = './ingestion-review.recipe.md';
  static label = 'Ingestion review';
  static summary =
    'Inspect evidence and approve, change, reject, or defer proposed actions.';
  static synonyms = ['intake review', 'proposal review', 'human approval'];
  static group = {
    id: 'ingestion',
    label: 'Ingestion',
    summary: 'Review incoming material safely before it can change records.',
  };
  static section = {
    id: 'ingestion',
    label: 'Ingestion',
    icon: 'archive',
    description: 'Incoming material and its authenticated review workflow.',
  };
  static models = [
    IntakeItem,
    IntakeEvidence,
    IntakeAnalysis,
    IntakeAction,
    IntakeReviewDecision,
  ];
  static runtime = 'browser' as const;
  static surfaces = [
    {
      kind: 'route',
      path: '/ingestion/review',
      export: '@happyvertical/smrt-ingestion/svelte#IntakeReview',
      label: 'Ingestion review',
    },
  ] as const;
  static nav = [
    {
      label: 'Ingestion review',
      model: IntakeReviewDecision,
      icon: 'fileText',
      description: 'Revision-bound decisions on proposed actions.',
      key: 'review',
      noun: 'review decision',
    },
  ];
}
