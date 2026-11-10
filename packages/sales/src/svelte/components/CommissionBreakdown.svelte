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

<div class="smrt-commission-breakdown__root" data-smrt-component="CommissionBreakdown">
  {#if commissions.length === 0}
    <p class="smrt-commission-breakdown__empty" data-smrt-part="empty">No commissions yet.</p>
  {:else}
    <table data-smrt-part="table">
      <thead data-smrt-part="header">
        <tr>
          <th scope="col">Event</th>
          <th scope="col">Basis</th>
          <th scope="col" class="smrt-commission-breakdown__number">Base</th>
          <th scope="col" class="smrt-commission-breakdown__number">Rate</th>
          <th scope="col" class="smrt-commission-breakdown__number">Share</th>
          <th scope="col" class="smrt-commission-breakdown__number">Amount</th>
          <th scope="col">Status</th>
          <th scope="col">Clears</th>
          <th scope="col"><span class="smrt-commission-breakdown__visually-hidden" data-smrt-part="label">Explanation</span></th>
        </tr>
      </thead>
      <tbody data-smrt-part="body">
        {#each commissions as row (row.id)}
          {@const isExpanded = !!expanded[row.id]}
          <tr data-smrt-part="row">
            <td>
              <span class="smrt-commission-breakdown__event-kind">{row.eventKind.replace(/_/g, ' ')}</span>
              {#if row.sourceLabel}
                <span class="smrt-commission-breakdown__secondary">{row.sourceLabel}</span>
              {/if}
            </td>
            <td>{row.basis}</td>
            <td class="smrt-commission-breakdown__number">{formatCents(row.baseAmountCents, row.currency, locale)}</td>
            <td class="smrt-commission-breakdown__number">
              {row.basis === 'fixed' ? '—' : formatPercent(row.rate, locale)}
            </td>
            <td class="smrt-commission-breakdown__number">{formatPercent(row.shareFraction, locale)}</td>
            <td class="smrt-commission-breakdown__number smrt-commission-breakdown__amount" class:smrt-commission-breakdown__negative={row.amountCents < 0}>
              {formatCents(row.amountCents, row.currency, locale)}
            </td>
            <td>
              <Badge variant={commissionStatusBadgeVariant(row.status)} size="sm">
                {row.status}
              </Badge>
            </td>
            <td>{formatDate(row.clearingEndsAt, locale)}</td>
            <td class="smrt-commission-breakdown__actions" data-smrt-part="actions">
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
            <tr class="smrt-commission-breakdown__details-row" data-smrt-part="row">
              <td colspan="9" id={detailsId(row.id)}>
                <div class="smrt-commission-breakdown__details" data-smrt-part="panel">
                  {#if row.trace}
                    <p class="smrt-commission-breakdown__details-ref" data-smrt-part="meta">
                      Plan <code>{formatPlanRef(row.trace.planKey, row.trace.planVersion)}</code>
                      · component <code>{row.trace.componentKey}</code>
                    </p>
                  {/if}
                  <p class="smrt-commission-breakdown__details-formula">
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
                    <table class="smrt-commission-breakdown__adjustments">
                      <caption class="smrt-commission-breakdown__visually-hidden">
                        Adjustments against this commission
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Kind</th>
                          <th scope="col" class="smrt-commission-breakdown__number">Amount</th>
                          <th scope="col">Reason</th>
                          <th scope="col">Recorded</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each row.adjustments as adjustment (adjustment.id)}
                          <tr>
                            <td>{adjustment.adjustmentKind}</td>
                            <td class="smrt-commission-breakdown__number" class:smrt-commission-breakdown__negative={adjustment.amountCents < 0}>
                              {formatCents(adjustment.amountCents, adjustment.currency, locale)}
                            </td>
                            <td>{adjustment.reason}</td>
                            <td>{formatDate(adjustment.createdAt, locale)}</td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  {:else}
                    <p class="smrt-commission-breakdown__details-none" data-smrt-part="empty">No adjustments.</p>
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-commission-breakdown__root {
    width: 100%;
    overflow-x: auto;
  }
  .smrt-commission-breakdown__empty {
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
  .smrt-commission-breakdown__number {
    white-space: nowrap;
  }
  .smrt-commission-breakdown__event-kind {
    display: block;
  }
  .smrt-commission-breakdown__secondary {
    display: block;
  }
  .smrt-commission-breakdown__actions {
    white-space: nowrap;
  }
  .smrt-commission-breakdown__details {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-commission-breakdown__details-ref,
  .smrt-commission-breakdown__details-formula,
  .smrt-commission-breakdown__details-none {
    margin: 0;
  }
}

@layer smrt.theme {
  .smrt-commission-breakdown__empty {
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
  .smrt-commission-breakdown__number {
    text-align: right;
  }
  .smrt-commission-breakdown__amount {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-commission-breakdown__negative {
    color: var(--smrt-color-error);
  }
  .smrt-commission-breakdown__event-kind {
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-commission-breakdown__secondary {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }
  .smrt-commission-breakdown__actions {
    text-align: right;
  }
  .smrt-commission-breakdown__details-row td {
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-commission-breakdown__details-none {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }
  code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }
  .smrt-commission-breakdown__adjustments th {
    background: transparent;
  }
}

</style>
