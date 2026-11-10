<script lang="ts">
/**
 * JobStats - Display job statistics overview
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Card } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import type { JobStats as JobStatsData, QueueStats } from './types.js';
import { formatDuration } from './types.js';

const { t } = useI18n();

export interface Props {
  /** Statistics data */
  stats: JobStatsData;
  /** Queue breakdown */
  queues?: QueueStats[];
  /** Loading state */
  loading?: boolean;
  /** Compact mode */
  compact?: boolean;
}

let { stats, queues = [], loading = false, compact = false }: Props = $props();

const successRateFormatted = $derived(
  stats.successRate !== null ? `${(stats.successRate * 100).toFixed(1)}%` : '-',
);
</script>

<div class="smrt-job-stats__root" class:smrt-job-stats__compact={compact} class:smrt-job-stats__loading={loading} data-smrt-component="JobStats">
  <div class="smrt-job-stats__grid" data-smrt-part="grid">
    <!-- Total Jobs -->
    <Card padding="sm">
      <div class="smrt-job-stats__card" data-smrt-part="item">
        <div class="smrt-job-stats__stat-value" data-smrt-part="value">{stats.total.toLocaleString()}</div>
        <div class="smrt-job-stats__stat-label" data-smrt-part="label">{t(M['jobs.job_stats.total_jobs'])}</div>
      </div>
    </Card>

    <!-- Pending -->
    <Card padding="sm">
      <div class="smrt-job-stats__card smrt-job-stats__card-pending" data-smrt-part="item">
        <div class="smrt-job-stats__stat-value" data-smrt-part="value">{stats.pending.toLocaleString()}</div>
        <div class="smrt-job-stats__stat-label" data-smrt-part="label">Pending</div>
      </div>
    </Card>

    <!-- Running -->
    <Card padding="sm">
      <div class="smrt-job-stats__card smrt-job-stats__card-running" data-smrt-part="item">
        <div class="smrt-job-stats__stat-value" data-smrt-part="value">{stats.running.toLocaleString()}</div>
        <div class="smrt-job-stats__stat-label" data-smrt-part="label">Running</div>
      </div>
    </Card>

    <!-- Completed -->
    <Card padding="sm">
      <div class="smrt-job-stats__card smrt-job-stats__card-completed" data-smrt-part="item">
        <div class="smrt-job-stats__stat-value" data-smrt-part="value">{stats.completed.toLocaleString()}</div>
        <div class="smrt-job-stats__stat-label" data-smrt-part="label">Completed</div>
      </div>
    </Card>

    <!-- Failed -->
    <Card padding="sm">
      <div class="smrt-job-stats__card smrt-job-stats__card-failed" data-smrt-part="item">
        <div class="smrt-job-stats__stat-value" data-smrt-part="value">{stats.failed.toLocaleString()}</div>
        <div class="smrt-job-stats__stat-label" data-smrt-part="label">Failed</div>
      </div>
    </Card>

    <!-- Success Rate -->
    <Card padding="sm">
      <div class="smrt-job-stats__card" data-smrt-part="item">
        <div class="smrt-job-stats__stat-value" data-smrt-part="value">{successRateFormatted}</div>
        <div class="smrt-job-stats__stat-label" data-smrt-part="label">{t(M['jobs.job_stats.success_rate'])}</div>
      </div>
    </Card>

    <!-- Avg Duration -->
    <Card padding="sm">
      <div class="smrt-job-stats__card" data-smrt-part="item">
        <div class="smrt-job-stats__stat-value" data-smrt-part="value">{formatDuration(stats.avgDuration)}</div>
        <div class="smrt-job-stats__stat-label" data-smrt-part="label">{t(M['jobs.job_stats.avg_duration'])}</div>
      </div>
    </Card>
  </div>

  {#if queues.length > 0 && !compact}
    <div class="smrt-job-stats__queues" data-smrt-part="group">
      <h3>Queues</h3>
      <div class="smrt-job-stats__queue-list" data-smrt-part="list">
        {#each queues as queue (queue.name)}
          <Card padding="sm">
            <div class="smrt-job-stats__queue-card" data-smrt-part="item">
              <div class="smrt-job-stats__queue-header" data-smrt-part="header">
                <span class="smrt-job-stats__queue-name" data-smrt-part="title">{queue.name}</span>
                <span class="smrt-job-stats__queue-running" data-smrt-part="meta">{queue.running} running</span>
              </div>
              <div class="smrt-job-stats__queue-stats" data-smrt-part="group">
                <div class="smrt-job-stats__queue-stat" data-smrt-part="value">
                  <span class="smrt-job-stats__queue-stat-value" data-smrt-part="value">{queue.pending}</span>
                  <span class="smrt-job-stats__queue-stat-label" data-smrt-part="label">pending</span>
                </div>
                <div class="smrt-job-stats__queue-stat" data-smrt-part="value">
                  <span class="smrt-job-stats__queue-stat-value" data-smrt-part="value">{queue.completed24h}</span>
                  <span class="smrt-job-stats__queue-stat-label" data-smrt-part="label">completed/24h</span>
                </div>
                <div class="smrt-job-stats__queue-stat" data-smrt-part="value">
                  <span class="smrt-job-stats__queue-stat-value" data-smrt-part="value">{queue.failed24h}</span>
                  <span class="smrt-job-stats__queue-stat-label" data-smrt-part="label">failed/24h</span>
                </div>
                <div class="smrt-job-stats__queue-stat" data-smrt-part="value">
                  <span class="smrt-job-stats__queue-stat-value" data-smrt-part="value"
                    >{formatDuration(queue.avgDuration)}</span
                  >
                  <span class="smrt-job-stats__queue-stat-label" data-smrt-part="label">avg</span>
                </div>
              </div>
            </div>
          </Card>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-job-stats__root {
    width: 100%;
  }
  .smrt-job-stats__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--smrt-spacing-md, 1rem);
  }
  .smrt-job-stats__compact .smrt-job-stats__grid {
    grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
    gap: var(--smrt-spacing-sm, 0.5rem);
  }
  .smrt-job-stats__card {
    padding: var(--smrt-spacing-sm, 0.5rem);
  }
  .smrt-job-stats__stat-label {
    margin-top: var(--smrt-spacing-xs, 0.25rem);
  }
  .smrt-job-stats__queues {
    margin-top: var(--smrt-spacing-lg, 1.5rem);
  }
  .smrt-job-stats__queues h3 {
    margin: 0 0 var(--smrt-spacing-md, 1rem) 0;
  }
  .smrt-job-stats__queue-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: var(--smrt-spacing-md, 1rem);
  }
  .smrt-job-stats__queue-card {
    padding: var(--smrt-spacing-xs, 0.25rem);
  }
  .smrt-job-stats__queue-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--smrt-spacing-sm, 0.5rem);
  }
  .smrt-job-stats__queue-stats {
    display: flex;
    gap: var(--smrt-spacing-md, 1rem);
  }
  .smrt-job-stats__queue-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .smrt-job-stats__root.smrt-job-stats__loading {
    pointer-events: none;
  }
}

@layer smrt.theme {
  .smrt-job-stats__root.smrt-job-stats__loading {
    opacity: 0.7;
  }
  .smrt-job-stats__card {
    text-align: center;
  }
  .smrt-job-stats__stat-value {
    font: var(--smrt-typography-headline-small-font, 700 1.5rem / 1.2 sans-serif);
  }
  .smrt-job-stats__compact .smrt-job-stats__stat-value {
    font: var(--smrt-typography-title-large-font, 1.25rem / 1.25 sans-serif);
  }
  .smrt-job-stats__stat-label {
    font: var(--smrt-typography-body-small-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-job-stats__card-pending .smrt-job-stats__stat-value {
    color: var(--smrt-color-on-surface);
  }
  .smrt-job-stats__card-running .smrt-job-stats__stat-value {
    color: var(--smrt-color-primary);
  }
  .smrt-job-stats__card-completed .smrt-job-stats__stat-value {
    color: var(--smrt-color-tertiary);
  }
  .smrt-job-stats__card-failed .smrt-job-stats__stat-value {
    color: var(--smrt-color-error);
  }
  .smrt-job-stats__queues h3 {
    font: var(--smrt-typography-title-medium-font, 600 1rem / 1.5 sans-serif);
  }
  .smrt-job-stats__queue-name {
    font-weight: var(--smrt-typography-weight-semibold, 600);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }
  .smrt-job-stats__queue-running {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-primary);
  }
  .smrt-job-stats__queue-stat-value {
    font-weight: var(--smrt-typography-weight-semibold, 600);
    font: var(--smrt-typography-title-medium-font, 1rem / 1.5 sans-serif);
  }
  .smrt-job-stats__queue-stat-label {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
