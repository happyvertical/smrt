<script lang="ts">
/**
 * TargetList — Service Target clocks on a case at a glance (issue #1929):
 * target type, due time, clock status, and a paused indicator per row.
 * Presentational: the host loads targets and adapts them with
 * `toServiceTargetView`.
 */

import { StatusBadge } from '@happyvertical/smrt-ui';
import {
  humanizeStatus,
  type ServiceTargetView,
  targetStatusBadgeKey,
} from '../types.js';

export interface TargetListProps {
  /** Array of service targets showing status and due times. */
  targets: ServiceTargetView[];
  /** Message displayed when the target list is empty. */
  emptyMessage?: string;
}

const { targets, emptyMessage = 'No service targets' }: TargetListProps =
  $props();

function formatDue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
</script>

{#if targets.length === 0}
  <p class="smrt-target-list__empty" data-smrt-component="TargetList" data-smrt-part="empty">{emptyMessage}</p>
{:else}
  <ul class="smrt-target-list__root" data-smrt-component="TargetList">
    {#each targets as target (target.id)}
      <li class="smrt-target-list__row" data-smrt-part="row">
        <span class="smrt-target-list__main" data-smrt-part="body">
          <span class="smrt-target-list__type" data-smrt-part="title">
            {humanizeStatus(target.targetType)}
            {#if target.cycle > 0}
              <span class="smrt-target-list__cycle" data-smrt-part="cycle">cycle {target.cycle}</span>
            {/if}
          </span>
          {#if target.dueAt}
            <span class="smrt-target-list__due">due {formatDue(target.dueAt)}</span>
          {/if}
        </span>
        <span class="smrt-target-list__meta" data-smrt-part="meta">
          {#if target.paused}
            <span class="smrt-target-list__paused">paused</span>
          {/if}
          <StatusBadge
            status={targetStatusBadgeKey(target.status)}
            label={humanizeStatus(target.status)}
            size="sm"
          />
        </span>
      </li>
    {/each}
  </ul>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-target-list__root {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .smrt-target-list__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .smrt-target-list__main {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }
  .smrt-target-list__cycle {
    margin-left: 0.375rem;
  }
  .smrt-target-list__meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .smrt-target-list__empty {
    padding: 1rem 0;
  }
}

@layer smrt.theme {
  .smrt-target-list__type {
    font-weight: 500;
    text-transform: capitalize;
  }
  .smrt-target-list__cycle {
    font-size: 0.75rem;
    font-weight: 400;
    text-transform: none;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-target-list__due,
  .smrt-target-list__paused {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-target-list__paused {
    font-style: italic;
  }
  .smrt-target-list__empty {
    color: var(--smrt-color-on-surface-variant, inherit);
  }
}

</style>
