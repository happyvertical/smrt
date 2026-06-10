<script lang="ts">
/**
 * AgentScheduleList - Display a list of scheduled agents
 */

import { Button } from '@happyvertical/smrt-svelte/ui';
import type { Snippet } from 'svelte';
import type { AgentScheduleData } from '../types.js';
import {
  calculateSuccessRate,
  formatCronExpression,
  formatRelativeTime,
} from '../types.js';
import ScheduleStatusBadge from './ScheduleStatusBadge.svelte';

export interface Props {
  /** Schedules to display */
  schedules: AgentScheduleData[];
  /** Loading state */
  loading?: boolean;
  /** Show actions column */
  showActions?: boolean;
  /** Callback when schedule is clicked */
  onScheduleClick?: (schedule: AgentScheduleData) => void;
  /** Callback when enable is clicked */
  onEnable?: (schedule: AgentScheduleData) => void;
  /** Callback when disable is clicked */
  onDisable?: (schedule: AgentScheduleData) => void;
  /** Callback when run now is clicked */
  onRunNow?: (schedule: AgentScheduleData) => void;
  /** Empty state snippet */
  empty?: Snippet;
}

let {
  schedules = [],
  loading = false,
  showActions = true,
  onScheduleClick,
  onEnable,
  onDisable,
  onRunNow,
  empty,
}: Props = $props();

function handleRowClick(schedule: AgentScheduleData) {
  onScheduleClick?.(schedule);
}

function handleToggle(schedule: AgentScheduleData, event: Event) {
  event.stopPropagation();
  if (schedule.enabled) {
    onDisable?.(schedule);
  } else {
    onEnable?.(schedule);
  }
}

function handleRunNow(schedule: AgentScheduleData, event: Event) {
  event.stopPropagation();
  onRunNow?.(schedule);
}
</script>

<div class="schedule-list-container">
  <table class="schedule-list" class:loading>
    <thead class="schedule-list__head">
      <tr>
        <th class="schedule-list__cell">Status</th>
        <th class="schedule-list__cell">Agent</th>
        <th class="schedule-list__cell">Schedule</th>
        <th class="schedule-list__cell">Last Run</th>
        <th class="schedule-list__cell">Next Run</th>
        <th class="schedule-list__cell">Success Rate</th>
        <th class="schedule-list__cell">Runs</th>
        {#if showActions}
          <th class="schedule-list__cell">Actions</th>
        {/if}
      </tr>
    </thead>

    <tbody class="schedule-list__body">
      {#if loading}
        <tr class="schedule-list__row schedule-list__row--loading">
          <td class="schedule-list__cell schedule-list__cell--loading" colspan="8">
            <div class="schedule-list__loading">
              <span class="schedule-list__spinner"></span>
              <span>Loading schedules...</span>
            </div>
          </td>
        </tr>
      {:else if schedules.length === 0}
        <tr class="schedule-list__row schedule-list__row--empty">
          <td class="schedule-list__cell schedule-list__cell--empty" colspan="8">
            {#if empty}
              {@render empty()}
            {:else}
              <div class="schedule-list__empty">
                <span>No schedules found</span>
              </div>
            {/if}
          </td>
        </tr>
      {:else}
        {#each schedules as schedule (schedule.id)}
          {@const successRate = calculateSuccessRate(schedule)}
          <tr
            class="schedule-list__row"
            onclick={() => handleRowClick(schedule)}
            role={onScheduleClick ? 'button' : undefined}
            tabindex={onScheduleClick ? 0 : undefined}
          >
            <td class="schedule-list__cell">
              <ScheduleStatusBadge status={schedule.status} />
            </td>
            <td class="schedule-list__cell schedule-list__cell--agent">
              <span class="agent-type">{schedule.agentType}</span>
              {#if schedule.agentId}
                <span class="agent-id">#{schedule.agentId.slice(0, 8)}</span>
              {/if}
              <span class="agent-method">.{schedule.method}()</span>
            </td>
            <td class="schedule-list__cell schedule-list__cell--schedule">
              <span class="cron-human">{formatCronExpression(schedule.cron)}</span>
              <span class="cron-raw">{schedule.cron}</span>
            </td>
            <td class="schedule-list__cell schedule-list__cell--date">
              <span
                class="last-run"
                class:success={schedule.lastStatus === 'success'}
                class:failed={schedule.lastStatus === 'failed'}
              >
                {formatRelativeTime(schedule.lastRun)}
              </span>
            </td>
            <td class="schedule-list__cell schedule-list__cell--date">
              {formatRelativeTime(schedule.nextRun)}
            </td>
            <td class="schedule-list__cell schedule-list__cell--rate">
              {#if successRate !== null}
                <span
                  class="success-rate"
                  class:good={successRate >= 0.9}
                  class:warning={successRate >= 0.7 && successRate < 0.9}
                  class:bad={successRate < 0.7}
                >
                  {(successRate * 100).toFixed(0)}%
                </span>
              {:else}
                <span class="success-rate">-</span>
              {/if}
            </td>
            <td class="schedule-list__cell schedule-list__cell--runs">
              {schedule.runCount}
              {#if schedule.runningCount > 0}
                <span class="running-indicator">({schedule.runningCount} running)</span>
              {/if}
            </td>
            {#if showActions}
              <td class="schedule-list__cell schedule-list__cell--actions">
                <div class="actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    onclick={(event: MouseEvent) => handleToggle(schedule, event)}
                  >
                    {schedule.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  {#if schedule.enabled && schedule.status === 'active'}
                    <Button
                      variant="secondary"
                      size="sm"
                      onclick={(event: MouseEvent) => handleRunNow(schedule, event)}
                    >
                      Run Now
                    </Button>
                  {/if}
                </div>
              </td>
            {/if}
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>

<style>
  .schedule-list-container {
    width: 100%;
    overflow-x: auto;
  }

  .schedule-list {
    width: 100%;
    border-collapse: collapse;
    border-spacing: 0;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    background: var(--smrt-color-surface, #ffffff);
  }

  .schedule-list.loading {
    opacity: 0.7;
    pointer-events: none;
  }

  .schedule-list__head {
    background: var(--smrt-color-surface-container, #f3f4f6);
  }

  .schedule-list__head th {
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 1rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-align: left;
    white-space: nowrap;
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
  }

  .schedule-list__body tr {
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    transition: background-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .schedule-list__body tr:hover:not(.schedule-list__row--loading):not(.schedule-list__row--empty) {
    background: var(--smrt-color-surface-container-low, #f9fafb);
    cursor: pointer;
  }

  @media (prefers-reduced-motion: reduce) {
    .schedule-list__body tr {
      transition: none;
    }
    
    .schedule-list__spinner {
      animation: none;
    }
  }

  .schedule-list__cell {
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 1rem);
    vertical-align: middle;
  }

  .schedule-list__cell--agent {
    max-width: 250px;
  }

  .agent-type {
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .agent-id {
    margin-left: var(--smrt-spacing-xs, 0.25rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
  }

  .agent-method {
    margin-left: var(--smrt-spacing-xs, 0.25rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
  }

  .schedule-list__cell--schedule {
    max-width: 200px;
  }

  .cron-human {
    display: block;
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .cron-raw {
    display: block;
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .schedule-list__cell--date {
    color: var(--smrt-color-on-surface-variant, #43474e);
    white-space: nowrap;
  }

  .last-run.success {
    color: var(--smrt-color-tertiary, #006c4f);
  }

  .last-run.failed {
    color: var(--smrt-color-error, #ba1a1a);
  }

  .schedule-list__cell--rate {
    text-align: center;
  }

  .success-rate {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .success-rate.good {
    color: var(--smrt-color-tertiary, #006c4f);
  }

  .success-rate.warning {
    color: var(--smrt-color-secondary, #00639b);
  }

  .success-rate.bad {
    color: var(--smrt-color-error, #ba1a1a);
  }

  .schedule-list__cell--runs {
    text-align: center;
    font-family: var(--smrt-font-family-mono, monospace);
  }

  .running-indicator {
    color: var(--color-primary, #3b82f6);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
  }

  .schedule-list__cell--actions {
    white-space: nowrap;
  }

  .actions {
    display: flex;
    gap: var(--spacing-xs, 0.25rem);
  }

  .schedule-list__cell--loading,
  .schedule-list__cell--empty {
    padding: var(--spacing-xl, 2rem);
    text-align: center;
  }

  .schedule-list__loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--spacing-sm, 0.5rem);
    color: var(--color-text-secondary, #6b7280);
  }

  .schedule-list__spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--color-neutral-gray200, #e5e7eb);
    border-top-color: var(--color-primary, #3b82f6);
    border-radius: var(--smrt-radius-full, 9999px);
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .schedule-list__empty {
    color: var(--color-text-secondary, #6b7280);
  }
</style>
