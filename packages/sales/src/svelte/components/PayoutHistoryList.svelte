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

<div class="sales-payout-history">
  {#if payouts.length === 0}
    <p class="empty">No payouts yet.</p>
  {:else}
    <ul class="list">
      {#each payouts as payout (payout.id)}
        <li class="payout">
          <div class="payout__head">
            <span class="payout__period">
              {formatDate(payout.periodStart, locale)} – {formatDate(payout.periodEnd, locale)}
            </span>
            <span class="payout__head-right">
              <span class="payout__method">{methodLabel(payout.payoutMethod)}</span>
              <Badge variant={payoutStatusBadgeVariant(payout.status)} size="sm">
                {payout.status}
              </Badge>
            </span>
          </div>

          <dl class="totals">
            <div class="totals__item">
              <dt>Commissions</dt>
              <dd>{formatCents(payout.commissionTotalCents, payout.currency, locale)}</dd>
            </div>
            <div class="totals__item">
              <dt>Adjustments</dt>
              <dd class:negative={payout.adjustmentTotalCents < 0}>
                {formatCents(payout.adjustmentTotalCents, payout.currency, locale)}
              </dd>
            </div>
            <div class="totals__item totals__item--net">
              <dt>Net</dt>
              <dd class:negative={payout.totalAmountCents < 0}>
                {formatCents(payout.totalAmountCents, payout.currency, locale)}
              </dd>
            </div>
          </dl>

          <ol class="timeline">
            {#each payoutStatusTimeline(payout.status) as step (step.status)}
              <li
                class="timeline__step timeline__step--{step.state}"
                class:timeline__step--failed={step.status === 'failed'}
                aria-current={step.state === 'current' ? 'step' : undefined}
              >
                {step.status}
              </li>
            {/each}
          </ol>

          {#if payout.paymentReference || payout.providerRef || payout.paidAt}
            <dl class="refs">
              {#if payout.paymentReference}
                <div class="refs__item">
                  <dt>Payment reference</dt>
                  <dd><code>{payout.paymentReference}</code></dd>
                </div>
              {/if}
              {#if payout.providerRef}
                <div class="refs__item">
                  <dt>Provider reference</dt>
                  <dd><code>{payout.providerRef}</code></dd>
                </div>
              {/if}
              {#if payout.paidAt}
                <div class="refs__item">
                  <dt>Paid</dt>
                  <dd>{formatDate(payout.paidAt, locale)}</dd>
                </div>
              {/if}
            </dl>
          {/if}

          {#if payout.notes}
            <p class="notes">{payout.notes}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-style: italic;
  }

  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-3, 0.75rem);
  }

  .payout {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
    background: var(--smrt-color-surface, #fff);
    border: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    border-radius: var(--smrt-radius-md, 8px);
    padding: var(--smrt-spacing-3, 0.75rem);
  }

  .payout__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .payout__period {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .payout__head-right {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .payout__method {
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }

  .totals {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-4, 1rem);
    margin: 0;
  }

  .totals__item dt {
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .totals__item dd {
    margin: 0;
  }

  .totals__item--net dd {
    font-weight: var(--smrt-typography-weight-bold, 700);
  }

  .negative {
    color: var(--smrt-color-error, #dc2626);
  }

  .timeline {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-1, 0.25rem);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .timeline__step {
    padding: var(--smrt-spacing-0_5, 0.125rem) var(--smrt-spacing-2, 0.5rem);
    border-radius: var(--smrt-radius-full, 9999px);
    border: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant, #64748b);
  }

  .timeline__step--done {
    background: var(--smrt-color-surface-container, #f3f4f6);
  }

  .timeline__step--current {
    border-color: var(--smrt-color-primary, #2563eb);
    color: var(--smrt-color-primary, #2563eb);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .timeline__step--current.timeline__step--failed {
    border-color: var(--smrt-color-error, #dc2626);
    color: var(--smrt-color-error, #dc2626);
  }

  .refs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-4, 1rem);
    margin: 0;
  }

  .refs__item dt {
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .refs__item dd {
    margin: 0;
  }

  code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }

  .notes {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }
</style>
