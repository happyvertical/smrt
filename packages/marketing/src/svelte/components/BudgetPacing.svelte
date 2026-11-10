<script lang="ts">
import { Progress } from '@happyvertical/smrt-ui/feedback';
import { Badge, Card } from '@happyvertical/smrt-ui/ui';
import { formatCents, formatPercent, humanizeKey } from '../format.js';
import type { BudgetPacingView } from '../types.js';
import { cappedBudgetProgress, pacingStatusBadgeVariant } from '../types.js';

export interface Props {
  /** Budget pacing data to display. */
  pacing?: BudgetPacingView | null;
  /** Locale for formatting currency and percentages. */
  locale?: string;
  /** Heading text displayed above the progress bar. */
  label?: string;
}

let { pacing = null, locale, label = 'Budget pacing' }: Props = $props();
const progress = $derived(pacing ? cappedBudgetProgress(pacing) : 0);
</script>

{#if !pacing}
  <p class="smrt-budget-pacing__empty" data-smrt-component="BudgetPacing" data-smrt-part="empty">No budget pacing is available.</p>
{:else}
  <Card padding="sm" variant="outlined">
    <section class="smrt-budget-pacing__root" data-smrt-part="body">
      <header data-smrt-part="header">
        <h3 data-smrt-part="title">{label}</h3>
        <Badge variant={pacingStatusBadgeVariant(pacing.status)} size="sm">
          {humanizeKey(pacing.status)}
        </Badge>
      </header>

      <div class="smrt-budget-pacing__progress-label" data-smrt-part="label">
        <span>{formatCents(pacing.spendCents, pacing.currency, locale)} spent</span>
        <span>
          {pacing.budgetFraction === null
            ? 'No budget'
            : formatPercent(pacing.budgetFraction, locale)}
        </span>
      </div>
      <Progress value={progress} max={1} label={label} />

      <dl class="smrt-budget-pacing__facts" data-smrt-part="facts">
        <div>
          <dt>Budget</dt>
          <dd>{formatCents(pacing.budgetCents, pacing.currency, locale)}</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd class:smrt-budget-pacing__negative={pacing.remainingCents < 0}>
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
          <dd class:smrt-budget-pacing__negative={(pacing.varianceCents ?? 0) > 0}>
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-budget-pacing__root {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2);
  }
  header,
  .smrt-budget-pacing__progress-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
  }
  h3,
  .smrt-budget-pacing__empty {
    margin: 0;
  }
  .smrt-budget-pacing__facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: var(--smrt-spacing-3);
    margin: var(--smrt-spacing-3) 0 0;
  }
  .smrt-budget-pacing__facts dd {
    margin: var(--smrt-spacing-1) 0 0;
  }
}

@layer smrt.theme {
  h3 {
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-medium-font);
  }
  .smrt-budget-pacing__empty,
  .smrt-budget-pacing__progress-label,
  dt {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-budget-pacing__empty {
    font: var(--smrt-typography-body-medium-font);
  }
  .smrt-budget-pacing__progress-label,
  dt {
    font: var(--smrt-typography-body-small-font);
  }
  .smrt-budget-pacing__facts dd {
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-body-medium-font);
    font-weight: var(--smrt-typography-weight-medium);
  }
  .smrt-budget-pacing__facts dd.smrt-budget-pacing__negative {
    color: var(--smrt-color-error);
  }
}

</style>
