<script lang="ts">
/**
 * ReferralStatusList — referrer-portal referral status view (#1931).
 *
 * Read-only table of a referrer's introductions: lifecycle status badge,
 * qualifying target kind, credit fraction (with a split indicator when the
 * referral shares a `splitGroupId`), and the attribution/qualification dates.
 */
import { Badge } from '@happyvertical/smrt-ui/ui';
import { formatDate, formatPercent } from '../format.js';
import type { ReferralStatusView } from '../types.js';
import { referralStatusBadgeVariant } from '../types.js';

export interface Props {
  /** The referrer's referrals, newest first by convention. */
  referrals?: ReferralStatusView[];
  /** BCP 47 locale for date/percent formatting. */
  locale?: string;
}

let { referrals = [], locale }: Props = $props();
</script>

<div class="smrt-referral-status-list__root" data-smrt-component="ReferralStatusList">
  {#if referrals.length === 0}
    <p class="smrt-referral-status-list__empty" data-smrt-part="empty">No referrals yet.</p>
  {:else}
    <table>
      <thead data-smrt-part="header">
        <tr>
          <th scope="col">Status</th>
          <th scope="col">Target</th>
          <th scope="col">Credit</th>
          <th scope="col">Program</th>
          <th scope="col">Attributed</th>
          <th scope="col">Qualified</th>
          <th scope="col">Expires</th>
        </tr>
      </thead>
      <tbody data-smrt-part="body">
        {#each referrals as referral (referral.id)}
          <tr data-smrt-part="row">
            <td>
              <Badge variant={referralStatusBadgeVariant(referral.status)} size="sm">
                {referral.status.replace('_', ' ')}
              </Badge>
            </td>
            <td>
              <span class="smrt-referral-status-list__target-kind">{referral.targetKind}</span>
              {#if referral.targetLabel}
                <span class="smrt-referral-status-list__secondary">{referral.targetLabel}</span>
              {/if}
            </td>
            <td class="smrt-referral-status-list__credit">
              {formatPercent(referral.creditFraction, locale)}
              {#if referral.splitGroupId}
                <Badge variant="info" size="sm">split</Badge>
              {/if}
            </td>
            <td>{referral.programName ?? '—'}</td>
            <td>{formatDate(referral.attributedAt, locale)}</td>
            <td>{formatDate(referral.qualifiedAt, locale)}</td>
            <td>{formatDate(referral.expiresAt, locale)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-referral-status-list__root {
    width: 100%;
    overflow-x: auto;
  }
  .smrt-referral-status-list__empty {
    margin: 0;
  }
  table {
    width: 100%;
  }
  th {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    white-space: nowrap;
  }
  td {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-referral-status-list__target-kind {
    display: block;
  }
  .smrt-referral-status-list__secondary {
    display: block;
  }
  .smrt-referral-status-list__credit {
    white-space: nowrap;
  }
}

@layer smrt.theme {
  .smrt-referral-status-list__empty {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }
  table {
    border-collapse: collapse;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  th {
    text-align: left;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    background: var(--smrt-color-surface-container);
    border-bottom: var(--smrt-hairline);
  }
  td {
    border-bottom: var(--smrt-hairline);
    vertical-align: top;
  }
  .smrt-referral-status-list__target-kind {
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-referral-status-list__secondary {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }
}

</style>
