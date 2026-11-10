<script lang="ts">
/**
 * AgentScheduleList - Display a list of scheduled agents
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import { M } from '../i18n.js';
import type { AgentScheduleData } from '../types.js';
import {
  calculateSuccessRate,
  formatCronExpression,
  formatRelativeTime,
} from '../types.js';
import ScheduleStatusBadge from './ScheduleStatusBadge.svelte';

const { t } = useI18n();

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

<div class="smrt-agent-schedule-list__root" data-smrt-component="AgentScheduleList">
  <table class="smrt-agent-schedule-list__table" data-smrt-part="table" class:smrt-agent-schedule-list__loading={loading}>
    <thead class="smrt-agent-schedule-list__head" data-smrt-part="header">
      <tr>
        <th class="smrt-agent-schedule-list__cell" data-smrt-part="cell">Status</th>
        <th class="smrt-agent-schedule-list__cell" data-smrt-part="cell">Agent</th>
        <th class="smrt-agent-schedule-list__cell" data-smrt-part="cell">Schedule</th>
        <th class="smrt-agent-schedule-list__cell" data-smrt-part="cell">{t(M['agents.schedule_list.last_run'])}</th>
        <th class="smrt-agent-schedule-list__cell" data-smrt-part="cell">{t(M['agents.schedule_list.next_run'])}</th>
        <th class="smrt-agent-schedule-list__cell" data-smrt-part="cell">{t(M['agents.schedule_list.success_rate'])}</th>
        <th class="smrt-agent-schedule-list__cell" data-smrt-part="cell">Runs</th>
        {#if showActions}
          <th class="smrt-agent-schedule-list__cell" data-smrt-part="cell">Actions</th>
        {/if}
      </tr>
    </thead>

    <tbody class="smrt-agent-schedule-list__body" data-smrt-part="body">
      {#if loading}
        <tr class="smrt-agent-schedule-list__row smrt-agent-schedule-list__row-loading" data-smrt-part="row">
          <td class="smrt-agent-schedule-list__cell smrt-agent-schedule-list__cell-loading" data-smrt-part="cell" colspan="8">
            <div class="smrt-agent-schedule-list__progress" data-smrt-part="progress">
              <span class="smrt-agent-schedule-list__spinner" data-smrt-part="spinner"></span>
              <span>{t(M['agents.schedule_list.loading_schedules'])}</span>
            </div>
          </td>
        </tr>
      {:else if schedules.length === 0}
        <tr class="smrt-agent-schedule-list__row smrt-agent-schedule-list__row-empty" data-smrt-part="row">
          <td class="smrt-agent-schedule-list__cell smrt-agent-schedule-list__cell-empty" data-smrt-part="cell" colspan="8">
            {#if empty}
              {@render empty()}
            {:else}
              <div class="smrt-agent-schedule-list__empty" data-smrt-part="empty">
                <span>{t(M['agents.schedule_list.no_schedules_found'])}</span>
              </div>
            {/if}
          </td>
        </tr>
      {:else}
        {#each schedules as schedule (schedule.id)}
          {@const successRate = calculateSuccessRate(schedule)}
          <tr
            class="smrt-agent-schedule-list__row" data-smrt-part="row"
          >
            <td class="smrt-agent-schedule-list__cell" data-smrt-part="cell">
              <ScheduleStatusBadge status={schedule.status} />
            </td>
            <td class="smrt-agent-schedule-list__cell smrt-agent-schedule-list__cell-agent" data-smrt-part="cell">
              {#if onScheduleClick}
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => handleRowClick(schedule)}
                >
                  {schedule.agentType}
                </Button>
              {:else}
                <span class="smrt-agent-schedule-list__agent-type" data-smrt-part="name">{schedule.agentType}</span>
              {/if}
              {#if schedule.agentId}
                <span class="smrt-agent-schedule-list__agent-id" data-smrt-part="identifier">#{schedule.agentId.slice(0, 8)}</span>
              {/if}
              <span class="smrt-agent-schedule-list__agent-method" data-smrt-part="method">.{schedule.method}()</span>
            </td>
            <td class="smrt-agent-schedule-list__cell smrt-agent-schedule-list__cell-schedule" data-smrt-part="cell">
              <span class="smrt-agent-schedule-list__cron-human" data-smrt-part="label">{formatCronExpression(schedule.cron)}</span>
              <span class="smrt-agent-schedule-list__cron-raw" data-smrt-part="meta">{schedule.cron}</span>
            </td>
            <td class="smrt-agent-schedule-list__cell smrt-agent-schedule-list__cell-date" data-smrt-part="cell">
              <span
                class="smrt-agent-schedule-list__last-run" data-smrt-part="meta"
                class:smrt-agent-schedule-list__success={schedule.lastStatus === 'success'}
                class:smrt-agent-schedule-list__failed={schedule.lastStatus === 'failed'}
              >
                {formatRelativeTime(schedule.lastRun)}
              </span>
            </td>
            <td class="smrt-agent-schedule-list__cell smrt-agent-schedule-list__cell-date" data-smrt-part="cell">
              {formatRelativeTime(schedule.nextRun)}
            </td>
            <td class="smrt-agent-schedule-list__cell smrt-agent-schedule-list__cell-rate" data-smrt-part="cell">
              {#if successRate !== null}
                <span
                  class="smrt-agent-schedule-list__success-rate" data-smrt-part="value"
                  class:smrt-agent-schedule-list__good={successRate >= 0.9}
                  class:smrt-agent-schedule-list__warning={successRate >= 0.7 && successRate < 0.9}
                  class:smrt-agent-schedule-list__bad={successRate < 0.7}
                >
                  {(successRate * 100).toFixed(0)}%
                </span>
              {:else}
                <span class="smrt-agent-schedule-list__success-rate" data-smrt-part="value">-</span>
              {/if}
            </td>
            <td class="smrt-agent-schedule-list__cell smrt-agent-schedule-list__cell-runs" data-smrt-part="cell">
              {schedule.runCount}
              {#if schedule.runningCount > 0}
                <span class="smrt-agent-schedule-list__running-indicator" data-smrt-part="indicator">({schedule.runningCount} running)</span>
              {/if}
            </td>
            {#if showActions}
              <td class="smrt-agent-schedule-list__cell smrt-agent-schedule-list__cell-actions" data-smrt-part="cell">
                <div class="smrt-agent-schedule-list__actions" data-smrt-part="actions">
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
                      {t(M['agents.schedule_list.run_now'])}
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-agent-schedule-list__root {
    width: 100%;
    overflow-x: auto;
  }
  .smrt-agent-schedule-list__table {
    width: 100%;
  }
  .smrt-agent-schedule-list__head th {
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 1rem);
    white-space: nowrap;
  }
  .smrt-agent-schedule-list__cell {
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 1rem);
  }
  .smrt-agent-schedule-list__cell-agent {
    max-width: 250px;
  }
  .smrt-agent-schedule-list__agent-id {
    margin-left: var(--smrt-spacing-xs, 0.25rem);
  }
  .smrt-agent-schedule-list__agent-method {
    margin-left: var(--smrt-spacing-xs, 0.25rem);
  }
  .smrt-agent-schedule-list__cell-schedule {
    max-width: 200px;
  }
  .smrt-agent-schedule-list__cron-human {
    display: block;
  }
  .smrt-agent-schedule-list__cron-raw {
    display: block;
  }
  .smrt-agent-schedule-list__cell-date {
    white-space: nowrap;
  }
  .smrt-agent-schedule-list__cell-actions {
    white-space: nowrap;
  }
  .smrt-agent-schedule-list__actions {
    display: flex;
    gap: var(--smrt-spacing-xs, 0.25rem);
  }
  .smrt-agent-schedule-list__cell-loading,
  .smrt-agent-schedule-list__cell-empty {
    padding: var(--smrt-spacing-xl, 2rem);
  }
  .smrt-agent-schedule-list__progress {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-sm, 0.5rem);
  }
  .smrt-agent-schedule-list__spinner {
    width: 20px;
    height: 20px;
  }
  .smrt-agent-schedule-list__table.smrt-agent-schedule-list__loading {
    pointer-events: none;
  }
}

@layer smrt.theme {
  .smrt-agent-schedule-list__table {
    border-collapse: collapse;
    border-spacing: 0;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    background: var(--smrt-color-surface);
  }
  .smrt-agent-schedule-list__table.smrt-agent-schedule-list__loading {
    opacity: 0.7;
  }
  .smrt-agent-schedule-list__head {
    background: var(--smrt-color-surface-container);
  }
  .smrt-agent-schedule-list__head th {
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-align: left;
    border-bottom: var(--smrt-hairline);
  }
  .smrt-agent-schedule-list__body tr {
    border-bottom: var(--smrt-hairline);
    transition: background-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-agent-schedule-list__body tr:hover:not(.smrt-agent-schedule-list__row-loading):not(.smrt-agent-schedule-list__row-empty) {
    background: var(--smrt-color-surface-container-low);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-agent-schedule-list__body tr {
      transition: none;
    }
    .smrt-agent-schedule-list__spinner {
      animation: none;
    }
  }
  .smrt-agent-schedule-list__cell {
    vertical-align: middle;
  }
  .smrt-agent-schedule-list__agent-type {
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-agent-schedule-list__agent-id {
    color: var(--smrt-color-on-surface-variant);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
  }
  .smrt-agent-schedule-list__agent-method {
    color: var(--smrt-color-on-surface-variant);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
  }
  .smrt-agent-schedule-list__cron-human {
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-agent-schedule-list__cron-raw {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-agent-schedule-list__cell-date {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-agent-schedule-list__last-run.smrt-agent-schedule-list__success {
    color: var(--smrt-color-tertiary);
  }
  .smrt-agent-schedule-list__last-run.smrt-agent-schedule-list__failed {
    color: var(--smrt-color-error);
  }
  .smrt-agent-schedule-list__cell-rate {
    text-align: center;
  }
  .smrt-agent-schedule-list__success-rate {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-agent-schedule-list__success-rate.smrt-agent-schedule-list__good {
    color: var(--smrt-color-tertiary);
  }
  .smrt-agent-schedule-list__success-rate.smrt-agent-schedule-list__warning {
    color: var(--smrt-color-secondary);
  }
  .smrt-agent-schedule-list__success-rate.smrt-agent-schedule-list__bad {
    color: var(--smrt-color-error);
  }
  .smrt-agent-schedule-list__cell-runs {
    text-align: center;
    font-family: var(--smrt-font-family-mono, monospace);
  }
  .smrt-agent-schedule-list__running-indicator {
    color: var(--smrt-color-primary);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
  }
  .smrt-agent-schedule-list__cell-loading,
  .smrt-agent-schedule-list__cell-empty {
    text-align: center;
  }
  .smrt-agent-schedule-list__progress {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-agent-schedule-list__spinner {
    border: 2px solid var(--smrt-color-outline-variant);
    border-top-color: var(--smrt-color-primary);
    border-radius: var(--smrt-radius-full);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .smrt-agent-schedule-list__empty {
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
