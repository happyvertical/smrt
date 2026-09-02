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
  <p class="target-list-empty">{emptyMessage}</p>
{:else}
  <ul class="target-list">
    {#each targets as target (target.id)}
      <li class="target-list-row">
        <span class="target-list-main">
          <span class="target-list-type">
            {humanizeStatus(target.targetType)}
            {#if target.cycle > 0}
              <span class="target-list-cycle">cycle {target.cycle}</span>
            {/if}
          </span>
          {#if target.dueAt}
            <span class="target-list-due">due {formatDue(target.dueAt)}</span>
          {/if}
        </span>
        <span class="target-list-meta">
          {#if target.paused}
            <span class="target-list-paused">paused</span>
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
  .target-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .target-list-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .target-list-main {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .target-list-type {
    font-weight: 500;
    text-transform: capitalize;
  }

  .target-list-cycle {
    font-size: 0.75rem;
    font-weight: 400;
    text-transform: none;
    color: var(--smrt-color-on-surface-variant, inherit);
    margin-left: 0.375rem;
  }

  .target-list-due,
  .target-list-paused {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .target-list-paused {
    font-style: italic;
  }

  .target-list-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .target-list-empty {
    color: var(--smrt-color-on-surface-variant, inherit);
    padding: 1rem 0;
  }
</style>
