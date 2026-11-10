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
  /** Array of ranked specialists with scores and eligibility factors. */
  ranking: RankedSpecialistView[];
  /** When provided, each row shows a reassign action. */
  onreassign?: (specialistId: string) => void;
  /** Message displayed when there are no specialists to rank. */
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
  <p class="smrt-routing-rationale__empty" data-smrt-component="RoutingRationale" >{emptyMessage}</p>
{:else}
  <ul class="smrt-routing-rationale__root" data-smrt-component="RoutingRationale">
    {#each ranking as entry (entry.specialistId)}
      <li class="smrt-routing-rationale__row" data-smrt-part="row">
        <span class="smrt-routing-rationale__main" data-smrt-part="body">
          <span class="smrt-routing-rationale__head" data-smrt-part="header">
            <span class="smrt-routing-rationale__name" data-smrt-part="title">{entry.displayName}</span>
            <span class="smrt-routing-rationale__score" data-smrt-part="value">score {entry.score}</span>
            <StatusBadge
              status={entry.eligible ? 'success' : 'inactive'}
              label={entry.eligible ? 'eligible' : 'ineligible'}
              size="sm"
            />
          </span>
          <span class="smrt-routing-rationale__factors" data-smrt-part="list">
            {#each factorChips(entry.factors) as chip (chip)}
              <span class="smrt-routing-rationale__factor" data-smrt-part="badge">{chip}</span>
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-routing-rationale__root {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .smrt-routing-rationale__row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .smrt-routing-rationale__main {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }
  .smrt-routing-rationale__head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .smrt-routing-rationale__factors {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .smrt-routing-rationale__factor {
    padding: 0.0625rem 0.375rem;
  }
  .smrt-routing-rationale__empty {
    padding: 1rem 0;
  }
}

@layer smrt.theme {
  .smrt-routing-rationale__name {
    font-weight: 500;
  }
  .smrt-routing-rationale__score {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-routing-rationale__factor {
    font-size: 0.6875rem;
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container-highest, transparent);
    color: var(--smrt-color-on-surface-variant, inherit);
    border: var(--smrt-hairline);
  }
  .smrt-routing-rationale__empty {
    color: var(--smrt-color-on-surface-variant, inherit);
  }
}

</style>
