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

<section class="smrt-channel-mix__root" data-smrt-component="ChannelMix">
  <h3>Channel mix</h3>
  {#if mix.length === 0}
    <p class="smrt-channel-mix__empty" data-smrt-part="empty">No channel performance yet.</p>
  {:else}
    <div class="smrt-channel-mix__rows" data-smrt-part="list">
      {#each mix as channel (channel.id)}
        <Card padding="sm">
          <div class="smrt-channel-mix__head" data-smrt-part="header">
            <div>
              <span class="smrt-channel-mix__name">{channel.label ?? humanizeKey(channel.channelKind)}</span>
              <span class="smrt-channel-mix__secondary">{channel.channelRef}</span>
            </div>
            <Badge variant={campaignStatusBadgeVariant(channel.status)} size="sm">
              {humanizeKey(channel.status)}
            </Badge>
          </div>
          <div class="smrt-channel-mix__progress-label" data-smrt-part="label">
            <span>{formatCents(channel.spendCents, currency, locale)} spent</span>
            <span>{formatPercent(channel.spendFraction, locale)} of mix</span>
          </div>
          <Progress
            value={channel.spendFraction}
            max={1}
            label={`${channel.label ?? channel.channelKind} spend share`}
          />
          <dl class="smrt-channel-mix__metrics" data-smrt-part="metrics">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {

.smrt-channel-mix__root,
  .smrt-channel-mix__rows {
display: flex;
flex-direction: column;

}
.smrt-channel-mix__root {
gap: var(--smrt-spacing-3);

}
.smrt-channel-mix__rows {
gap: var(--smrt-spacing-2);

}
h3,
  .smrt-channel-mix__empty {
margin: 0;

}
.smrt-channel-mix__head,
  .smrt-channel-mix__progress-label {
display: flex;
align-items: center;
justify-content: space-between;
gap: var(--smrt-spacing-3);

}
.smrt-channel-mix__name,
  .smrt-channel-mix__secondary {
display: block;

}
.smrt-channel-mix__progress-label {
margin: var(--smrt-spacing-3) 0 var(--smrt-spacing-1);

}
.smrt-channel-mix__metrics {
display: grid;
grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
gap: var(--smrt-spacing-3);
margin: var(--smrt-spacing-3) 0 0;

}
.smrt-channel-mix__metrics dd {
margin: var(--smrt-spacing-1) 0 0;

}

}
@layer smrt.theme {

h3 {
color: var(--smrt-color-on-surface);
font: var(--smrt-typography-title-medium-font);

}
.smrt-channel-mix__empty,
  .smrt-channel-mix__secondary,
  dt,
  .smrt-channel-mix__progress-label {
color: var(--smrt-color-on-surface-variant);

}
.smrt-channel-mix__empty,
  .smrt-channel-mix__name {
font: var(--smrt-typography-body-medium-font);

}
.smrt-channel-mix__name {
color: var(--smrt-color-on-surface);
font-weight: var(--smrt-typography-weight-medium);

}
.smrt-channel-mix__secondary,
  .smrt-channel-mix__progress-label,
  dt {
font: var(--smrt-typography-body-small-font);

}
.smrt-channel-mix__metrics dd {
color: var(--smrt-color-on-surface);
font: var(--smrt-typography-body-medium-font);

}

}

</style>
