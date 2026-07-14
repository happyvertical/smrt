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
  campaign?: CampaignDetailView | null;
  channels?: CampaignChannelView[];
  locale?: string;
  pacing?: Snippet;
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
  <p class="empty">Select a campaign to see its details.</p>
{:else}
  <article class="campaign-detail">
    <Card variant="outlined">
      <header class="header">
        <div>
          <p class="eyebrow">{campaign.campaignKey}</p>
          <h2>{campaign.name}</h2>
          {#if campaign.description}<p class="description">{campaign.description}</p>{/if}
        </div>
        <Badge variant={campaignStatusBadgeVariant(campaign.status)}>
          {humanizeKey(campaign.status)}
        </Badge>
      </header>

      <dl class="facts">
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
        <section class="channels" aria-label="Campaign channels">
          <h3>Executions</h3>
          <ul>
            {#each channels as channel (channel.id)}
              <li>
                <span>
                  <span class="channel-name">{channel.label ?? humanizeKey(channel.channelKind)}</span>
                  <span class="channel-ref">{channel.channelRef}</span>
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
  .campaign-detail {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4);
  }

  .empty,
  .description,
  .channel-ref {
    color: var(--smrt-color-on-surface-variant);
  }

  .empty,
  .description {
    margin: 0;
    font: var(--smrt-typography-body-medium-font);
  }

  .header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--smrt-spacing-4);
  }

  .eyebrow {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-label-medium-font);
  }

  h2,
  h3 {
    margin: 0;
    color: var(--smrt-color-on-surface);
  }

  h2 {
    font: var(--smrt-typography-headline-small-font);
  }

  h3 {
    font: var(--smrt-typography-title-medium-font);
  }

  .description {
    margin-top: var(--smrt-spacing-2);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--smrt-spacing-4);
    margin: var(--smrt-spacing-5) 0 0;
  }

  .facts dt {
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-label-medium-font);
  }

  .facts dd {
    margin: var(--smrt-spacing-1) 0 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-body-large-font);
    font-weight: var(--smrt-typography-weight-medium);
  }

  .channels h3 {
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
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .channel-name,
  .channel-ref {
    display: block;
  }

  .channel-name {
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-body-medium-font);
    font-weight: var(--smrt-typography-weight-medium);
  }

  .channel-ref {
    font: var(--smrt-typography-body-small-font);
  }
</style>
