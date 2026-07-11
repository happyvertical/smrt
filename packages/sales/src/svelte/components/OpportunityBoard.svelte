<script lang="ts">
/**
 * OpportunityBoard — pipeline board with one column per stage (#1924).
 *
 * Cards show name / owner / expected value / probability. Stage movement is
 * keyboard accessible: each open card gets previous/next stage buttons that
 * delegate to `onMoveStage` — no drag interaction required. Terminal stages
 * are styled won/lost.
 */
import { Badge, Button } from '@happyvertical/smrt-ui/ui';
import { formatCents, formatPercent } from '../format.js';
import type { OpportunityCardView, PipelineStageView } from '../types.js';
import { adjacentStageIds, groupOpportunitiesByStage } from '../types.js';

export interface Props {
  /** Pipeline stages, in board order. */
  stages?: PipelineStageView[];
  /** Opportunities across all stages (grouped internally by `stageId`). */
  opportunities?: OpportunityCardView[];
  /** Disable stage movement while a mutation is in flight. */
  busy?: boolean;
  /** BCP 47 locale for money/percent formatting. */
  locale?: string;
  /** Move an opportunity to another stage of its pipeline. */
  onMoveStage?: (opportunityId: string, stageId: string) => void;
}

let {
  stages = [],
  opportunities = [],
  busy = false,
  locale,
  onMoveStage,
}: Props = $props();

const columns = $derived(groupOpportunitiesByStage(stages, opportunities));

function stageNameOf(stageId: string | null): string {
  if (!stageId) return '';
  return stages.find((stage) => stage.id === stageId)?.name ?? '';
}
</script>

<div class="sales-opportunity-board">
  {#if columns.length === 0}
    <p class="sales-opportunity-board__empty">No pipeline stages configured.</p>
  {:else}
    <div class="columns">
      {#each columns as column (column.stage.id)}
        <section
          class="column"
          class:won={column.stage.isWon}
          class:lost={column.stage.isLost}
          aria-label={column.stage.name}
        >
          <h3 class="column__title">
            <span>{column.stage.name}</span>
            <span class="column__count">{column.opportunities.length}</span>
          </h3>
          <ul class="column__cards">
            {#each column.opportunities as opportunity (opportunity.id)}
              {@const neighbors = adjacentStageIds(stages, opportunity.stageId)}
              {@const movable = onMoveStage && opportunity.status === 'open'}
              <li class="card" class:card--won={opportunity.status === 'won'} class:card--lost={opportunity.status === 'lost'}>
                <span class="card__name">{opportunity.name}</span>
                {#if opportunity.ownerName}
                  <span class="card__owner">{opportunity.ownerName}</span>
                {/if}
                <span class="card__value">
                  {formatCents(opportunity.expectedValueCents, opportunity.currency, locale)}
                </span>
                <span class="card__meta">
                  <Badge size="sm" variant="default">
                    {formatPercent(opportunity.probability, locale)}
                  </Badge>
                  {#if movable}
                    <span class="card__moves">
                      {#if neighbors.prevStageId}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          aria-label={`Move ${opportunity.name} to ${stageNameOf(neighbors.prevStageId)}`}
                          onclick={() => {
                            if (neighbors.prevStageId) {
                              onMoveStage?.(opportunity.id, neighbors.prevStageId);
                            }
                          }}
                        >
                          &larr;
                        </Button>
                      {/if}
                      {#if neighbors.nextStageId}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          aria-label={`Move ${opportunity.name} to ${stageNameOf(neighbors.nextStageId)}`}
                          onclick={() => {
                            if (neighbors.nextStageId) {
                              onMoveStage?.(opportunity.id, neighbors.nextStageId);
                            }
                          }}
                        >
                          &rarr;
                        </Button>
                      {/if}
                    </span>
                  {/if}
                </span>
              </li>
            {/each}
            {#if column.opportunities.length === 0}
              <li class="column__placeholder" aria-hidden="true">—</li>
            {/if}
          </ul>
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .sales-opportunity-board {
    width: 100%;
    overflow-x: auto;
  }

  .sales-opportunity-board__empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-style: italic;
  }

  .columns {
    display: flex;
    gap: var(--smrt-spacing-3, 0.75rem);
    align-items: flex-start;
  }

  .column {
    flex: 1 0 14rem;
    min-width: 14rem;
    background: var(--smrt-color-surface-container-low, #f9fafb);
    border: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    border-radius: var(--smrt-radius-md, 8px);
    padding: var(--smrt-spacing-2, 0.5rem);
  }

  .column.won {
    border-top: 3px solid var(--smrt-color-success, #16a34a);
  }

  .column.lost {
    border-top: 3px solid var(--smrt-color-error, #dc2626);
  }

  .column__title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin: 0 0 var(--smrt-spacing-2, 0.5rem);
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .column__count {
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-weight: var(--smrt-typography-weight-normal, 400);
  }

  .column__cards {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .column__placeholder {
    color: var(--smrt-color-on-surface-variant, #64748b);
    text-align: center;
    padding: var(--smrt-spacing-2, 0.5rem);
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
    background: var(--smrt-color-surface, #fff);
    border: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    border-radius: var(--smrt-radius-sm, 4px);
    padding: var(--smrt-spacing-2, 0.5rem);
  }

  .card--won {
    border-color: var(--smrt-color-success, #16a34a);
  }

  .card--lost {
    border-color: var(--smrt-color-error, #dc2626);
  }

  .card__name {
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .card__owner {
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }

  .card__value {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .card__meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .card__moves {
    display: inline-flex;
    gap: var(--smrt-spacing-1, 0.25rem);
  }
</style>
