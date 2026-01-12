<script lang="ts">
/**
 * JobStats - Display job statistics overview
 */

import Card from '../ui/Card.svelte';
import type { JobStats, QueueStats } from './types.js';
import { formatDuration } from './types.js';

interface Props {
  /** Statistics data */
  stats: JobStats;
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

<div class="job-stats" class:compact class:loading>
  <div class="job-stats__grid">
    <!-- Total Jobs -->
    <Card padding="sm">
      <div class="stat-card">
        <div class="stat-card__value">{stats.total.toLocaleString()}</div>
        <div class="stat-card__label">Total Jobs</div>
      </div>
    </Card>

    <!-- Pending -->
    <Card padding="sm">
      <div class="stat-card stat-card--pending">
        <div class="stat-card__value">{stats.pending.toLocaleString()}</div>
        <div class="stat-card__label">Pending</div>
      </div>
    </Card>

    <!-- Running -->
    <Card padding="sm">
      <div class="stat-card stat-card--running">
        <div class="stat-card__value">{stats.running.toLocaleString()}</div>
        <div class="stat-card__label">Running</div>
      </div>
    </Card>

    <!-- Completed -->
    <Card padding="sm">
      <div class="stat-card stat-card--completed">
        <div class="stat-card__value">{stats.completed.toLocaleString()}</div>
        <div class="stat-card__label">Completed</div>
      </div>
    </Card>

    <!-- Failed -->
    <Card padding="sm">
      <div class="stat-card stat-card--failed">
        <div class="stat-card__value">{stats.failed.toLocaleString()}</div>
        <div class="stat-card__label">Failed</div>
      </div>
    </Card>

    <!-- Success Rate -->
    <Card padding="sm">
      <div class="stat-card">
        <div class="stat-card__value">{successRateFormatted}</div>
        <div class="stat-card__label">Success Rate</div>
      </div>
    </Card>

    <!-- Avg Duration -->
    <Card padding="sm">
      <div class="stat-card">
        <div class="stat-card__value">{formatDuration(stats.avgDuration)}</div>
        <div class="stat-card__label">Avg Duration</div>
      </div>
    </Card>
  </div>

  {#if queues.length > 0 && !compact}
    <div class="job-stats__queues">
      <h3>Queues</h3>
      <div class="queue-list">
        {#each queues as queue (queue.name)}
          <Card padding="sm">
            <div class="queue-card">
              <div class="queue-card__header">
                <span class="queue-card__name">{queue.name}</span>
                <span class="queue-card__running">{queue.running} running</span>
              </div>
              <div class="queue-card__stats">
                <div class="queue-stat">
                  <span class="queue-stat__value">{queue.pending}</span>
                  <span class="queue-stat__label">pending</span>
                </div>
                <div class="queue-stat">
                  <span class="queue-stat__value">{queue.completed24h}</span>
                  <span class="queue-stat__label">completed/24h</span>
                </div>
                <div class="queue-stat">
                  <span class="queue-stat__value">{queue.failed24h}</span>
                  <span class="queue-stat__label">failed/24h</span>
                </div>
                <div class="queue-stat">
                  <span class="queue-stat__value"
                    >{formatDuration(queue.avgDuration)}</span
                  >
                  <span class="queue-stat__label">avg</span>
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
  .job-stats {
    width: 100%;
  }

  .job-stats.loading {
    opacity: 0.7;
    pointer-events: none;
  }

  .job-stats__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--spacing-md, 1rem);
  }

  .compact .job-stats__grid {
    grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
    gap: var(--spacing-sm, 0.5rem);
  }

  .stat-card {
    text-align: center;
    padding: var(--spacing-sm, 0.5rem);
  }

  .stat-card__value {
    font-size: var(--font-size-2xl, 1.5rem);
    font-weight: 700;
    line-height: 1.2;
  }

  .compact .stat-card__value {
    font-size: var(--font-size-xl, 1.25rem);
  }

  .stat-card__label {
    font-size: var(--font-size-sm, 0.875rem);
    color: var(--color-text-secondary, #6b7280);
    margin-top: var(--spacing-xs, 0.25rem);
  }

  .stat-card--pending .stat-card__value {
    color: var(--color-text-primary, #111827);
  }

  .stat-card--running .stat-card__value {
    color: var(--color-primary, #3b82f6);
  }

  .stat-card--completed .stat-card__value {
    color: var(--color-success, #10b981);
  }

  .stat-card--failed .stat-card__value {
    color: var(--color-error, #ef4444);
  }

  .job-stats__queues {
    margin-top: var(--spacing-lg, 1.5rem);
  }

  .job-stats__queues h3 {
    margin: 0 0 var(--spacing-md, 1rem) 0;
    font-size: var(--font-size-md, 1rem);
    font-weight: 600;
  }

  .queue-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: var(--spacing-md, 1rem);
  }

  .queue-card {
    padding: var(--spacing-xs, 0.25rem);
  }

  .queue-card__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--spacing-sm, 0.5rem);
  }

  .queue-card__name {
    font-weight: 600;
    font-family: var(--font-family-mono, monospace);
  }

  .queue-card__running {
    font-size: var(--font-size-sm, 0.875rem);
    color: var(--color-primary, #3b82f6);
  }

  .queue-card__stats {
    display: flex;
    gap: var(--spacing-md, 1rem);
  }

  .queue-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .queue-stat__value {
    font-weight: 600;
    font-size: var(--font-size-md, 1rem);
  }

  .queue-stat__label {
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--color-text-secondary, #6b7280);
  }
</style>
