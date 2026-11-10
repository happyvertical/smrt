<script lang="ts">
/**
 * SalesDashboard — CRM composition surface (#1924).
 *
 * Summary tiles (open opportunity count, open pipeline value per stage, win
 * rate) computed from props via the exported pure helpers in `types.ts`, plus
 * snippet props to embed the board and list surfaces underneath. Multi-currency
 * pipelines render one total line per currency — amounts are never summed
 * across currencies.
 */
import type { Snippet } from 'svelte';
import { formatCents, formatPercent } from '../format.js';
import type { OpportunityCardView, PipelineStageView } from '../types.js';
import {
  openOpportunityCount,
  openPipelineTotals,
  pipelineValueByStage,
  winRate,
} from '../types.js';

export interface Props {
  /** All opportunities in scope (open and closed — closed feed the win rate). */
  opportunities?: OpportunityCardView[];
  /** Pipeline stages, in order (for the per-stage value breakdown). */
  stages?: PipelineStageView[];
  /** BCP 47 locale for money/percent formatting. */
  locale?: string;
  /** Embedded pipeline board (e.g. an `OpportunityBoard`). */
  board?: Snippet;
  /** Embedded lead/opportunity list (e.g. a `LeadList`). */
  list?: Snippet;
  /** Additional embedded content rendered last. */
  children?: Snippet;
}

let {
  opportunities = [],
  stages = [],
  locale,
  board,
  list,
  children,
}: Props = $props();

const openCount = $derived(openOpportunityCount(opportunities));
const totals = $derived(openPipelineTotals(opportunities));
const byStage = $derived(pipelineValueByStage(stages, opportunities));
const rate = $derived(winRate(opportunities));
</script>

<div class="smrt-sales-dashboard__root" data-smrt-component="SalesDashboard">
  <dl class="smrt-sales-dashboard__tiles" data-smrt-part="group">
    <div class="smrt-sales-dashboard__tile" data-smrt-part="item">
      <dt>Open opportunities</dt>
      <dd>{openCount}</dd>
    </div>
    <div class="smrt-sales-dashboard__tile" data-smrt-part="item">
      <dt>Open pipeline value</dt>
      <dd>
        {#if totals.length === 0}
          —
        {:else}
          {#each totals as total (total.currency)}
            <span class="smrt-sales-dashboard__line" data-smrt-part="value">
              {formatCents(total.amountCents, total.currency, locale)}
            </span>
          {/each}
        {/if}
      </dd>
    </div>
    <div class="smrt-sales-dashboard__tile" data-smrt-part="item">
      <dt>Win rate</dt>
      <dd>{rate === null ? '—' : formatPercent(rate, locale)}</dd>
    </div>
  </dl>

  {#if byStage.length > 0}
    <section class="smrt-sales-dashboard__stages" data-smrt-part="group" aria-label="Pipeline value by stage">
      <h3>Pipeline by stage</h3>
      <ul class="smrt-sales-dashboard__list" data-smrt-part="list">
        {#each byStage as stage (stage.stageId)}
          <li class="smrt-sales-dashboard__row" data-smrt-part="row">
            <span class="smrt-sales-dashboard__name" data-smrt-part="title">{stage.stageName}</span>
            <span class="smrt-sales-dashboard__count" data-smrt-part="count">{stage.openCount} open</span>
            <span class="smrt-sales-dashboard__value" data-smrt-part="value">
              {#if stage.totals.length === 0}
                —
              {:else}
                {#each stage.totals as total, index (total.currency)}
                  {index > 0 ? ' · ' : ''}{formatCents(total.amountCents, total.currency, locale)}
                {/each}
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if board}
    <section aria-label="Pipeline board">
      {@render board()}
    </section>
  {/if}

  {#if list}
    <section aria-label="Lead list">
      {@render list()}
    </section>
  {/if}

  {@render children?.()}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-sales-dashboard__root {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 1rem);
  }
  .smrt-sales-dashboard__tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: var(--smrt-spacing-3, 0.75rem);
    margin: 0;
  }
  .smrt-sales-dashboard__tile {
    padding: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-sales-dashboard__tile dd {
    margin: var(--smrt-spacing-1, 0.25rem) 0 0;
  }
  .smrt-sales-dashboard__line {
    display: block;
  }
  h3 {
    margin: 0 0 var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-sales-dashboard__list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-sales-dashboard__row {
    display: flex;
    align-items: baseline;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-1, 0.25rem) 0;
  }
  .smrt-sales-dashboard__name {
    flex: 1 1 auto;
  }
}

@layer smrt.theme {
  .smrt-sales-dashboard__tile {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md);
  }
  .smrt-sales-dashboard__tile dt {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .smrt-sales-dashboard__tile dd {
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }
  h3 {
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-sales-dashboard__row {
    border-bottom: var(--smrt-hairline);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  .smrt-sales-dashboard__name {
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-sales-dashboard__count {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }
  .smrt-sales-dashboard__value {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
}

</style>
