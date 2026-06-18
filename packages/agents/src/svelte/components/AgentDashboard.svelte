<script lang="ts">
/**
 * AgentDashboard - Combined overview panel for agent schedules
 */

import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import { Button, Card } from '@happyvertical/smrt-svelte/ui';
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
  onEnable?: (schedule: AgentScheduleData) => void;
  onDisable?: (schedule: AgentScheduleData) => void;
  onDelete?: (schedule: AgentScheduleData) => void;
  onRunNow?: (schedule: AgentScheduleData) => void;
  onCreateSchedule?: () => void;
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

<div class="agent-dashboard" class:loading>
  <!-- Stats Overview -->
  <section class="agent-dashboard__stats">
    <div class="stats-grid">
      <Card padding="sm">
        <div class="stat-card">
          <div class="stat-card__value">{schedules.length}</div>
          <div class="stat-card__label">{t(M['agents.dashboard.total_schedules'])}</div>
        </div>
      </Card>

      <Card padding="sm">
        <div class="stat-card stat-card--active">
          <div class="stat-card__value">{stats.active}</div>
          <div class="stat-card__label">Active</div>
        </div>
      </Card>

      <Card padding="sm">
        <div class="stat-card stat-card--running">
          <div class="stat-card__value">{stats.running}</div>
          <div class="stat-card__label">{t(M['agents.dashboard.running_now'])}</div>
        </div>
      </Card>

      <Card padding="sm">
        <div class="stat-card">
          <div class="stat-card__value">{stats.totalRuns.toLocaleString()}</div>
          <div class="stat-card__label">{t(M['agents.dashboard.total_runs'])}</div>
        </div>
      </Card>

      <Card padding="sm">
        <div class="stat-card">
          <div class="stat-card__value">
            {stats.successRate !== null
              ? `${(stats.successRate * 100).toFixed(1)}%`
              : '-'}
          </div>
          <div class="stat-card__label">{t(M['agents.dashboard.success_rate'])}</div>
        </div>
      </Card>

      {#if stats.error > 0}
        <Card padding="sm">
          <div class="stat-card stat-card--error">
            <div class="stat-card__value">{stats.error}</div>
            <div class="stat-card__label">Errors</div>
          </div>
        </Card>
      {/if}
    </div>
  </section>

  <!-- Schedules List -->
  <section class="agent-dashboard__section">
    <Card>
      {#snippet header()}
        <div class="panel-header">
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
          <div class="empty-state">
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
    <section class="agent-dashboard__section">
      <Card>
        {#snippet header()}
          <div class="panel-header">
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
  .agent-dashboard {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-lg, 1.5rem);
  }

  .agent-dashboard.loading {
    opacity: 0.7;
    pointer-events: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .agent-dashboard.loading {
      transition: none;
    }
  }

  .agent-dashboard__stats {
    width: 100%;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: var(--smrt-spacing-md, 1rem);
  }

  .stat-card {
    text-align: center;
    padding: var(--smrt-spacing-xs, 0.25rem);
  }

  .stat-card__value {
    font: var(--smrt-typography-headline-small-font, 700 1.5rem / 1.2 sans-serif);
  }

  .stat-card__label {
    font: var(--smrt-typography-body-small-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    margin-top: var(--smrt-spacing-xs, 0.25rem);
  }

  .stat-card--active .stat-card__value {
    color: var(--smrt-color-tertiary, #006c4f);
  }

  .stat-card--running .stat-card__value {
    color: var(--smrt-color-primary, #005ac1);
  }

  .stat-card--error .stat-card__value {
    color: var(--smrt-color-error, #ba1a1a);
  }

  .agent-dashboard__section {
    width: 100%;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .panel-header h2 {
    margin: 0;
    font: var(--smrt-typography-title-medium-font, 600 1rem / 1.5 sans-serif);
  }

  .empty-state {
    padding: var(--smrt-spacing-lg, 1.5rem);
    text-align: center;
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .empty-state p {
    margin: 0 0 var(--smrt-spacing-md, 1rem) 0;
  }
</style>
