<script lang="ts">
/**
 * ReferrerEarningsSummary — referrer-portal balance tiles (#1933).
 *
 * Renders an `EarnerBalance`-shaped prop (the computed, never-stored balance
 * from `CommissionBalanceService`) as tiles: pending, earned, approved,
 * payable, unsettled adjustments, and net payable. Negative-safe — clawbacks
 * can drive adjustments and even net payable below zero.
 */
import { formatCents } from '../format.js';
import type { EarnerBalance } from '../types.js';

export interface Props {
  /** Computed balance for one earner+currency, or `null` before load. */
  balance?: EarnerBalance | null;
  /** BCP 47 locale for money formatting. */
  locale?: string;
}

let { balance = null, locale }: Props = $props();

interface Tile {
  label: string;
  amountCents: number;
  emphasis?: boolean;
}

const tiles = $derived.by((): Tile[] => {
  if (!balance) return [];
  return [
    { label: 'Pending (clearing)', amountCents: balance.pendingCents },
    { label: 'Earned', amountCents: balance.earnedCents },
    { label: 'Approved', amountCents: balance.approvedCents },
    { label: 'Payable', amountCents: balance.payableCents },
    {
      label: 'Unsettled adjustments',
      amountCents: balance.unsettledAdjustmentCents,
    },
    {
      label: 'Net payable',
      amountCents: balance.netPayableCents,
      emphasis: true,
    },
  ];
});
</script>

<div class="sales-earnings-summary">
  {#if !balance}
    <p class="empty">No earnings yet.</p>
  {:else}
    <dl class="tiles">
      {#each tiles as tile (tile.label)}
        <div class="tile" class:tile--emphasis={tile.emphasis}>
          <dt>{tile.label}</dt>
          <dd class:negative={tile.amountCents < 0}>
            {formatCents(tile.amountCents, balance.currency, locale)}
          </dd>
        </div>
      {/each}
    </dl>
  {/if}
</div>

<style>
  .empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-style: italic;
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--smrt-spacing-3, 0.75rem);
    margin: 0;
  }

  .tile {
    background: var(--smrt-color-surface, #fff);
    border: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    border-radius: var(--smrt-radius-md, 8px);
    padding: var(--smrt-spacing-3, 0.75rem);
  }

  .tile--emphasis {
    border-color: var(--smrt-color-primary, #2563eb);
  }

  .tile dt {
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .tile dd {
    margin: var(--smrt-spacing-1, 0.25rem) 0 0;
    font-size: var(--smrt-typography-title-medium-size, 1rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }

  .tile dd.negative {
    color: var(--smrt-color-error, #dc2626);
  }
</style>
