<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import type {
  SalesActivityView,
  SalesDetailRecord,
  SalesPipelineStageView,
} from '../types.js';

export interface Props {
  record: SalesDetailRecord;
  stages?: SalesPipelineStageView[];
  onassign?: (leadId: string) => void;
  onqualify?: (leadId: string) => void;
  onmoveStage?: (opportunityId: string, stageId: string) => void;
}

const {
  record,
  stages = [],
  onassign,
  onqualify,
  onmoveStage,
}: Props = $props();

const activityItems = $derived(record.activities ?? []);
const acquisitionItems = $derived(record.acquisitions ?? []);

function formatCurrency(value: number, currency = 'USD'): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatTime(item: SalesActivityView | { occurredAt: string }): string {
  const value = new Date(item.occurredAt);
  return Number.isNaN(value.getTime())
    ? item.occurredAt
    : value.toLocaleString();
}
</script>

<section class="detail">
  <header class="hero">
    <div>
      <span class="eyebrow">{record.lead.status}</span>
      <h2>{record.lead.name}</h2>
      <p>
        {record.lead.organization || 'Independent buyer'}
        {#if record.lead.email}
          • {record.lead.email}
        {/if}
      </p>
      <p class="owner">
        {record.ownerName ? `Owned by ${record.ownerName}` : 'No owner assigned'}
      </p>
    </div>
    <div class="hero-actions">
      <Button type="button" onclick={() => onassign?.(record.lead.id)}>Assign</Button>
      <Button
        type="button"
        class="primary"
        onclick={() => onqualify?.(record.lead.id)}
        disabled={record.lead.status !== 'new'}
      >
        Qualify
      </Button>
    </div>
  </header>

  {#if record.opportunity}
    {@const opportunityId = record.opportunity.id}
    <section class="card">
      <div class="card-head">
        <div>
          <h3>{record.opportunity.name}</h3>
          <p>{record.opportunity.stageName}</p>
        </div>
        <strong>{formatCurrency(record.opportunity.expectedValue, record.opportunity.currency)}</strong>
      </div>
      <p class="next-action">{record.opportunity.nextAction || 'No next action captured yet.'}</p>
      <div class="stage-row">
        {#each stages as stage (stage.id)}
          <Button
            type="button"
            class={stage.id === record.opportunity.stageId ? 'active' : ''}
            onclick={() => onmoveStage?.(opportunityId, stage.id)}
          >
            {stage.name}
          </Button>
        {/each}
      </div>
      {#if record.opportunity.outcome && record.opportunity.outcome !== 'open'}
        <p class="outcome">Outcome: {record.opportunity.outcome}</p>
      {/if}
    </section>
  {/if}

  <div class="grid">
    <section class="card">
      <h3>Acquisition</h3>
      {#if acquisitionItems.length === 0}
        <p class="muted">No acquisition history recorded.</p>
      {:else}
        <ul>
          {#each acquisitionItems as item}
            <li>
              <strong>{item.source}</strong>
              <span>{formatTime(item)}</span>
              {#if item.campaign}
                <span class="muted">{item.campaign}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="card">
      <h3>Timeline</h3>
      {#if activityItems.length === 0}
        <p class="muted">No activity yet.</p>
      {:else}
        <ul>
          {#each activityItems as item}
            <li>
              <strong>{item.summary}</strong>
              <span>{formatTime(item)}</span>
              {#if item.actorName}
                <span class="muted">{item.actorName}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>

  {#if record.outcomes && record.outcomes.length > 0}
    <section class="card">
      <h3>Outcomes</h3>
      <ul class="outcomes">
        {#each record.outcomes as outcome}
          <li>{outcome}</li>
        {/each}
      </ul>
    </section>
  {/if}
</section>

<style>
  .detail {
    display: grid;
    gap: 1rem;
  }

  .hero,
  .card {
    padding: 1.15rem;
    border-radius: 1.25rem;
    border: 1px solid rgba(29, 53, 87, 0.12);
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(240, 244, 248, 0.96)),
      radial-gradient(circle at top right, rgba(42, 157, 143, 0.16), transparent 52%);
  }

  .hero {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: start;
  }

  .eyebrow {
    display: inline-block;
    margin-bottom: 0.5rem;
    color: #0f766e;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.74rem;
  }

  h2,
  h3,
  p,
  ul {
    margin: 0;
  }

  .owner,
  .muted {
    color: #64748b;
  }

  .hero-actions,
  .stage-row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .detail :global(button) {
    padding: 0.6rem 0.85rem;
    border-radius: 999px;
    border: 1px solid rgba(29, 53, 87, 0.16);
    background: rgba(255, 255, 255, 0.82);
    color: #1d3557;
  }

  .detail :global(button.primary),
  .stage-row :global(button.active) {
    background: #1d3557;
    color: white;
  }

  .card-head {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: baseline;
  }

  .next-action,
  .outcome {
    margin-top: 0.75rem;
    color: #334155;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: 1rem;
  }

  ul {
    display: grid;
    gap: 0.75rem;
    list-style: none;
    padding: 0;
    margin-top: 0.75rem;
  }

  li {
    display: grid;
    gap: 0.15rem;
  }

  .outcomes {
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  }

  @media (max-width: 720px) {
    .hero {
      flex-direction: column;
    }
  }
</style>
