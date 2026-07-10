<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import type { SalesLeadListItem } from '../types.js';

export interface Props {
  leads: SalesLeadListItem[];
  loading?: boolean;
  emptyMessage?: string;
  onselect?: (lead: SalesLeadListItem) => void;
  onassign?: (lead: SalesLeadListItem) => void;
  onqualify?: (lead: SalesLeadListItem) => void;
}

const {
  leads,
  loading = false,
  emptyMessage = 'No leads in this queue.',
  onselect,
  onassign,
  onqualify,
}: Props = $props();

function cardClass(status: string): string {
  if (status === 'qualified') return 'lead-card lead-qualified';
  if (status === 'converted') return 'lead-card lead-converted';
  if (status === 'merged') return 'lead-card lead-merged';
  return 'lead-card';
}
</script>

<section class="lead-list" aria-label="Lead list">
  {#if loading}
    <p class="state-message">Loading leads...</p>
  {:else if leads.length === 0}
    <p class="state-message">{emptyMessage}</p>
  {:else}
    {#each leads as lead (lead.id)}
      <article class={cardClass(lead.status)}>
        <Button class="lead-main" type="button" onclick={() => onselect?.(lead)}>
          <span class="lead-status">{lead.status}</span>
          <strong>{lead.name}</strong>
          {#if lead.organization}
            <span>{lead.organization}</span>
          {/if}
          {#if lead.email}
            <span class="secondary">{lead.email}</span>
          {/if}
          <span class="secondary">
            {lead.ownerName ? `Assigned to ${lead.ownerName}` : 'Unassigned'}
          </span>
          {#if lead.qualificationSummary}
            <span class="qualification">{lead.qualificationSummary}</span>
          {/if}
        </Button>
        <div class="actions">
          <Button type="button" class="action-button" onclick={() => onassign?.(lead)}>
            Assign
          </Button>
          <Button
            type="button"
            class="action-button action-primary"
            onclick={() => onqualify?.(lead)}
            disabled={lead.status === 'qualified' || lead.status === 'converted'}
          >
            Qualify
          </Button>
        </div>
      </article>
    {/each}
  {/if}
</section>

<style>
  .lead-list {
    display: grid;
    gap: 1rem;
  }

  .lead-card {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.75rem;
    padding: 1rem;
    border-radius: 1rem;
    border: 1px solid color-mix(in srgb, #1d3557 14%, white);
    background:
      linear-gradient(140deg, rgba(248, 250, 252, 0.98), rgba(235, 241, 248, 0.88)),
      radial-gradient(circle at top left, rgba(29, 53, 87, 0.12), transparent 55%);
    box-shadow: 0 18px 36px rgba(15, 23, 42, 0.08);
  }

  .lead-qualified {
    border-color: rgba(56, 161, 105, 0.35);
  }

  .lead-converted {
    border-color: rgba(37, 99, 235, 0.35);
  }

  .lead-merged {
    opacity: 0.8;
  }

  .lead-main {
    display: grid;
    gap: 0.25rem;
    padding: 0;
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
    color: inherit;
  }

  .lead-status {
    width: fit-content;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    background: rgba(29, 53, 87, 0.08);
    color: #1d3557;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .secondary {
    color: #52606d;
    font-size: 0.92rem;
  }

  .qualification {
    color: #0f766e;
    font-size: 0.92rem;
  }

  .actions {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.5rem;
  }

  .action-button {
    min-width: 7rem;
    padding: 0.6rem 0.85rem;
    border-radius: 999px;
    border: 1px solid rgba(29, 53, 87, 0.18);
    background: rgba(255, 255, 255, 0.78);
    color: #1d3557;
  }

  .action-primary {
    background: #1d3557;
    color: white;
  }

  .state-message {
    padding: 2rem 1rem;
    border-radius: 1rem;
    text-align: center;
    color: #52606d;
    background: rgba(241, 245, 249, 0.9);
  }

  @media (max-width: 720px) {
    .lead-card {
      grid-template-columns: 1fr;
    }

    .actions {
      flex-direction: row;
      justify-content: stretch;
    }

    .action-button {
      flex: 1 1 auto;
    }
  }
</style>
