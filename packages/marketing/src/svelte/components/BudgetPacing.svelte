<script lang="ts">
import { Progress } from '@happyvertical/smrt-ui/feedback';
import { Badge, Card } from '@happyvertical/smrt-ui/ui';
import { formatCents, formatPercent, humanizeKey } from '../format.js';
import type { BudgetPacingView } from '../types.js';
import { cappedBudgetProgress, pacingStatusBadgeVariant } from '../types.js';

export interface Props {
  pacing?: BudgetPacingView | null;
  locale?: string;
  label?: string;
}

let { pacing = null, locale, label = 'Budget pacing' }: Props = $props();
const progress = $derived(pacing ? cappedBudgetProgress(pacing) : 0);
</script>

{#if !pacing}
  <p class="empty">No budget pacing is available.</p>
{:else}
  <Card padding="sm" variant="outlined">
    <section class="budget-pacing">
      <header>
        <h3>{label}</h3>
        <Badge variant={pacingStatusBadgeVariant(pacing.status)} size="sm">
          {humanizeKey(pacing.status)}
        </Badge>
      </header>

      <div class="progress-label">
        <span>{formatCents(pacing.spendCents, pacing.currency, locale)} spent</span>
        <span>
          {pacing.budgetFraction === null
            ? 'No budget'
            : formatPercent(pacing.budgetFraction, locale)}
        </span>
      </div>
      <Progress value={progress} max={1} label={label} />

      <dl class="facts">
        <div>
          <dt>Budget</dt>
          <dd>{formatCents(pacing.budgetCents, pacing.currency, locale)}</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd class:negative={pacing.remainingCents < 0}>
            {formatCents(pacing.remainingCents, pacing.currency, locale)}
          </dd>
        </div>
        <div>
          <dt>Expected by now</dt>
          <dd>
            {pacing.expectedSpendCents === null
              ? '—'
              : formatCents(pacing.expectedSpendCents, pacing.currency, locale)}
          </dd>
        </div>
        <div>
          <dt>Variance</dt>
          <dd class:negative={(pacing.varianceCents ?? 0) > 0}>
            {pacing.varianceCents === null
              ? '—'
              : formatCents(pacing.varianceCents, pacing.currency, locale)}
          </dd>
        </div>
      </dl>
    </section>
  </Card>
{/if}

<style>
  .budget-pacing {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2);
  }

  header,
  .progress-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
  }

  h3,
  .empty {
    margin: 0;
  }

  h3 {
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-medium-font);
  }

  .empty,
  .progress-label,
  dt {
    color: var(--smrt-color-on-surface-variant);
  }

  .empty {
    font: var(--smrt-typography-body-medium-font);
  }

  .progress-label,
  dt {
    font: var(--smrt-typography-body-small-font);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: var(--smrt-spacing-3);
    margin: var(--smrt-spacing-3) 0 0;
  }

  .facts dd {
    margin: var(--smrt-spacing-1) 0 0;
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-body-medium-font);
    font-weight: var(--smrt-typography-weight-medium);
  }

  .facts dd.negative {
    color: var(--smrt-color-error);
  }
</style>
