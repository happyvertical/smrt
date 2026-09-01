<script lang="ts">
import { Progress } from '@happyvertical/smrt-ui/feedback';
import { Badge, Card } from '@happyvertical/smrt-ui/ui';
import {
  formatCents,
  formatNumber,
  formatPercent,
  humanizeKey,
} from '../format.js';
import type { CampaignChannelView } from '../types.js';
import { calculateChannelMix, campaignStatusBadgeVariant } from '../types.js';

export interface Props {
  /** Campaign channels to display. */
  channels?: CampaignChannelView[];
  /** Currency code for formatting spending. */
  currency?: string;
  /** Locale for formatting currency, numbers, and percentages. */
  locale?: string;
}

let { channels = [], currency = 'USD', locale }: Props = $props();
const mix = $derived(calculateChannelMix(channels));
</script>

<section class="channel-mix">
  <h3>Channel mix</h3>
  {#if mix.length === 0}
    <p class="empty">No channel performance yet.</p>
  {:else}
    <div class="rows">
      {#each mix as channel (channel.id)}
        <Card padding="sm">
          <div class="head">
            <div>
              <span class="name">{channel.label ?? humanizeKey(channel.channelKind)}</span>
              <span class="secondary">{channel.channelRef}</span>
            </div>
            <Badge variant={campaignStatusBadgeVariant(channel.status)} size="sm">
              {humanizeKey(channel.status)}
            </Badge>
          </div>
          <div class="progress-label">
            <span>{formatCents(channel.spendCents, currency, locale)} spent</span>
            <span>{formatPercent(channel.spendFraction, locale)} of mix</span>
          </div>
          <Progress
            value={channel.spendFraction}
            max={1}
            label={`${channel.label ?? channel.channelKind} spend share`}
          />
          <dl class="metrics">
            <div><dt>Allocation</dt><dd>{formatCents(channel.allocatedBudgetCents, currency, locale)}</dd></div>
            <div><dt>Impressions</dt><dd>{formatNumber(channel.impressions ?? 0, locale)}</dd></div>
            <div><dt>Clicks</dt><dd>{formatNumber(channel.clicks ?? 0, locale)}</dd></div>
            <div><dt>Leads</dt><dd>{formatNumber(channel.leads ?? 0, locale)}</dd></div>
          </dl>
        </Card>
      {/each}
    </div>
  {/if}
</section>

<style>
  .channel-mix,
  .rows {
    display: flex;
    flex-direction: column;
  }

  .channel-mix {
    gap: var(--smrt-spacing-3);
  }

  .rows {
    gap: var(--smrt-spacing-2);
  }

  h3,
  .empty {
    margin: 0;
  }

  h3 {
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-medium-font);
  }

  .empty,
  .secondary,
  dt,
  .progress-label {
    color: var(--smrt-color-on-surface-variant);
  }

  .empty,
  .name {
    font: var(--smrt-typography-body-medium-font);
  }

  .head,
  .progress-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
  }

  .name,
  .secondary {
    display: block;
  }

  .name {
    color: var(--smrt-color-on-surface);
    font-weight: var(--smrt-typography-weight-medium);
  }

  .secondary,
  .progress-label,
  dt {
    font: var(--smrt-typography-body-small-font);
  }

  .progress-label {
    margin: var(--smrt-spacing-3) 0 var(--smrt-spacing-1);
  }

  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
    gap: var(--smrt-spacing-3);
    margin: var(--smrt-spacing-3) 0 0;
  }

  .metrics dd {
    margin: var(--smrt-spacing-1) 0 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-body-medium-font);
  }
</style>
