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

<div class="smrt-commission-expense-summary__root" data-smrt-component="CommissionExpenseSummary">
  <header class="smrt-commission-expense-summary__header" data-smrt-part="header">
    <h3 data-smrt-part="title">Commission expense{periodLabel ? ` — ${periodLabel}` : ''}</h3>
    <p class="smrt-commission-expense-summary__note" data-smrt-part="description">
      Amounts owed to earners (operator reconciliation). This is commission
      expense — distinct from client invoices and client revenue.
    </p>
  </header>

  {#if rows.length === 0}
    <p class="smrt-commission-expense-summary__empty" data-smrt-part="empty">Nothing to reconcile for this period.</p>
  {:else}
    <dl class="smrt-commission-expense-summary__tiles" data-smrt-part="list">
      {#each totals as total (total.currency)}
        <div class="smrt-commission-expense-summary__tile" data-smrt-part="item">
          <dt>Expense ({total.currency})</dt>
          <dd>{formatCents(total.commissionExpenseCents, total.currency, locale)}</dd>
        </div>
        <div class="smrt-commission-expense-summary__tile" data-smrt-part="item">
          <dt>Adjustments ({total.currency})</dt>
          <dd class:smrt-commission-expense-summary__negative={total.adjustmentCents < 0} data-smrt-part="value">
            {formatCents(total.adjustmentCents, total.currency, locale)}
          </dd>
        </div>
        <div class="smrt-commission-expense-summary__tile" data-smrt-part="item">
          <dt>Paid out ({total.currency})</dt>
          <dd>{formatCents(total.payoutCents, total.currency, locale)}</dd>
        </div>
        <div class="smrt-commission-expense-summary__tile smrt-commission-expense-summary__tile--net" data-smrt-part="item">
          <dt>Net accrued ({total.currency})</dt>
          <dd class:smrt-commission-expense-summary__negative={total.netAccruedCents < 0} data-smrt-part="value">
            {formatCents(total.netAccruedCents, total.currency, locale)}
          </dd>
        </div>
      {/each}
    </dl>

    <table data-smrt-part="table">
      <thead>
        <tr>
          <th scope="col">Segment</th>
          <th scope="col" class="smrt-commission-expense-summary__number" data-smrt-part="cell">Expense</th>
          <th scope="col" class="smrt-commission-expense-summary__number" data-smrt-part="cell">Adjustments</th>
          <th scope="col" class="smrt-commission-expense-summary__number" data-smrt-part="cell">Paid out</th>
          <th scope="col" class="smrt-commission-expense-summary__number" data-smrt-part="cell">Net accrued</th>
        </tr>
      </thead>
      <tbody data-smrt-part="body">
        {#each rows as row (row.id)}
          {@const net = row.commissionExpenseCents + row.adjustmentCents - row.payoutCents}
          <tr data-smrt-part="row">
            <td>{row.label}</td>
            <td class="smrt-commission-expense-summary__number" data-smrt-part="cell">
              {formatCents(row.commissionExpenseCents, row.currency, locale)}
            </td>
            <td class="smrt-commission-expense-summary__number" class:smrt-commission-expense-summary__negative={row.adjustmentCents < 0} data-smrt-part="cell">
              {formatCents(row.adjustmentCents, row.currency, locale)}
            </td>
            <td class="smrt-commission-expense-summary__number" data-smrt-part="cell">{formatCents(row.payoutCents, row.currency, locale)}</td>
            <td class="smrt-commission-expense-summary__number smrt-commission-expense-summary__net" class:smrt-commission-expense-summary__negative={net < 0} data-smrt-part="cell">
              {formatCents(net, row.currency, locale)}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-commission-expense-summary__root {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-3, 0.75rem);
    width: 100%;
    overflow-x: auto;
  }
  .smrt-commission-expense-summary__header h3 {
    margin: 0;
  }
  .smrt-commission-expense-summary__note {
    margin: var(--smrt-spacing-1, 0.25rem) 0 0;
  }
  .smrt-commission-expense-summary__empty {
    margin: 0;
  }
  .smrt-commission-expense-summary__tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--smrt-spacing-3, 0.75rem);
    margin: 0;
  }
  .smrt-commission-expense-summary__tile {
    padding: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-commission-expense-summary__tile dd {
    margin: var(--smrt-spacing-1, 0.25rem) 0 0;
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
  .smrt-commission-expense-summary__number {
    white-space: nowrap;
  }
}

@layer smrt.theme {
  .smrt-commission-expense-summary__header h3 {
    font-size: var(--smrt-typography-title-medium-size, 1rem);
  }
  .smrt-commission-expense-summary__note {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }
  .smrt-commission-expense-summary__empty {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }
  .smrt-commission-expense-summary__tile {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md);
  }
  .smrt-commission-expense-summary__tile--net {
    border-color: var(--smrt-color-primary);
  }
  .smrt-commission-expense-summary__tile dt {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .smrt-commission-expense-summary__tile dd {
    font-weight: var(--smrt-typography-weight-bold, 700);
  }
  .smrt-commission-expense-summary__negative {
    color: var(--smrt-color-error);
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
  }
  .smrt-commission-expense-summary__number {
    text-align: right;
  }
  .smrt-commission-expense-summary__net {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
}

</style>
