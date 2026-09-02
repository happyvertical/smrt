<script lang="ts">
import { Card } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import { formatCents, formatNumber } from '../format.js';
import type { CampaignSummaryView } from '../types.js';
import { summarizeMarketingDashboard } from '../types.js';

export interface Props {
  /** Campaigns to summarize in dashboard tiles. */
  campaigns?: CampaignSummaryView[];
  /** Locale for formatting currency and numbers. */
  locale?: string;
  /** Snippet to render the campaign list. */
  campaignList?: Snippet;
  /** Snippet to render the campaign detail. */
  detail?: Snippet;
  children?: Snippet;
}

let {
  campaigns = [],
  locale,
  campaignList,
  detail,
  children,
}: Props = $props();

const summary = $derived(summarizeMarketingDashboard(campaigns));
</script>

<section class="marketing-dashboard">
  <div class="tiles">
    <Card padding="sm">
      <dl class="tile">
        <dt>Campaigns</dt>
        <dd>{summary.activeCampaignCount} active</dd>
        <dd class="secondary">{summary.campaignCount} total</dd>
      </dl>
    </Card>
    <Card padding="sm">
      <dl class="tile">
        <dt>Channels</dt>
        <dd>{summary.channelCount}</dd>
        <dd class="secondary">linked executions</dd>
      </dl>
    </Card>
    <Card padding="sm">
      <dl class="tile">
        <dt>Leads</dt>
        <dd>{formatNumber(summary.leads, locale)}</dd>
        <dd class="secondary">{formatNumber(summary.conversions, locale)} conversions</dd>
      </dl>
    </Card>
    <Card padding="sm">
      <dl class="tile">
        <dt>Reach</dt>
        <dd>{formatNumber(summary.impressions, locale)}</dd>
        <dd class="secondary">{formatNumber(summary.clicks, locale)} clicks</dd>
      </dl>
    </Card>
  </div>

  {#if summary.currencyTotals.length > 0}
    <Card padding="sm">
      <div class="currency-totals">
        {#each summary.currencyTotals as total (total.currency)}
          <dl class="currency-total">
            <dt>{total.currency}</dt>
            <dd>{formatCents(total.spendCents, total.currency, locale)} spent</dd>
            <dd class="secondary">
              of {formatCents(total.budgetCents, total.currency, locale)} budget
            </dd>
          </dl>
        {/each}
      </div>
    </Card>
  {/if}

  {#if campaignList}
    <div class="surface">{@render campaignList()}</div>
  {/if}
  {#if detail}
    <div class="surface">{@render detail()}</div>
  {/if}
  {@render children?.()}
</section>

<style>
  .marketing-dashboard {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4);
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--smrt-spacing-3);
  }

  .tile,
  .currency-total {
    margin: 0;
  }

  dt {
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-label-medium-font);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking);
  }

  dd {
    margin: var(--smrt-spacing-1) 0 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-medium-font);
  }

  .secondary {
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-body-small-font);
  }

  .currency-totals {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: var(--smrt-spacing-4);
  }

  .surface {
    min-width: 0;
  }
</style>
