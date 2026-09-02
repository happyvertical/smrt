<script lang="ts">
import { Badge, Button } from '@happyvertical/smrt-ui/ui';
import { formatCents, formatDateRange, humanizeKey } from '../format.js';
import type { CampaignSummaryView } from '../types.js';
import { campaignStatusBadgeVariant } from '../types.js';

export interface Props {
  /** Campaigns to display in the list. */
  campaigns?: CampaignSummaryView[];
  /** ID of the currently selected campaign. */
  selectedCampaignId?: string;
  /** Locale for formatting currency and dates. */
  locale?: string;
  /** Fired when the user selects a campaign. */
  onSelect?: (campaignId: string) => void;
}

let { campaigns = [], selectedCampaignId, locale, onSelect }: Props = $props();
</script>

<div class="campaign-list">
  {#if campaigns.length === 0}
    <p class="empty">No campaigns yet.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th scope="col">Campaign</th>
          <th scope="col">Status</th>
          <th scope="col">Schedule</th>
          <th scope="col" class="number">Spend / budget</th>
          <th scope="col" class="number">Channels</th>
          {#if onSelect}<th scope="col"><span class="visually-hidden">Actions</span></th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each campaigns as campaign (campaign.id)}
          <tr class:selected={campaign.id === selectedCampaignId}>
            <td>
              <span class="name">{campaign.name}</span>
              <span class="secondary">{campaign.campaignKey}</span>
              {#if campaign.objective}
                <span class="secondary">{humanizeKey(campaign.objective)}</span>
              {/if}
            </td>
            <td>
              <Badge variant={campaignStatusBadgeVariant(campaign.status)} size="sm">
                {humanizeKey(campaign.status)}
              </Badge>
            </td>
            <td>{formatDateRange(campaign.startAt, campaign.endAt, locale)}</td>
            <td class="number">
              <span class="name">
                {formatCents(campaign.spendCents ?? 0, campaign.currency, locale)}
              </span>
              <span class="secondary">
                of {formatCents(campaign.budgetCents, campaign.currency, locale)}
              </span>
            </td>
            <td class="number">{campaign.channelCount ?? 0}</td>
            {#if onSelect}
              <td class="action">
                <Button
                  variant={campaign.id === selectedCampaignId ? 'primary' : 'secondary'}
                  size="sm"
                  onclick={() => onSelect?.(campaign.id)}
                >
                  View
                </Button>
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .campaign-list {
    width: 100%;
    overflow-x: auto;
  }

  .empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-body-medium-font);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-body-medium-font);
  }

  th,
  td {
    padding: var(--smrt-spacing-3);
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    text-align: left;
    vertical-align: top;
  }

  th {
    background: var(--smrt-color-surface-container);
    font-weight: var(--smrt-typography-weight-semibold);
    white-space: nowrap;
  }

  tr.selected td {
    background: var(--smrt-color-primary-container);
  }

  .name,
  .secondary {
    display: block;
  }

  .name {
    font-weight: var(--smrt-typography-weight-medium);
  }

  .secondary {
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-body-small-font);
  }

  .number,
  .action {
    text-align: right;
    white-space: nowrap;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
