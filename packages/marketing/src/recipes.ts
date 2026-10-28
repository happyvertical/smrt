/**
 * Declared recipes for smrt-marketing (#4409, #4437): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Campaign } from './models/Campaign.js';
import { CampaignChannel } from './models/CampaignChannel.js';
import { CampaignMetricSnapshot } from './models/CampaignMetricSnapshot.js';

/** Campaigns: Plan a campaign, choose where it runs and see what it brought in. */
export class MarketingCampaignsRecipe extends SmrtRecipe {
  static id = 'marketing.campaigns';
  static help = './campaigns.recipe.md';
  static label = 'Campaigns';
  static summary =
    'Plan a marketing campaign, set its budget and dates, choose where it runs and see what it brought in.';
  static synonyms = [
    'marketing',
    'marketing campaigns',
    'promotions',
    'advertising',
    'ad campaigns',
    'campaign results',
  ];
  static section = {
    id: 'grow',
    label: 'Grow',
    icon: 'tag',
    description: 'Bring in new customers and reward the people who help.',
  };
  static models = [Campaign, CampaignChannel, CampaignMetricSnapshot];
  static nav = [
    {
      label: 'Campaigns',
      model: Campaign,
      icon: 'tag',
      description:
        'Every campaign, with its budget, dates and where it stands.',
      noun: 'campaign',
    },
    {
      label: 'Channels',
      model: CampaignChannel,
      icon: 'layers',
      description:
        'Where each campaign runs, such as an ad group or a social post, and its share of the budget.',
      noun: 'channel',
    },
    {
      label: 'Results',
      model: CampaignMetricSnapshot,
      icon: 'fileText',
      description:
        'What each campaign and channel brought in, period by period, as reported by the channels.',
      noun: 'result',
    },
  ];
  static options = {
    Campaign: {
      fields: {
        name: { order: 1 },
        objective: { order: 2 },
        status: { order: 3 },
        startAt: { label: 'Starts', order: 4 },
        endAt: { label: 'Ends', order: 5 },
        budgetCents: { label: 'Budget (cents)', order: 6 },
        currency: { order: 7 },
        customerId: { label: 'Customer', visibility: 'advanced' },
        campaignKey: { label: 'Reference', visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
      },
    },
    CampaignChannel: {
      fields: {
        campaignId: { label: 'Campaign', order: 1 },
        channelKind: { label: 'Kind', order: 2 },
        channelRef: { label: 'Name', order: 3 },
        allocatedBudgetCents: { label: 'Budget share (cents)', order: 4 },
        status: { order: 5 },
        startAt: { label: 'Starts', order: 6 },
        endAt: { label: 'Ends', order: 7 },
        tenantId: { visibility: 'hidden' },
      },
    },
    CampaignMetricSnapshot: {
      fields: {
        campaignId: { label: 'Campaign', order: 1 },
        campaignChannelId: { label: 'Channel', order: 2 },
        periodStart: { label: 'From', order: 3 },
        periodEnd: { label: 'To', order: 4 },
        spendCents: { label: 'Spend (cents)', order: 5 },
        impressions: { order: 6 },
        clicks: { order: 7 },
        conversions: { order: 8 },
        leads: { order: 9 },
        revenueCents: { label: 'Revenue (cents)', order: 10 },
        source: { order: 11 },
        tenantId: { visibility: 'hidden' },
        dedupeKey: { visibility: 'hidden' },
      },
    },
  } as const;
}
