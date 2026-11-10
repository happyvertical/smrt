<script lang="ts">
/**
 * PayoutHistoryList — settlement batch history (#1933).
 *
 * One card per payout batch: settlement period, totals (commission /
 * adjustments / net), delivery method, a linear status timeline
 * (`pending → approved → processing → completed`, with `failed` as the
 * terminal marker when a batch fails), and payment references when present.
 */
import { Badge } from '@happyvertical/smrt-ui/ui';
import { formatCents, formatDate } from '../format.js';
import type { PayoutView } from '../types.js';
import { payoutStatusBadgeVariant, payoutStatusTimeline } from '../types.js';

export interface Props {
  /** Payout batches, newest first by convention. */
  payouts?: PayoutView[];
  /** BCP 47 locale for money/date formatting. */
  locale?: string;
}

let { payouts = [], locale }: Props = $props();

function methodLabel(method: string): string {
  return method.replace(/_/g, ' ');
}
</script>

<div class="smrt-payout-history-list__root" data-smrt-component="PayoutHistoryList">
  {#if payouts.length === 0}
    <p class="smrt-payout-history-list__empty" data-smrt-part="empty">No payouts yet.</p>
  {:else}
    <ul class="smrt-payout-history-list__list" data-smrt-part="list">
      {#each payouts as payout (payout.id)}
        <li class="smrt-payout-history-list__payout" data-smrt-part="item">
          <div class="smrt-payout-history-list__header" data-smrt-part="header">
            <span class="smrt-payout-history-list__period" data-smrt-part="title">
              {formatDate(payout.periodStart, locale)} – {formatDate(payout.periodEnd, locale)}
            </span>
            <span class="smrt-payout-history-list__meta" data-smrt-part="meta">
              <span class="smrt-payout-history-list__method" data-smrt-part="meta">{methodLabel(payout.payoutMethod)}</span>
              <Badge variant={payoutStatusBadgeVariant(payout.status)} size="sm">
                {payout.status}
              </Badge>
            </span>
          </div>

          <dl class="smrt-payout-history-list__totals" data-smrt-part="meta">
            <div class="smrt-payout-history-list__total" data-smrt-part="value">
              <dt>Commissions</dt>
              <dd>{formatCents(payout.commissionTotalCents, payout.currency, locale)}</dd>
            </div>
            <div class="smrt-payout-history-list__total" data-smrt-part="value">
              <dt>Adjustments</dt>
              <dd class:smrt-payout-history-list__negative={payout.adjustmentTotalCents < 0} data-smrt-part="value">
                {formatCents(payout.adjustmentTotalCents, payout.currency, locale)}
              </dd>
            </div>
            <div class="smrt-payout-history-list__total smrt-payout-history-list__total--net" data-smrt-part="value">
              <dt>Net</dt>
              <dd class:smrt-payout-history-list__negative={payout.totalAmountCents < 0} data-smrt-part="value">
                {formatCents(payout.totalAmountCents, payout.currency, locale)}
              </dd>
            </div>
          </dl>

          <ol class="smrt-payout-history-list__timeline" data-smrt-part="list">
            {#each payoutStatusTimeline(payout.status) as step (step.status)}
              <li
                class="smrt-payout-history-list__step smrt-payout-history-list__step--{step.state}"
                class:smrt-payout-history-list__step--failed={step.status === 'failed'}
                aria-current={step.state === 'current' ? 'step' : undefined}
                data-smrt-part="item"
              >
                {step.status}
              </li>
            {/each}
          </ol>

          {#if payout.paymentReference || payout.providerRef || payout.paidAt}
            <dl class="smrt-payout-history-list__refs" data-smrt-part="meta">
              {#if payout.paymentReference}
                <div class="smrt-payout-history-list__ref" data-smrt-part="label">
                  <dt>Payment reference</dt>
                  <dd><code>{payout.paymentReference}</code></dd>
                </div>
              {/if}
              {#if payout.providerRef}
                <div class="smrt-payout-history-list__ref" data-smrt-part="label">
                  <dt>Provider reference</dt>
                  <dd><code>{payout.providerRef}</code></dd>
                </div>
              {/if}
              {#if payout.paidAt}
                <div class="smrt-payout-history-list__ref" data-smrt-part="label">
                  <dt>Paid</dt>
                  <dd>{formatDate(payout.paidAt, locale)}</dd>
                </div>
              {/if}
            </dl>
          {/if}

          {#if payout.notes}
            <p class="smrt-payout-history-list__notes" data-smrt-part="description">{payout.notes}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-payout-history-list__empty {
    margin: 0;
  }
  .smrt-payout-history-list__list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-payout-history-list__payout {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-payout-history-list__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-payout-history-list__meta {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-payout-history-list__totals {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-4, 1rem);
    margin: 0;
  }
  .smrt-payout-history-list__total dd {
    margin: 0;
  }
  .smrt-payout-history-list__timeline {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-1, 0.25rem);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .smrt-payout-history-list__step {
    padding: var(--smrt-spacing-0_5, 0.125rem) var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-payout-history-list__refs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-4, 1rem);
    margin: 0;
  }
  .smrt-payout-history-list__ref dd {
    margin: 0;
  }
  .smrt-payout-history-list__notes {
    margin: 0;
  }
}

@layer smrt.theme {
  .smrt-payout-history-list__empty {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }
  .smrt-payout-history-list__payout {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md);
  }
  .smrt-payout-history-list__period {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-payout-history-list__method {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }
  .smrt-payout-history-list__total dt {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .smrt-payout-history-list__total--net dd {
    font-weight: var(--smrt-typography-weight-bold, 700);
  }
  .smrt-payout-history-list__negative {
    color: var(--smrt-color-error);
  }
  .smrt-payout-history-list__step {
    border-radius: var(--smrt-radius-full);
    border: var(--smrt-hairline);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-payout-history-list__step--done {
    background: var(--smrt-color-surface-container);
  }
  .smrt-payout-history-list__step--current {
    border-color: var(--smrt-color-primary);
    color: var(--smrt-color-primary);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-payout-history-list__step--current.smrt-payout-history-list__step--failed {
    border-color: var(--smrt-color-error);
    color: var(--smrt-color-error);
  }
  .smrt-payout-history-list__ref dt {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }
  .smrt-payout-history-list__notes {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }
}

</style>
