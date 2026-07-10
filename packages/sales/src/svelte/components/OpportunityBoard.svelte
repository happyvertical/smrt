<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import type {
  SalesBoardOpportunity,
  SalesPipelineStageView,
} from '../types.js';

export interface Props {
  stages: SalesPipelineStageView[];
  opportunities: SalesBoardOpportunity[];
  onmove?: (
    opportunity: SalesBoardOpportunity,
    direction: 'previous' | 'next',
  ) => void;
}

const { stages, opportunities, onmove }: Props = $props();

const opportunitiesByStage = $derived(
  Object.fromEntries(
    stages.map((stage) => [
      stage.id,
      opportunities.filter((opportunity) => opportunity.stageId === stage.id),
    ]),
  ),
);

function formatCurrency(value: number, currency = 'USD'): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}
</script>

<section class="board" aria-label="Opportunity board">
  {#each stages as stage, index (stage.id)}
    <section class="column">
      <header class="column-header">
        <div>
          <strong>{stage.name}</strong>
          <p>{stage.terminal ? `Outcome: ${stage.outcome ?? 'closed'}` : 'Open stage'}</p>
        </div>
        <span class="count">{(opportunitiesByStage[stage.id] ?? []).length}</span>
      </header>

      <div class="column-cards">
        {#if (opportunitiesByStage[stage.id] ?? []).length === 0}
          <p class="empty">No opportunities</p>
        {:else}
          {#each opportunitiesByStage[stage.id] ?? [] as opportunity (opportunity.id)}
            <article class="card">
              <div class="card-top">
                <strong>{opportunity.name}</strong>
                <span class="value">{formatCurrency(opportunity.expectedValue, opportunity.currency)}</span>
              </div>
              <p class="meta">
                {opportunity.ownerName ?? 'Unassigned'} • {opportunity.nextAction || 'No next action'}
              </p>
              <div class="controls">
                <Button
                  type="button"
                  class="move"
                  onclick={() => onmove?.(opportunity, 'previous')}
                  disabled={index === 0}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  class="move move-primary"
                  onclick={() => onmove?.(opportunity, 'next')}
                  disabled={index === stages.length - 1}
                >
                  Next
                </Button>
              </div>
            </article>
          {/each}
        {/if}
      </div>
    </section>
  {/each}
</section>

<style>
  .board {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: 1rem;
  }

  .column {
    display: grid;
    gap: 0.9rem;
    padding: 1rem;
    border-radius: 1.2rem;
    background:
      linear-gradient(180deg, rgba(251, 252, 253, 0.98), rgba(235, 240, 245, 0.96)),
      radial-gradient(circle at top, rgba(41, 128, 185, 0.12), transparent 60%);
    border: 1px solid rgba(29, 53, 87, 0.12);
    min-height: 20rem;
  }

  .column-header {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    align-items: flex-start;
  }

  .column-header p {
    margin: 0.2rem 0 0;
    color: #52606d;
    font-size: 0.88rem;
  }

  .count {
    min-width: 2rem;
    padding: 0.25rem 0.5rem;
    border-radius: 999px;
    background: rgba(29, 53, 87, 0.08);
    text-align: center;
  }

  .column-cards {
    display: grid;
    gap: 0.8rem;
    align-content: start;
  }

  .card {
    display: grid;
    gap: 0.7rem;
    padding: 0.95rem;
    border-radius: 1rem;
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid rgba(29, 53, 87, 0.12);
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.06);
  }

  .card-top {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    align-items: baseline;
  }

  .value {
    color: #0f766e;
    font-weight: 700;
  }

  .meta {
    margin: 0;
    color: #52606d;
    font-size: 0.9rem;
  }

  .controls {
    display: flex;
    gap: 0.45rem;
  }

  :global(.move) {
    flex: 1 1 auto;
    padding: 0.55rem 0.7rem;
    border-radius: 999px;
    border: 1px solid rgba(29, 53, 87, 0.18);
    background: rgba(255, 255, 255, 0.8);
  }

  :global(.move-primary) {
    background: #2a9d8f;
    border-color: #2a9d8f;
    color: white;
  }

  .empty {
    margin: 0;
    padding: 1rem 0.25rem;
    color: #64748b;
    text-align: center;
  }
</style>
