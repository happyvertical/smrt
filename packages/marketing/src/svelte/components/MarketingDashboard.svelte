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

<section class="smrt-marketing-dashboard__root" data-smrt-component="MarketingDashboard">
  <div class="smrt-marketing-dashboard__tiles" data-smrt-part="list">
    <Card padding="sm">
      <dl class="smrt-marketing-dashboard__tile" data-smrt-part="tile">
        <dt>Campaigns</dt>
        <dd>{summary.activeCampaignCount} active</dd>
        <dd class="smrt-marketing-dashboard__secondary">{summary.campaignCount} total</dd>
      </dl>
    </Card>
    <Card padding="sm">
      <dl class="smrt-marketing-dashboard__tile" data-smrt-part="tile">
        <dt>Channels</dt>
        <dd>{summary.channelCount}</dd>
        <dd class="smrt-marketing-dashboard__secondary">linked executions</dd>
      </dl>
    </Card>
    <Card padding="sm">
      <dl class="smrt-marketing-dashboard__tile" data-smrt-part="tile">
        <dt>Leads</dt>
        <dd>{formatNumber(summary.leads, locale)}</dd>
        <dd class="smrt-marketing-dashboard__secondary">{formatNumber(summary.conversions, locale)} conversions</dd>
      </dl>
    </Card>
    <Card padding="sm">
      <dl class="smrt-marketing-dashboard__tile" data-smrt-part="tile">
        <dt>Reach</dt>
        <dd>{formatNumber(summary.impressions, locale)}</dd>
        <dd class="smrt-marketing-dashboard__secondary">{formatNumber(summary.clicks, locale)} clicks</dd>
      </dl>
    </Card>
  </div>

  {#if summary.currencyTotals.length > 0}
    <Card padding="sm">
      <div class="smrt-marketing-dashboard__currency-totals" data-smrt-part="currency">
        {#each summary.currencyTotals as total (total.currency)}
          <dl class="smrt-marketing-dashboard__currency-total">
            <dt>{total.currency}</dt>
            <dd>{formatCents(total.spendCents, total.currency, locale)} spent</dd>
            <dd class="smrt-marketing-dashboard__secondary">
              of {formatCents(total.budgetCents, total.currency, locale)} budget
            </dd>
          </dl>
        {/each}
      </div>
    </Card>
  {/if}

  {#if campaignList}
    <div class="smrt-marketing-dashboard__surface" data-smrt-part="body">{@render campaignList()}</div>
  {/if}
  {#if detail}
    <div class="smrt-marketing-dashboard__surface" data-smrt-part="body">{@render detail()}</div>
  {/if}
  {@render children?.()}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {

.smrt-marketing-dashboard__root {
display: flex;
flex-direction: column;
gap: var(--smrt-spacing-4);

}
.smrt-marketing-dashboard__tiles {
display: grid;
grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
gap: var(--smrt-spacing-3);

}
.smrt-marketing-dashboard__tile,
  .smrt-marketing-dashboard__currency-total {
margin: 0;

}
dd {
margin: var(--smrt-spacing-1) 0 0;

}
.smrt-marketing-dashboard__currency-totals {
display: grid;
grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
gap: var(--smrt-spacing-4);

}
.smrt-marketing-dashboard__surface {
min-width: 0;

}

}
@layer smrt.theme {

dt {
color: var(--smrt-color-on-surface-variant);
font: var(--smrt-typography-label-medium-font);
text-transform: uppercase;
letter-spacing: var(--smrt-typography-label-medium-tracking);

}
dd {
color: var(--smrt-color-on-surface);
font: var(--smrt-typography-title-medium-font);

}
.smrt-marketing-dashboard__secondary {
color: var(--smrt-color-on-surface-variant);
font: var(--smrt-typography-body-small-font);

}

}

</style>
