/**
 * Declared recipes for smrt-sales (#3590, #3604): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Lead } from './models/Lead.js';
import { Opportunity } from './models/Opportunity.js';
import { PipelineDefinition } from './models/PipelineDefinition.js';
import { PipelineStage } from './models/PipelineStage.js';
import { SalesActivity } from './models/SalesActivity.js';

/** Leads & pipeline: Capture leads and move them through your sales stages. */
export class SalesPipelineRecipe extends SmrtRecipe {
  static id = 'sales.pipeline';
  static help = './pipeline.recipe.md';
  static label = 'Leads & pipeline';
  static summary = 'Capture leads and move them through your sales stages.';
  static synonyms = ['crm', 'prospects', 'opportunities', 'deals', 'funnel'];
  static section = {
    id: 'sales',
    label: 'Sales',
    icon: 'shoppingBag',
    description: 'Customers, orders and quotes: everything you sell.',
  };
  static models = [
    Lead,
    Opportunity,
    PipelineDefinition,
    PipelineStage,
    SalesActivity,
  ];
  static nav = [
    {
      label: 'Leads',
      model: Lead,
      icon: 'users',
      description:
        'People who might become customers, and where each one stands.',
    },
    {
      label: 'Opportunities',
      model: Opportunity,
      icon: 'briefcase',
      description: 'Deals in progress, with their value and next step.',
    },
    {
      label: 'Pipelines',
      model: PipelineDefinition,
      icon: 'layers',
      description: 'The stages a deal moves through on its way to a sale.',
    },
  ];
  static options = {
    Lead: {
      fields: {
        profileId: { visibility: 'hidden' },
        mergedIntoId: { visibility: 'hidden' },
        sourceKind: { visibility: 'hidden' },
        sourceId: { visibility: 'hidden' },
        acquisitionContext: { visibility: 'hidden' },
        intakeRef: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
        qualifiedAt: { visibility: 'hidden' },
      },
    },
    Opportunity: {
      fields: {
        sourceKind: { visibility: 'hidden' },
        sourceId: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
        outcomeReason: { visibility: 'hidden' },
        wonAt: { visibility: 'hidden' },
        lostAt: { visibility: 'hidden' },
      },
    },
    PipelineStage: { fields: { metadata: { visibility: 'hidden' } } },
    SalesActivity: {
      fields: {
        metadata: { visibility: 'hidden' },
        actorProfileId: { visibility: 'hidden' },
      },
    },
  } as const;
}
