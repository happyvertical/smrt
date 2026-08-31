/** Shared model and service contracts for @happyvertical/smrt-marketing. */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import type { Campaign } from './models/Campaign.js';

export const CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'active',
  'paused',
  'completed',
  'archived',
] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_CHANNEL_KINDS = [
  'ad_group',
  'social_post',
  'message',
  'content',
  'event',
  'referral_program',
] as const;

export type CampaignChannelKind =
  | (typeof CAMPAIGN_CHANNEL_KINDS)[number]
  | (string & {});

export const CAMPAIGN_CHANNEL_STATUSES = [
  'planned',
  'scheduled',
  'active',
  'paused',
  'completed',
  'cancelled',
] as const;

export type CampaignChannelStatus = (typeof CAMPAIGN_CHANNEL_STATUSES)[number];

export interface CampaignOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  customerId?: string | null;
  campaignKey?: string;
  name?: string;
  objective?: string;
  status?: CampaignStatus;
  startAt?: Date | string | number | null;
  endAt?: Date | string | number | null;
  budgetCents?: number;
  currency?: string;
  metadata?: string;
}

export interface CampaignCustomerCursorInput {
  startAt: Date | string | number | null;
  id: string;
}

export interface CampaignCustomerCursor {
  startAt: Date | null;
  id: string;
}

export interface ListCampaignsByCustomerOptions {
  limit?: number;
  after?: CampaignCustomerCursorInput;
}

export interface CampaignCustomerPage {
  items: Campaign[];
  nextCursor: CampaignCustomerCursor | null;
}

export interface ListCampaignReportingByCustomerOptions
  extends ListCampaignsByCustomerOptions {
  /** Clock used for deterministic pacing calculations. Defaults to now. */
  at?: Date | string | number;
}

export interface CampaignChannelMixEntry {
  channelKind: CampaignChannelKind;
  count: number;
}

/** Totals from the immutable evidence selected by campaign pacing rules. */
export interface CampaignMetricTotals {
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
  leads: number;
  revenueCents: number;
}

export interface CampaignReportingItem {
  campaign: Campaign;
  channelCount: number;
  channelMix: CampaignChannelMixEntry[];
  metricTotals: CampaignMetricTotals;
  pacing: BudgetPacingResult;
}

export interface CampaignReportingPage {
  items: CampaignReportingItem[];
  nextCursor: CampaignCustomerCursor | null;
}

export interface CampaignCustomerSummary {
  customerId: string;
  totalCount: number;
  activeCount: number;
  latestStartAt: Date | null;
}

export interface CampaignChannelOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  campaignId?: string;
  channelKind?: CampaignChannelKind;
  channelRef?: string;
  allocatedBudgetCents?: number;
  startAt?: Date | string | number | null;
  endAt?: Date | string | number | null;
  status?: CampaignChannelStatus;
}

export interface CampaignMetricSnapshotOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  campaignId?: string;
  campaignChannelId?: string | null;
  periodStart?: Date | string | number;
  periodEnd?: Date | string | number;
  spendCents?: number;
  impressions?: number;
  clicks?: number;
  conversions?: number;
  leads?: number;
  revenueCents?: number | null;
  source?: string;
  dedupeKey?: string;
}

export type BudgetPacingStatus =
  | 'unbudgeted'
  | 'not_started'
  | 'behind'
  | 'on_track'
  | 'ahead'
  | 'over_budget'
  | 'complete';

export interface BudgetPacingResult {
  campaignId: string;
  campaignChannelId?: string;
  currency: string;
  budgetCents: number;
  spendCents: number;
  remainingCents: number;
  expectedSpendCents: number | null;
  varianceCents: number | null;
  budgetFraction: number | null;
  elapsedFraction: number | null;
  status: BudgetPacingStatus;
  snapshotCount: number;
  usedCampaignRollups: boolean;
}
