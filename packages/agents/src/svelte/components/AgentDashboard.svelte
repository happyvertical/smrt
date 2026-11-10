<script lang="ts">
/**
 * AgentDashboard - Combined overview panel for agent schedules
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button, Card } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import type { AgentRunHistoryEntry, AgentScheduleData } from '../types.js';
import AgentRunHistory from './AgentRunHistory.svelte';
import AgentScheduleList from './AgentScheduleList.svelte';

const { t } = useI18n();

export interface Props {
  /** All schedules */
  schedules: AgentScheduleData[];
  /** Recent run history */
  recentHistory?: AgentRunHistoryEntry[];
  /** Loading state */
  loading?: boolean;
  /** Callbacks */
  onScheduleClick?: (schedule: AgentScheduleData) => void;
  /** Fired when a schedule is enabled. */
  onEnable?: (schedule: AgentScheduleData) => void;
  /** Fired when a schedule is disabled. */
  onDisable?: (schedule: AgentScheduleData) => void;
  /** Fired when a schedule is deleted. */
  onDelete?: (schedule: AgentScheduleData) => void;
  /** Fired when a schedule is run immediately. */
  onRunNow?: (schedule: AgentScheduleData) => void;
  /** Fired when the user clicks to create a new schedule. */
  onCreateSchedule?: () => void;
  /** Fired when a run history entry is clicked. */
  onHistoryEntryClick?: (entry: AgentRunHistoryEntry) => void;
}

let {
  schedules = [],
  recentHistory = [],
  loading = false,
  onScheduleClick,
  onEnable,
  onDisable,
  onDelete,
  onRunNow,
  onCreateSchedule,
  onHistoryEntryClick,
}: Props = $props();

// Computed stats
const stats = $derived.by(() => {
  const active = schedules.filter((s) => s.status === 'active').length;
  const paused = schedules.filter((s) => s.status === 'paused').length;
  const disabled = schedules.filter((s) => s.status === 'disabled').length;
  const error = schedules.filter((s) => s.status === 'error').length;
  const running = schedules.reduce((sum, s) => sum + s.runningCount, 0);
  const totalRuns = schedules.reduce((sum, s) => sum + s.runCount, 0);
  const totalSuccesses = schedules.reduce((sum, s) => sum + s.successCount, 0);
  const successRate = totalRuns > 0 ? totalSuccesses / totalRuns : null;

  return { active, paused, disabled, error, running, totalRuns, successRate };
});
</script>

<div class="smrt-agent-dashboard__root" class:smrt-agent-dashboard__loading={loading} data-smrt-component="AgentDashboard">
  <!-- Stats Overview -->
  <section class="smrt-agent-dashboard__stats" data-smrt-part="stats">
    <div class="smrt-agent-dashboard__grid" data-smrt-part="grid">
      <Card padding="sm">
        <div class="smrt-agent-dashboard__card" data-smrt-part="card">
          <div class="smrt-agent-dashboard__stat-value" data-smrt-part="value">{schedules.length}</div>
          <div class="smrt-agent-dashboard__stat-label" data-smrt-part="label">{t(M['agents.dashboard.total_schedules'])}</div>
        </div>
      </Card>

      <Card padding="sm">
        <div class="smrt-agent-dashboard__card smrt-agent-dashboard__card-active" data-smrt-part="card">
          <div class="smrt-agent-dashboard__stat-value" data-smrt-part="value">{stats.active}</div>
          <div class="smrt-agent-dashboard__stat-label" data-smrt-part="label">Active</div>
        </div>
      </Card>

      <Card padding="sm">
        <div class="smrt-agent-dashboard__card smrt-agent-dashboard__card-running" data-smrt-part="card">
          <div class="smrt-agent-dashboard__stat-value" data-smrt-part="value">{stats.running}</div>
          <div class="smrt-agent-dashboard__stat-label" data-smrt-part="label">{t(M['agents.dashboard.running_now'])}</div>
        </div>
      </Card>

      <Card padding="sm">
        <div class="smrt-agent-dashboard__card" data-smrt-part="card">
          <div class="smrt-agent-dashboard__stat-value" data-smrt-part="value">{stats.totalRuns.toLocaleString()}</div>
          <div class="smrt-agent-dashboard__stat-label" data-smrt-part="label">{t(M['agents.dashboard.total_runs'])}</div>
        </div>
      </Card>

      <Card padding="sm">
        <div class="smrt-agent-dashboard__card" data-smrt-part="card">
          <div class="smrt-agent-dashboard__stat-value" data-smrt-part="value">
            {stats.successRate !== null
              ? `${(stats.successRate * 100).toFixed(1)}%`
              : '-'}
          </div>
          <div class="smrt-agent-dashboard__stat-label" data-smrt-part="label">{t(M['agents.dashboard.success_rate'])}</div>
        </div>
      </Card>

      {#if stats.error > 0}
        <Card padding="sm">
          <div class="smrt-agent-dashboard__card smrt-agent-dashboard__card-error" data-smrt-part="card">
            <div class="smrt-agent-dashboard__stat-value" data-smrt-part="value">{stats.error}</div>
            <div class="smrt-agent-dashboard__stat-label" data-smrt-part="label">Errors</div>
          </div>
        </Card>
      {/if}
    </div>
  </section>

  <!-- Schedules List -->
  <section class="smrt-agent-dashboard__section" data-smrt-part="section">
    <Card>
      {#snippet header()}
        <div class="smrt-agent-dashboard__header" data-smrt-part="header">
          <h2>{t(M['agents.dashboard.scheduled_agents'])}</h2>
          {#if onCreateSchedule}
            <Button variant="primary" size="sm" onclick={onCreateSchedule}>
              {t(M['agents.dashboard.new_schedule'])}
            </Button>
          {/if}
        </div>
      {/snippet}

      <AgentScheduleList
        {schedules}
        {loading}
        {onScheduleClick}
        {onEnable}
        {onDisable}
        {onRunNow}
      >
        {#snippet empty()}
          <div class="smrt-agent-dashboard__empty" data-smrt-part="empty">
            <p>{t(M['agents.dashboard.no_scheduled_agents'])}</p>
            {#if onCreateSchedule}
              <Button variant="secondary" onclick={onCreateSchedule}>
                {t(M['agents.dashboard.create_first_schedule'])}
              </Button>
            {/if}
          </div>
        {/snippet}
      </AgentScheduleList>
    </Card>
  </section>

  <!-- Recent Run History -->
  {#if recentHistory.length > 0}
    <section class="smrt-agent-dashboard__section" data-smrt-part="section">
      <Card>
        {#snippet header()}
          <div class="smrt-agent-dashboard__header" data-smrt-part="header">
            <h2>{t(M['agents.dashboard.recent_runs'])}</h2>
          </div>
        {/snippet}

        <AgentRunHistory
          history={recentHistory}
          {loading}
          onEntryClick={onHistoryEntryClick}
        />
      </Card>
    </section>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-agent-dashboard__root {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-lg, 1.5rem);
  }
  .smrt-agent-dashboard__stats {
    width: 100%;
  }
  .smrt-agent-dashboard__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: var(--smrt-spacing-md, 1rem);
  }
  .smrt-agent-dashboard__card {
    padding: var(--smrt-spacing-xs, 0.25rem);
  }
  .smrt-agent-dashboard__stat-label {
    margin-top: var(--smrt-spacing-xs, 0.25rem);
  }
  .smrt-agent-dashboard__section {
    width: 100%;
  }
  .smrt-agent-dashboard__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .smrt-agent-dashboard__header h2 {
    margin: 0;
  }
  .smrt-agent-dashboard__empty {
    padding: var(--smrt-spacing-lg, 1.5rem);
  }
  .smrt-agent-dashboard__empty p {
    margin: 0 0 var(--smrt-spacing-md, 1rem) 0;
  }
  .smrt-agent-dashboard__root.smrt-agent-dashboard__loading {
    pointer-events: none;
  }
}

@layer smrt.theme {
  .smrt-agent-dashboard__root.smrt-agent-dashboard__loading {
    opacity: 0.7;
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-agent-dashboard__root.smrt-agent-dashboard__loading {
      transition: none;
    }
  }
  .smrt-agent-dashboard__card {
    text-align: center;
  }
  .smrt-agent-dashboard__stat-value {
    font: var(--smrt-typography-headline-small-font, 700 1.5rem / 1.2 sans-serif);
  }
  .smrt-agent-dashboard__stat-label {
    font: var(--smrt-typography-body-small-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-agent-dashboard__card-active .smrt-agent-dashboard__stat-value {
    color: var(--smrt-color-tertiary);
  }
  .smrt-agent-dashboard__card-running .smrt-agent-dashboard__stat-value {
    color: var(--smrt-color-primary);
  }
  .smrt-agent-dashboard__card-error .smrt-agent-dashboard__stat-value {
    color: var(--smrt-color-error);
  }
  .smrt-agent-dashboard__header h2 {
    font: var(--smrt-typography-title-medium-font, 600 1rem / 1.5 sans-serif);
  }
  .smrt-agent-dashboard__empty {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
