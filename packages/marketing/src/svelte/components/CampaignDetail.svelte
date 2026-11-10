<script lang="ts">
import { Badge, Card } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import {
  formatCents,
  formatDateRange,
  formatNumber,
  humanizeKey,
} from '../format.js';
import type { CampaignChannelView, CampaignDetailView } from '../types.js';
import { campaignStatusBadgeVariant } from '../types.js';

export interface Props {
  /** Campaign to display. */
  campaign?: CampaignDetailView | null;
  /** Campaign channel executions. */
  channels?: CampaignChannelView[];
  /** Locale for formatting currency, dates, and numbers. */
  locale?: string;
  /** Snippet to render the budget pacing section. */
  pacing?: Snippet;
  /** Snippet to render the channel mix section. */
  channelMix?: Snippet;
  children?: Snippet;
}

let {
  campaign = null,
  channels = [],
  locale,
  pacing,
  channelMix,
  children,
}: Props = $props();
</script>

{#if !campaign}
  <p class="smrt-campaign-detail__empty" data-smrt-component="CampaignDetail" data-smrt-part="empty">Select a campaign to see its details.</p>
{:else}
  <article class="smrt-campaign-detail__root" data-smrt-component="CampaignDetail">
    <Card variant="outlined">
      <header class="smrt-campaign-detail__header" data-smrt-part="header">
        <div>
          <p class="smrt-campaign-detail__eyebrow">{campaign.campaignKey}</p>
          <h2 data-smrt-part="title">{campaign.name}</h2>
          {#if campaign.description}<p class="smrt-campaign-detail__description" data-smrt-part="description">{campaign.description}</p>{/if}
        </div>
        <Badge variant={campaignStatusBadgeVariant(campaign.status)}>
          {humanizeKey(campaign.status)}
        </Badge>
      </header>

      <dl class="smrt-campaign-detail__facts" data-smrt-part="facts">
        <div>
          <dt>Objective</dt>
          <dd>{campaign.objective ? humanizeKey(campaign.objective) : '—'}</dd>
        </div>
        <div>
          <dt>Schedule</dt>
          <dd>{formatDateRange(campaign.startAt, campaign.endAt, locale)}</dd>
        </div>
        <div>
          <dt>Budget</dt>
          <dd>{formatCents(campaign.budgetCents, campaign.currency, locale)}</dd>
        </div>
        <div>
          <dt>Spend</dt>
          <dd>{formatCents(campaign.spendCents ?? 0, campaign.currency, locale)}</dd>
        </div>
        <div>
          <dt>Impressions</dt>
          <dd>{formatNumber(campaign.impressions ?? 0, locale)}</dd>
        </div>
        <div>
          <dt>Leads</dt>
          <dd>{formatNumber(campaign.leads ?? 0, locale)}</dd>
        </div>
      </dl>
    </Card>

    {#if channels.length > 0}
      <Card padding="sm">
        <section class="smrt-campaign-detail__channels" data-smrt-part="channels" aria-label="Campaign channels">
          <h3>Executions</h3>
          <ul>
            {#each channels as channel (channel.id)}
              <li data-smrt-part="row">
                <span>
                  <span class="smrt-campaign-detail__channel-name">{channel.label ?? humanizeKey(channel.channelKind)}</span>
                  <span class="smrt-campaign-detail__channel-ref">{channel.channelRef}</span>
                </span>
                <Badge variant={campaignStatusBadgeVariant(channel.status)} size="sm">
                  {humanizeKey(channel.status)}
                </Badge>
              </li>
            {/each}
          </ul>
        </section>
      </Card>
    {/if}

    {#if pacing}<section aria-label="Budget pacing">{@render pacing()}</section>{/if}
    {#if channelMix}<section aria-label="Channel mix">{@render channelMix()}</section>{/if}
    {@render children?.()}
  </article>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {

.smrt-campaign-detail__root {
display: flex;
flex-direction: column;
gap: var(--smrt-spacing-4);

}
.smrt-campaign-detail__empty,
  .smrt-campaign-detail__description {
margin: 0;

}
.smrt-campaign-detail__header {
display: flex;
align-items: flex-start;
justify-content: space-between;
gap: var(--smrt-spacing-4);

}
.smrt-campaign-detail__eyebrow {
margin: 0;

}
h2,
  h3 {
margin: 0;

}
.smrt-campaign-detail__description {
margin-top: var(--smrt-spacing-2);

}
.smrt-campaign-detail__facts {
display: grid;
grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
gap: var(--smrt-spacing-4);
margin: var(--smrt-spacing-5) 0 0;

}
.smrt-campaign-detail__facts dd {
margin: var(--smrt-spacing-1) 0 0;

}
.smrt-campaign-detail__channels h3 {
margin-bottom: var(--smrt-spacing-3);

}
ul {
display: flex;
flex-direction: column;
gap: var(--smrt-spacing-2);
margin: 0;
padding: 0;
list-style: none;

}
li {
display: flex;
align-items: center;
justify-content: space-between;
gap: var(--smrt-spacing-3);
padding-bottom: var(--smrt-spacing-2);

}
.smrt-campaign-detail__channel-name,
  .smrt-campaign-detail__channel-ref {
display: block;

}

}
@layer smrt.theme {

.smrt-campaign-detail__empty,
  .smrt-campaign-detail__description,
  .smrt-campaign-detail__channel-ref {
color: var(--smrt-color-on-surface-variant);

}
.smrt-campaign-detail__empty,
  .smrt-campaign-detail__description {
font: var(--smrt-typography-body-medium-font);

}
.smrt-campaign-detail__eyebrow {
color: var(--smrt-color-on-surface-variant);
font: var(--smrt-typography-label-medium-font);

}
h2,
  h3 {
color: var(--smrt-color-on-surface);

}
h2 {
font: var(--smrt-typography-headline-small-font);

}
h3 {
font: var(--smrt-typography-title-medium-font);

}
.smrt-campaign-detail__facts dt {
color: var(--smrt-color-on-surface-variant);
font: var(--smrt-typography-label-medium-font);

}
.smrt-campaign-detail__facts dd {
color: var(--smrt-color-on-surface);
font: var(--smrt-typography-body-large-font);
font-weight: var(--smrt-typography-weight-medium);

}
li {
border-bottom: var(--smrt-hairline);

}
.smrt-campaign-detail__channel-name {
color: var(--smrt-color-on-surface);
font: var(--smrt-typography-body-medium-font);
font-weight: var(--smrt-typography-weight-medium);

}
.smrt-campaign-detail__channel-ref {
font: var(--smrt-typography-body-small-font);

}

}

</style>
