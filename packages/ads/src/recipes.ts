/**
 * Declared recipes for smrt-ads (#4409, #4437): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { AdDeliveryTier } from './models/AdDeliveryTier.js';
import { AdFormat } from './models/AdFormat.js';
import { AdGroup } from './models/AdGroup.js';
import { AdVariation } from './models/AdVariation.js';

/**
 * Ads: run ad campaigns on your site and see which ads get clicked.
 *
 * `AdEvent` is left out on purpose: it is the append-only record of every
 * showing and click the app writes while serving ads (create and list only,
 * no CLI, high volume). Nobody opens it as a list; the counts a person reads
 * live on the ad itself (`AdVariation.impressions` / `clicks`).
 */
export class AdsCampaignsRecipe extends SmrtRecipe {
  static id = 'ads.campaigns';
  static help = './campaigns.recipe.md';
  static label = 'Ads';
  static summary =
    'Run ad campaigns on your site, choose which ads show where, and see which ones get clicked.';
  static synonyms = [
    'ads',
    'advertising',
    'ad campaigns',
    'banner ads',
    'advertisements',
    'display ads',
  ];
  static section = {
    id: 'grow',
    label: 'Grow',
    icon: 'tag',
    description: 'Bring in new customers and reward the people who help.',
  };
  static models = [AdGroup, AdVariation, AdFormat, AdDeliveryTier];
  static nav = [
    {
      label: 'Ad campaigns',
      model: AdGroup,
      icon: 'tag',
      description:
        'Each campaign you run, with its dates, budget and where it stands.',
      noun: 'ad campaign',
    },
    {
      label: 'Ads',
      model: AdVariation,
      icon: 'eye',
      description:
        'The ads inside each campaign, how often each shows and how many clicks it got.',
      noun: 'ad',
    },
    {
      label: 'Ad sizes',
      model: AdFormat,
      icon: 'layers',
      description:
        'The shapes and sizes an ad can be, shared by every campaign.',
      noun: 'ad size',
    },
    {
      label: 'Priority tiers',
      model: AdDeliveryTier,
      icon: 'settings',
      description:
        'The order campaigns are tried in when more than one could show.',
      noun: 'tier',
    },
  ];
  static options = {
    AdGroup: {
      fields: {
        name: { order: 1 },
        status: { order: 2 },
        tierId: { label: 'Priority tier', order: 3 },
        startDate: { label: 'Starts on', order: 4 },
        endDate: { label: 'Ends on', order: 5 },
        dailyBudget: { label: 'Daily budget', order: 6 },
        totalBudget: { label: 'Total budget', order: 7 },
        tenantId: { visibility: 'hidden' },
        contractId: { label: 'Sales contract', visibility: 'advanced' },
        verticalSlug: { label: 'Category', visibility: 'advanced' },
        targeting: { visibility: 'hidden' },
        zoneIds: { visibility: 'hidden' },
      },
    },
    AdVariation: {
      fields: {
        name: { order: 1 },
        groupId: { label: 'Ad campaign', order: 2 },
        formatId: { label: 'Ad size', order: 3 },
        assetId: { label: 'Picture', order: 4 },
        clickUrl: { label: 'Link to', order: 5 },
        altText: { label: 'Words for the picture', order: 6 },
        weight: { order: 7 },
        status: { order: 8 },
        tenantId: { visibility: 'hidden' },
        impressions: {
          label: 'Times shown',
          locked: true,
          visibility: 'advanced',
        },
        clicks: { locked: true, visibility: 'advanced' },
      },
    },
    AdFormat: {
      fields: {
        name: { order: 1 },
        width: { order: 2 },
        height: { order: 3 },
        formatType: { label: 'Kind', order: 4 },
        description: { order: 5 },
      },
    },
    AdDeliveryTier: {
      fields: {
        name: { order: 1 },
        priority: { order: 2 },
        pricingModel: { label: 'How it is charged', order: 3 },
        description: { order: 4 },
      },
    },
  } as const;
}
