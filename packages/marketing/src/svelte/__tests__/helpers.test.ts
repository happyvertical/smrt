import { describe, expect, it } from 'vitest';
import {
  calculateChannelMix,
  campaignStatusBadgeVariant,
  cappedBudgetProgress,
  pacingStatusBadgeVariant,
  summarizeMarketingDashboard,
} from '../types.js';

describe('marketing Svelte helpers', () => {
  it('summarizes campaign metrics without mixing currencies', () => {
    const summary = summarizeMarketingDashboard([
      {
        id: 'campaign-1',
        campaignKey: 'one',
        name: 'One',
        status: 'active',
        budgetCents: 100_000,
        spendCents: 40_000,
        currency: 'CAD',
        channelCount: 2,
        impressions: 10_000,
        clicks: 500,
        conversions: 20,
        leads: 12,
      },
      {
        id: 'campaign-2',
        campaignKey: 'two',
        name: 'Two',
        status: 'completed',
        budgetCents: 50_000,
        spendCents: 45_000,
        currency: 'CAD',
        channelCount: 1,
        leads: 5,
      },
      {
        id: 'campaign-3',
        campaignKey: 'three',
        name: 'Three',
        status: 'draft',
        budgetCents: 80_000,
        spendCents: 0,
        currency: 'USD',
      },
    ]);

    expect(summary.activeCampaignCount).toBe(1);
    expect(summary.channelCount).toBe(3);
    expect(summary.leads).toBe(17);
    expect(summary.currencyTotals).toEqual([
      { currency: 'CAD', budgetCents: 150_000, spendCents: 85_000 },
      { currency: 'USD', budgetCents: 80_000, spendCents: 0 },
    ]);
  });

  it('calculates channel spend and allocation fractions independently', () => {
    const mix = calculateChannelMix([
      {
        id: 'ads',
        channelKind: 'ad_group',
        channelRef: 'ag-1',
        status: 'active',
        allocatedBudgetCents: 75_000,
        spendCents: 30_000,
      },
      {
        id: 'social',
        channelKind: 'social_post',
        channelRef: 'post-1',
        status: 'active',
        allocatedBudgetCents: 25_000,
        spendCents: 10_000,
      },
    ]);
    expect(mix[0]?.spendFraction).toBe(0.75);
    expect(mix[0]?.allocationFraction).toBe(0.75);
    expect(mix[1]?.spendFraction).toBe(0.25);
  });

  it('caps visual progress while preserving status semantics', () => {
    expect(
      cappedBudgetProgress({
        campaignId: 'campaign-1',
        currency: 'CAD',
        budgetCents: 100,
        spendCents: 125,
        remainingCents: -25,
        expectedSpendCents: 50,
        varianceCents: 75,
        budgetFraction: 1.25,
        elapsedFraction: 0.5,
        status: 'over_budget',
      }),
    ).toBe(1);
    expect(pacingStatusBadgeVariant('over_budget')).toBe('error');
    expect(pacingStatusBadgeVariant('on_track')).toBe('success');
    expect(campaignStatusBadgeVariant('paused')).toBe('warning');
  });
});
