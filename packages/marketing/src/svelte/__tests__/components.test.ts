import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import BudgetPacing from '../components/BudgetPacing.svelte';
import CampaignDetail from '../components/CampaignDetail.svelte';
import CampaignList from '../components/CampaignList.svelte';
import ChannelMix from '../components/ChannelMix.svelte';
import MarketingDashboard from '../components/MarketingDashboard.svelte';
import type {
  BudgetPacingView,
  CampaignChannelView,
  CampaignDetailView,
  CampaignSummaryView,
} from '../types.js';

const campaign: CampaignSummaryView = {
  id: 'campaign-1',
  campaignKey: 'summer-launch',
  name: 'Summer launch',
  objective: 'lead_generation',
  status: 'active',
  startAt: '2026-07-01T00:00:00.000Z',
  endAt: '2026-07-31T00:00:00.000Z',
  budgetCents: 10_000,
  currency: 'USD',
  spendCents: 2_500,
  impressions: 4_000,
  clicks: 80,
  conversions: 4,
  leads: 12,
  channelCount: 2,
};

const channels: CampaignChannelView[] = [
  {
    id: 'channel-social',
    channelKind: 'social',
    channelRef: 'social:post-1',
    label: 'Social post',
    status: 'active',
    allocatedBudgetCents: 7_500,
    spendCents: 2_000,
    impressions: 3_000,
    clicks: 60,
    leads: 10,
  },
  {
    id: 'channel-ad',
    channelKind: 'ads',
    channelRef: 'ads:campaign-1',
    label: 'Paid campaign',
    status: 'scheduled',
    allocatedBudgetCents: 2_500,
    spendCents: 500,
    impressions: 1_000,
    clicks: 20,
    leads: 2,
  },
];

describe('marketing Svelte surfaces', () => {
  it('renders dashboard totals from public campaign props', () => {
    render(MarketingDashboard, {
      props: { campaigns: [campaign], locale: 'en-US' },
    });

    expect(screen.getByText('1 active')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('$25.00 spent')).toBeInTheDocument();
    expect(screen.getByText('of $100.00 budget')).toBeInTheDocument();
  });

  it('renders campaign rows and reports selection through its callback', async () => {
    const onSelect = vi.fn();
    render(CampaignList, {
      props: { campaigns: [campaign], locale: 'en-US', onSelect },
    });

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Summer launch')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(onSelect).toHaveBeenCalledWith('campaign-1');
  });

  it('renders campaign details and generic channel references', () => {
    const detail: CampaignDetailView = {
      ...campaign,
      description: 'A cross-channel launch.',
    };
    render(CampaignDetail, {
      props: { campaign: detail, channels, locale: 'en-US' },
    });

    expect(
      screen.getByRole('heading', { name: 'Summer launch' }),
    ).toBeInTheDocument();
    expect(screen.getByText('A cross-channel launch.')).toBeInTheDocument();
    expect(screen.getByText('Social post')).toBeInTheDocument();
    expect(screen.getByText('social:post-1')).toBeInTheDocument();
  });

  it('renders channel mix percentages and cent-based spend', () => {
    render(ChannelMix, {
      props: { channels, currency: 'USD', locale: 'en-US' },
    });

    expect(
      screen.getByRole('heading', { name: 'Channel mix' }),
    ).toBeInTheDocument();
    expect(screen.getByText('$20.00 spent')).toBeInTheDocument();
    expect(screen.getByText('80% of mix')).toBeInTheDocument();
    expect(screen.getByText('$5.00 spent')).toBeInTheDocument();
    expect(screen.getByText('20% of mix')).toBeInTheDocument();
  });

  it('renders budget pacing state and formatted evidence', () => {
    const pacing: BudgetPacingView = {
      campaignId: campaign.id,
      currency: 'USD',
      budgetCents: 10_000,
      spendCents: 4_000,
      remainingCents: 6_000,
      expectedSpendCents: 3_500,
      varianceCents: 500,
      budgetFraction: 0.4,
      elapsedFraction: 0.35,
      status: 'on_track',
    };
    render(BudgetPacing, { props: { pacing, locale: 'en-US' } });

    expect(
      screen.getByRole('heading', { name: 'Budget pacing' }),
    ).toBeInTheDocument();
    expect(screen.getByText('On track')).toBeInTheDocument();
    expect(screen.getByText('$40.00 spent')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByText('$60.00')).toBeInTheDocument();
  });
});
