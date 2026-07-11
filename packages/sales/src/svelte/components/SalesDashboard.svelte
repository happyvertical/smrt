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

<div class="sales-dashboard">
  <dl class="tiles">
    <div class="tile">
      <dt>Open opportunities</dt>
      <dd>{openCount}</dd>
    </div>
    <div class="tile">
      <dt>Open pipeline value</dt>
      <dd>
        {#if totals.length === 0}
          —
        {:else}
          {#each totals as total (total.currency)}
            <span class="tile__line">
              {formatCents(total.amountCents, total.currency, locale)}
            </span>
          {/each}
        {/if}
      </dd>
    </div>
    <div class="tile">
      <dt>Win rate</dt>
      <dd>{rate === null ? '—' : formatPercent(rate, locale)}</dd>
    </div>
  </dl>

  {#if byStage.length > 0}
    <section class="stages" aria-label="Pipeline value by stage">
      <h3>Pipeline by stage</h3>
      <ul class="stages__list">
        {#each byStage as stage (stage.stageId)}
          <li class="stages__item">
            <span class="stages__name">{stage.stageName}</span>
            <span class="stages__count">{stage.openCount} open</span>
            <span class="stages__value">
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
  .sales-dashboard {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 1rem);
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: var(--smrt-spacing-3, 0.75rem);
    margin: 0;
  }

  .tile {
    background: var(--smrt-color-surface, #fff);
    border: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    border-radius: var(--smrt-radius-md, 8px);
    padding: var(--smrt-spacing-3, 0.75rem);
  }

  .tile dt {
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .tile dd {
    margin: var(--smrt-spacing-1, 0.25rem) 0 0;
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }

  .tile__line {
    display: block;
  }

  h3 {
    margin: 0 0 var(--smrt-spacing-2, 0.5rem);
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant, #64748b);
  }

  .stages__list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
  }

  .stages__item {
    display: flex;
    align-items: baseline;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-1, 0.25rem) 0;
    border-bottom: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .stages__name {
    flex: 1 1 auto;
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .stages__count {
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }

  .stages__value {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
</style>
