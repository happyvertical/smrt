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

<div class="sales-referral-status">
  {#if referrals.length === 0}
    <p class="empty">No referrals yet.</p>
  {:else}
    <table>
      <thead>
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
      <tbody>
        {#each referrals as referral (referral.id)}
          <tr>
            <td>
              <Badge variant={referralStatusBadgeVariant(referral.status)} size="sm">
                {referral.status.replace('_', ' ')}
              </Badge>
            </td>
            <td>
              <span class="target-kind">{referral.targetKind}</span>
              {#if referral.targetLabel}
                <span class="secondary">{referral.targetLabel}</span>
              {/if}
            </td>
            <td class="credit">
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
  .sales-referral-status {
    width: 100%;
    overflow-x: auto;
  }

  .empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-style: italic;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  th {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    text-align: left;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    background: var(--smrt-color-surface-container, #f3f4f6);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    white-space: nowrap;
  }

  td {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    vertical-align: top;
  }

  .target-kind {
    display: block;
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .secondary {
    display: block;
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }

  .credit {
    white-space: nowrap;
  }
</style>
