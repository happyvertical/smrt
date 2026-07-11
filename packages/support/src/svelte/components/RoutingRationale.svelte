<script lang="ts">
/**
 * RoutingRationale — the explainable routing ranking for a case (issue
 * #1929): each specialist's score, eligibility, and the factor signals
 * behind them, with an optional manual-reassign action per row.
 * Presentational: the host runs `SupportRoutingService.rankSpecialists`
 * (and gates reassignment with `support.reassign-case`).
 */

import { Button, StatusBadge } from '@happyvertical/smrt-ui';
import type { RankedSpecialistView } from '../types.js';

export interface RoutingRationaleProps {
  ranking: RankedSpecialistView[];
  /** When provided, each row shows a reassign action. */
  onreassign?: (specialistId: string) => void;
  emptyMessage?: string;
}

const {
  ranking,
  onreassign,
  emptyMessage = 'No specialists to rank',
}: RoutingRationaleProps = $props();

function factorChips(
  factors: Record<string, number | string | boolean>,
): string[] {
  return Object.entries(factors).map(([key, value]) =>
    value === true ? key : `${key}: ${value}`,
  );
}
</script>

{#if ranking.length === 0}
  <p class="routing-rationale-empty">{emptyMessage}</p>
{:else}
  <ul class="routing-rationale">
    {#each ranking as entry (entry.specialistId)}
      <li class="routing-rationale-row">
        <span class="routing-rationale-main">
          <span class="routing-rationale-head">
            <span class="routing-rationale-name">{entry.displayName}</span>
            <span class="routing-rationale-score">score {entry.score}</span>
            <StatusBadge
              status={entry.eligible ? 'success' : 'inactive'}
              label={entry.eligible ? 'eligible' : 'ineligible'}
              size="sm"
            />
          </span>
          <span class="routing-rationale-factors">
            {#each factorChips(entry.factors) as chip (chip)}
              <span class="routing-rationale-factor">{chip}</span>
            {/each}
          </span>
        </span>
        {#if onreassign}
          <Button
            variant="secondary"
            size="sm"
            onclick={() => onreassign?.(entry.specialistId)}
            aria-label={`Reassign to ${entry.displayName}`}
          >
            Reassign
          </Button>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .routing-rationale {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .routing-rationale-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .routing-rationale-main {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .routing-rationale-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .routing-rationale-name {
    font-weight: 500;
  }

  .routing-rationale-score {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .routing-rationale-factors {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .routing-rationale-factor {
    font-size: 0.6875rem;
    padding: 0.0625rem 0.375rem;
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container-highest, transparent);
    color: var(--smrt-color-on-surface-variant, inherit);
    border: 1px solid var(--smrt-color-outline-variant, currentColor);
  }

  .routing-rationale-empty {
    color: var(--smrt-color-on-surface-variant, inherit);
    padding: 1rem 0;
  }
</style>
