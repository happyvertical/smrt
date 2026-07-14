export type MarketingBadgeVariant =
  | 'default'
  | 'primary'
  | 'success'
  | 'warning'
  | 'error'
  | 'info';

export type DateLike = Date | string | number | null | undefined;

export interface CampaignSummaryView {
  id: string;
  campaignKey: string;
  name: string;
  objective?: string;
  status: string;
  startAt?: DateLike;
  endAt?: DateLike;
  budgetCents: number;
  currency: string;
  spendCents?: number;
  impressions?: number;
  clicks?: number;
  conversions?: number;
  leads?: number;
  channelCount?: number;
}

export interface CampaignDetailView extends CampaignSummaryView {
  description?: string;
}

export interface CampaignChannelView {
  id: string;
  channelKind: string;
  channelRef: string;
  label?: string;
  status: string;
  allocatedBudgetCents: number;
  spendCents: number;
  impressions?: number;
  clicks?: number;
  conversions?: number;
  leads?: number;
}

export interface BudgetPacingView {
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
  status: string;
}

export interface CurrencyMarketingTotal {
  currency: string;
  budgetCents: number;
  spendCents: number;
}

export interface MarketingDashboardSummary {
  campaignCount: number;
  activeCampaignCount: number;
  channelCount: number;
  impressions: number;
  clicks: number;
  conversions: number;
  leads: number;
  currencyTotals: CurrencyMarketingTotal[];
}

export interface ChannelMixEntry extends CampaignChannelView {
  spendFraction: number;
  allocationFraction: number;
}

export function campaignStatusBadgeVariant(
  status: string,
): MarketingBadgeVariant {
  switch (status) {
    case 'active':
      return 'success';
    case 'scheduled':
      return 'info';
    case 'paused':
      return 'warning';
    case 'completed':
      return 'primary';
    case 'archived':
      return 'default';
    default:
      return 'default';
  }
}

export function pacingStatusBadgeVariant(
  status: string,
): MarketingBadgeVariant {
  switch (status) {
    case 'on_track':
    case 'complete':
      return 'success';
    case 'ahead':
      return 'info';
    case 'behind':
    case 'not_started':
      return 'warning';
    case 'over_budget':
      return 'error';
    default:
      return 'default';
  }
}

export function summarizeMarketingDashboard(
  campaigns: CampaignSummaryView[],
): MarketingDashboardSummary {
  const byCurrency = new Map<string, CurrencyMarketingTotal>();
  let channelCount = 0;
  let impressions = 0;
  let clicks = 0;
  let conversions = 0;
  let leads = 0;

  for (const campaign of campaigns) {
    const currency = campaign.currency || 'USD';
    const total = byCurrency.get(currency) ?? {
      currency,
      budgetCents: 0,
      spendCents: 0,
    };
    total.budgetCents += campaign.budgetCents;
    total.spendCents += campaign.spendCents ?? 0;
    byCurrency.set(currency, total);
    channelCount += campaign.channelCount ?? 0;
    impressions += campaign.impressions ?? 0;
    clicks += campaign.clicks ?? 0;
    conversions += campaign.conversions ?? 0;
    leads += campaign.leads ?? 0;
  }

  return {
    campaignCount: campaigns.length,
    activeCampaignCount: campaigns.filter(
      (campaign) => campaign.status === 'active',
    ).length,
    channelCount,
    impressions,
    clicks,
    conversions,
    leads,
    currencyTotals: [...byCurrency.values()].sort((a, b) =>
      a.currency.localeCompare(b.currency),
    ),
  };
}

export function calculateChannelMix(
  channels: CampaignChannelView[],
): ChannelMixEntry[] {
  const totalSpend = channels.reduce(
    (sum, channel) => sum + channel.spendCents,
    0,
  );
  const totalAllocation = channels.reduce(
    (sum, channel) => sum + channel.allocatedBudgetCents,
    0,
  );
  return channels.map((channel) => ({
    ...channel,
    spendFraction: totalSpend > 0 ? channel.spendCents / totalSpend : 0,
    allocationFraction:
      totalAllocation > 0 ? channel.allocatedBudgetCents / totalAllocation : 0,
  }));
}

export function cappedBudgetProgress(pacing: BudgetPacingView): number {
  if (pacing.budgetFraction === null) return 0;
  return Math.max(0, Math.min(1, pacing.budgetFraction));
}
