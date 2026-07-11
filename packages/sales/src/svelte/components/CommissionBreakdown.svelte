<script lang="ts">
/**
 * CommissionBreakdown — the explainable-amount surface (#1933).
 *
 * Table of commission rows (event, basis, base, rate, share, amount, status,
 * clearing date). Each row expands to the snapshotted calculation trace —
 * plan key@version, component, and the `base × rate × share = amount` formula
 * line — plus the append-only adjustments recorded against it.
 */
import { Badge, Button } from '@happyvertical/smrt-ui/ui';
import { formatCents, formatDate, formatPercent } from '../format.js';
import type { CommissionRowView } from '../types.js';
import {
  commissionStatusBadgeVariant,
  formatCommissionFormula,
  formatPlanRef,
} from '../types.js';

export interface Props {
  /** Commission rows for one earner (or one earning source). */
  commissions?: CommissionRowView[];
  /** BCP 47 locale for money/date formatting. */
  locale?: string;
}

let { commissions = [], locale }: Props = $props();

const uid = $props.id();

let expanded = $state<Record<string, boolean>>({});

function toggle(id: string) {
  expanded = { ...expanded, [id]: !expanded[id] };
}

function detailsId(id: string): string {
  return `${uid}-commission-details-${id}`;
}
</script>

<div class="sales-commission-breakdown">
  {#if commissions.length === 0}
    <p class="empty">No commissions yet.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th scope="col">Event</th>
          <th scope="col">Basis</th>
          <th scope="col" class="num">Base</th>
          <th scope="col" class="num">Rate</th>
          <th scope="col" class="num">Share</th>
          <th scope="col" class="num">Amount</th>
          <th scope="col">Status</th>
          <th scope="col">Clears</th>
          <th scope="col"><span class="visually-hidden">Explanation</span></th>
        </tr>
      </thead>
      <tbody>
        {#each commissions as row (row.id)}
          {@const isExpanded = !!expanded[row.id]}
          <tr>
            <td>
              <span class="event-kind">{row.eventKind.replace(/_/g, ' ')}</span>
              {#if row.sourceLabel}
                <span class="secondary">{row.sourceLabel}</span>
              {/if}
            </td>
            <td>{row.basis}</td>
            <td class="num">{formatCents(row.baseAmountCents, row.currency, locale)}</td>
            <td class="num">
              {row.basis === 'fixed' ? '—' : formatPercent(row.rate, locale)}
            </td>
            <td class="num">{formatPercent(row.shareFraction, locale)}</td>
            <td class="num amount" class:negative={row.amountCents < 0}>
              {formatCents(row.amountCents, row.currency, locale)}
            </td>
            <td>
              <Badge variant={commissionStatusBadgeVariant(row.status)} size="sm">
                {row.status}
              </Badge>
            </td>
            <td>{formatDate(row.clearingEndsAt, locale)}</td>
            <td class="toggle-cell">
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={isExpanded}
                aria-controls={detailsId(row.id)}
                onclick={() => toggle(row.id)}
              >
                {isExpanded ? 'Hide' : 'Explain'}
              </Button>
            </td>
          </tr>
          {#if isExpanded}
            <tr class="details-row">
              <td colspan="9" id={detailsId(row.id)}>
                <div class="details">
                  {#if row.trace}
                    <p class="details__ref">
                      Plan <code>{formatPlanRef(row.trace.planKey, row.trace.planVersion)}</code>
                      · component <code>{row.trace.componentKey}</code>
                    </p>
                  {/if}
                  <p class="details__formula">
                    <code>
                      {formatCommissionFormula(
                        {
                          basis: row.basis,
                          baseAmountCents: row.baseAmountCents,
                          rate: row.rate,
                          shareFraction: row.shareFraction,
                          amountCents: row.amountCents,
                          currency: row.currency,
                        },
                        locale,
                      )}
                    </code>
                  </p>
                  {#if row.adjustments && row.adjustments.length > 0}
                    <table class="adjustments">
                      <caption class="visually-hidden">
                        Adjustments against this commission
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Kind</th>
                          <th scope="col" class="num">Amount</th>
                          <th scope="col">Reason</th>
                          <th scope="col">Recorded</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each row.adjustments as adjustment (adjustment.id)}
                          <tr>
                            <td>{adjustment.adjustmentKind}</td>
                            <td class="num" class:negative={adjustment.amountCents < 0}>
                              {formatCents(adjustment.amountCents, adjustment.currency, locale)}
                            </td>
                            <td>{adjustment.reason}</td>
                            <td>{formatDate(adjustment.createdAt, locale)}</td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  {:else}
                    <p class="details__none">No adjustments.</p>
                  {/if}
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .sales-commission-breakdown {
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

  .num {
    text-align: right;
    white-space: nowrap;
  }

  .amount {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .negative {
    color: var(--smrt-color-error, #dc2626);
  }

  .event-kind {
    display: block;
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .secondary {
    display: block;
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }

  .toggle-cell {
    text-align: right;
    white-space: nowrap;
  }

  .details-row td {
    background: var(--smrt-color-surface-container-low, #f9fafb);
  }

  .details {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .details__ref,
  .details__formula,
  .details__none {
    margin: 0;
  }

  .details__none {
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-style: italic;
  }

  code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }

  .adjustments th {
    background: transparent;
  }
</style>
