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

<div class="smrt-campaign-list__root" data-smrt-component="CampaignList">
  {#if campaigns.length === 0}
    <p class="smrt-campaign-list__empty" data-smrt-part="empty">No campaigns yet.</p>
  {:else}
    <table>
      <thead data-smrt-part="header">
        <tr>
          <th scope="col">Campaign</th>
          <th scope="col">Status</th>
          <th scope="col">Schedule</th>
          <th scope="col" class="smrt-campaign-list__number">Spend / budget</th>
          <th scope="col" class="smrt-campaign-list__number">Channels</th>
          {#if onSelect}<th scope="col"><span class="smrt-campaign-list__visually-hidden" data-smrt-part="label">Actions</span></th>{/if}
        </tr>
      </thead>
      <tbody data-smrt-part="body">
        {#each campaigns as campaign (campaign.id)}
          <tr class:smrt-campaign-list__selected={campaign.id === selectedCampaignId} data-smrt-part="row">
            <td>
              <span class="smrt-campaign-list__name">{campaign.name}</span>
              <span class="smrt-campaign-list__secondary">{campaign.campaignKey}</span>
              {#if campaign.objective}
                <span class="smrt-campaign-list__secondary">{humanizeKey(campaign.objective)}</span>
              {/if}
            </td>
            <td>
              <Badge variant={campaignStatusBadgeVariant(campaign.status)} size="sm">
                {humanizeKey(campaign.status)}
              </Badge>
            </td>
            <td>{formatDateRange(campaign.startAt, campaign.endAt, locale)}</td>
            <td class="smrt-campaign-list__number">
              <span class="smrt-campaign-list__name">
                {formatCents(campaign.spendCents ?? 0, campaign.currency, locale)}
              </span>
              <span class="smrt-campaign-list__secondary">
                of {formatCents(campaign.budgetCents, campaign.currency, locale)}
              </span>
            </td>
            <td class="smrt-campaign-list__number">{campaign.channelCount ?? 0}</td>
            {#if onSelect}
              <td class="smrt-campaign-list__action" data-smrt-part="actions">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {

.smrt-campaign-list__root {
width: 100%;
overflow-x: auto;

}
.smrt-campaign-list__empty {
margin: 0;

}
table {
width: 100%;

}
th,
  td {
padding: var(--smrt-spacing-3);

}
th {
white-space: nowrap;

}
.smrt-campaign-list__name,
  .smrt-campaign-list__secondary {
display: block;

}
.smrt-campaign-list__number,
  .smrt-campaign-list__action {
white-space: nowrap;

}
.smrt-campaign-list__visually-hidden {
position: absolute;
width: 1px;
height: 1px;
overflow: hidden;
clip: rect(0 0 0 0);
white-space: nowrap;

}

}
@layer smrt.theme {

.smrt-campaign-list__empty {
color: var(--smrt-color-on-surface-variant);
font: var(--smrt-typography-body-medium-font);

}
table {
border-collapse: collapse;
color: var(--smrt-color-on-surface);
font: var(--smrt-typography-body-medium-font);

}
th,
  td {
border-bottom: var(--smrt-hairline);
text-align: left;
vertical-align: top;

}
th {
background: var(--smrt-color-surface-container);
font-weight: var(--smrt-typography-weight-semibold);

}
tr.smrt-campaign-list__selected td {
background: var(--smrt-color-primary-container);

}
.smrt-campaign-list__name {
font-weight: var(--smrt-typography-weight-medium);

}
.smrt-campaign-list__secondary {
color: var(--smrt-color-on-surface-variant);
font: var(--smrt-typography-body-small-font);

}
.smrt-campaign-list__number,
  .smrt-campaign-list__action {
text-align: right;

}

}

</style>
