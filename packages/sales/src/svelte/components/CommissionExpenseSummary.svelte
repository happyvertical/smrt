<script lang="ts">
/**
 * CommissionExpenseSummary — operator reconciliation of commission expense
 * vs. payouts (#1933).
 *
 * Renders pre-aggregated reconciliation rows and per-currency totals:
 * accrued commission expense, adjustments, amounts settled via payouts, and
 * the outstanding net accrual. This is COMMISSION EXPENSE owed to earners —
 * deliberately separate from client invoices and client revenue/margin.
 */
import { formatCents } from '../format.js';
import type { CommissionExpenseRowView } from '../types.js';
import { sumExpenseRowsByCurrency } from '../types.js';

export interface Props {
  /** Pre-aggregated reconciliation rows (per period/program/plan). */
  rows?: CommissionExpenseRowView[];
  /** Heading context, e.g. `June 2026`. */
  periodLabel?: string;
  /** BCP 47 locale for money formatting. */
  locale?: string;
}

let { rows = [], periodLabel, locale }: Props = $props();

const totals = $derived(sumExpenseRowsByCurrency(rows));
</script>

<div class="sales-expense-summary">
  <header class="head">
    <h3>Commission expense{periodLabel ? ` — ${periodLabel}` : ''}</h3>
    <p class="note">
      Amounts owed to earners (operator reconciliation). This is commission
      expense — distinct from client invoices and client revenue.
    </p>
  </header>

  {#if rows.length === 0}
    <p class="empty">Nothing to reconcile for this period.</p>
  {:else}
    <dl class="tiles">
      {#each totals as total (total.currency)}
        <div class="tile">
          <dt>Expense ({total.currency})</dt>
          <dd>{formatCents(total.commissionExpenseCents, total.currency, locale)}</dd>
        </div>
        <div class="tile">
          <dt>Adjustments ({total.currency})</dt>
          <dd class:negative={total.adjustmentCents < 0}>
            {formatCents(total.adjustmentCents, total.currency, locale)}
          </dd>
        </div>
        <div class="tile">
          <dt>Paid out ({total.currency})</dt>
          <dd>{formatCents(total.payoutCents, total.currency, locale)}</dd>
        </div>
        <div class="tile tile--net">
          <dt>Net accrued ({total.currency})</dt>
          <dd class:negative={total.netAccruedCents < 0}>
            {formatCents(total.netAccruedCents, total.currency, locale)}
          </dd>
        </div>
      {/each}
    </dl>

    <table>
      <thead>
        <tr>
          <th scope="col">Segment</th>
          <th scope="col" class="num">Expense</th>
          <th scope="col" class="num">Adjustments</th>
          <th scope="col" class="num">Paid out</th>
          <th scope="col" class="num">Net accrued</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          {@const net = row.commissionExpenseCents + row.adjustmentCents - row.payoutCents}
          <tr>
            <td>{row.label}</td>
            <td class="num">
              {formatCents(row.commissionExpenseCents, row.currency, locale)}
            </td>
            <td class="num" class:negative={row.adjustmentCents < 0}>
              {formatCents(row.adjustmentCents, row.currency, locale)}
            </td>
            <td class="num">{formatCents(row.payoutCents, row.currency, locale)}</td>
            <td class="num net" class:negative={net < 0}>
              {formatCents(net, row.currency, locale)}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .sales-expense-summary {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-3, 0.75rem);
    width: 100%;
    overflow-x: auto;
  }

  .head h3 {
    margin: 0;
    font-size: var(--smrt-typography-title-medium-size, 1rem);
  }

  .note {
    margin: var(--smrt-spacing-1, 0.25rem) 0 0;
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }

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

  .tile--net {
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
    font-weight: var(--smrt-typography-weight-bold, 700);
  }

  .negative {
    color: var(--smrt-color-error, #dc2626);
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
  }

  .num {
    text-align: right;
    white-space: nowrap;
  }

  .net {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
</style>
