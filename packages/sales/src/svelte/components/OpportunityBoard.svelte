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

<div class="smrt-opportunity-board__root" data-smrt-component="OpportunityBoard">
  {#if columns.length === 0}
    <p class="smrt-opportunity-board__empty" data-smrt-part="empty">No pipeline stages configured.</p>
  {:else}
    <div class="smrt-opportunity-board__columns" data-smrt-part="columns">
      {#each columns as column (column.stage.id)}
        <section
          class="smrt-opportunity-board__column"
          class:smrt-opportunity-board__won={column.stage.isWon}
          class:smrt-opportunity-board__lost={column.stage.isLost}
          aria-label={column.stage.name}
          data-smrt-part="column"
        >
          <h3 class="smrt-opportunity-board__title" data-smrt-part="title">
            <span>{column.stage.name}</span>
            <span class="smrt-opportunity-board__count" data-smrt-part="count">{column.opportunities.length}</span>
          </h3>
          <ul class="smrt-opportunity-board__list" data-smrt-part="list">
            {#each column.opportunities as opportunity (opportunity.id)}
              {@const neighbors = adjacentStageIds(stages, opportunity.stageId)}
              {@const movable = onMoveStage && opportunity.status === 'open'}
              <li class="smrt-opportunity-board__card" class:smrt-opportunity-board__card-won={opportunity.status === 'won'} class:smrt-opportunity-board__card-lost={opportunity.status === 'lost'} data-smrt-part="card">
                <span class="smrt-opportunity-board__name" data-smrt-part="name">{opportunity.name}</span>
                {#if opportunity.ownerName}
                  <span class="smrt-opportunity-board__owner" data-smrt-part="owner">{opportunity.ownerName}</span>
                {/if}
                <span class="smrt-opportunity-board__value" data-smrt-part="value">
                  {formatCents(opportunity.expectedValueCents, opportunity.currency, locale)}
                </span>
                <span class="smrt-opportunity-board__meta" data-smrt-part="meta">
                  <Badge size="sm" variant="default">
                    {formatPercent(opportunity.probability, locale)}
                  </Badge>
                  {#if movable}
                    <span class="smrt-opportunity-board__actions" data-smrt-part="actions">
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
              <li class="smrt-opportunity-board__placeholder" data-smrt-part="placeholder" aria-hidden="true">—</li>
            {/if}
          </ul>
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-opportunity-board__root {
    width: 100%;
    overflow-x: auto;
  }
  .smrt-opportunity-board__empty {
    margin: 0;
  }
  .smrt-opportunity-board__columns {
    display: flex;
    gap: var(--smrt-spacing-3, 0.75rem);
    align-items: flex-start;
  }
  .smrt-opportunity-board__column {
    flex: 1 0 14rem;
    min-width: 14rem;
    padding: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-opportunity-board__title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin: 0 0 var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-opportunity-board__list {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .smrt-opportunity-board__placeholder {
    padding: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-opportunity-board__card {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
    padding: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-opportunity-board__meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-opportunity-board__actions {
    display: inline-flex;
    gap: var(--smrt-spacing-1, 0.25rem);
  }
}

@layer smrt.theme {
  .smrt-opportunity-board__empty {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }
  .smrt-opportunity-board__column {
    background: var(--smrt-color-surface-container-low);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md);
  }
  .smrt-opportunity-board__column.smrt-opportunity-board__won {
    border-top: 3px solid var(--smrt-color-success);
  }
  .smrt-opportunity-board__column.smrt-opportunity-board__lost {
    border-top: 3px solid var(--smrt-color-error);
  }
  .smrt-opportunity-board__title {
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-opportunity-board__count {
    color: var(--smrt-color-on-surface-variant);
    font-weight: var(--smrt-typography-weight-normal, 400);
  }
  .smrt-opportunity-board__placeholder {
    color: var(--smrt-color-on-surface-variant);
    text-align: center;
  }
  .smrt-opportunity-board__card {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-sm);
  }
  .smrt-opportunity-board__card-won {
    border-color: var(--smrt-color-success);
  }
  .smrt-opportunity-board__card-lost {
    border-color: var(--smrt-color-error);
  }
  .smrt-opportunity-board__name {
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-opportunity-board__owner {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }
  .smrt-opportunity-board__value {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
}

</style>
