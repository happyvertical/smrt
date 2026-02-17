<script lang="ts">
/**
 * JobDashboard - Combined overview panel for background jobs
 */

import { Card } from '@happyvertical/smrt-svelte/ui';
import type { JobData, JobStats, QueueStats } from '../types.js';
import JobList from './JobList.svelte';
import JobStatsSummary from './JobStats.svelte';

export interface Props {
  /** Statistics data */
  stats: JobStats;
  /** Queue breakdown */
  queues?: QueueStats[];
  /** Recent jobs */
  recentJobs?: JobData[];
  /** Failed jobs */
  failedJobs?: JobData[];
  /** Loading state */
  loading?: boolean;
  /** Callback when job is clicked */
  onJobClick?: (job: JobData) => void;
  /** Callback when retry is clicked */
  onRetry?: (job: JobData) => void;
  /** Callback when cancel is clicked */
  onCancel?: (job: JobData) => void;
  /** Callback when view all is clicked */
  onViewAll?: () => void;
  /** Callback when view failed is clicked */
  onViewFailed?: () => void;
}

let {
  stats,
  queues = [],
  recentJobs = [],
  failedJobs = [],
  loading = false,
  onJobClick,
  onRetry,
  onCancel,
  onViewAll,
  onViewFailed,
}: Props = $props();
</script>

<div class="job-dashboard" class:loading>
  <!-- Stats Overview -->
  <section class="job-dashboard__section">
    <JobStatsSummary {stats} {queues} {loading} />
  </section>

  <div class="job-dashboard__panels">
    <!-- Recent Jobs -->
    <section class="job-dashboard__section">
      <Card>
        {#snippet header()}
          <div class="panel-header">
            <h2>Recent Jobs</h2>
            {#if onViewAll}
              <button class="view-all-btn" onclick={onViewAll}>View All</button>
            {/if}
          </div>
        {/snippet}

        <JobList
          jobs={recentJobs}
          {loading}
          showActions={false}
          {onJobClick}
        >
          {#snippet empty()}
            <p class="empty-message">No recent jobs</p>
          {/snippet}
        </JobList>
      </Card>
    </section>

    <!-- Failed Jobs -->
    {#if failedJobs.length > 0 || stats.failed > 0}
      <section class="job-dashboard__section">
        <Card>
          {#snippet header()}
            <div class="panel-header panel-header--error">
              <h2>Failed Jobs</h2>
              {#if onViewFailed}
                <button class="view-all-btn" onclick={onViewFailed}
                  >View All ({stats.failed})</button
                >
              {/if}
            </div>
          {/snippet}

          <JobList
            jobs={failedJobs}
            {loading}
            showActions={true}
            {onJobClick}
            {onRetry}
            {onCancel}
          >
            {#snippet empty()}
              <p class="empty-message empty-message--success">
                No failed jobs
              </p>
            {/snippet}
          </JobList>
        </Card>
      </section>
    {/if}
  </div>
</div>

<style>
  .job-dashboard {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-lg, 1.5rem);
  }

  .job-dashboard.loading {
    opacity: 0.7;
    pointer-events: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .job-dashboard.loading {
      transition: none;
    }
  }

  .job-dashboard__section {
    width: 100%;
  }

  .job-dashboard__panels {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
    gap: var(--smrt-spacing-lg, 1.5rem);
  }

  @media (max-width: 900px) {
    .job-dashboard__panels {
      grid-template-columns: 1fr;
    }
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

  .panel-header--error h2 {
    color: var(--smrt-color-error, #ba1a1a);
  }

  .view-all-btn {
    padding: var(--smrt-spacing-xs, 0.25rem) var(--smrt-spacing-sm, 0.5rem);
    border: none;
    background: none;
    color: var(--smrt-color-primary, #005ac1);
    font: var(--smrt-typography-label-large-font, 500 0.875rem / 1.25 sans-serif);
    cursor: pointer;
    border-radius: var(--smrt-radius-small, 0.25rem);
    transition: background-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .view-all-btn:hover {
    background: var(--smrt-color-primary-container, #d6e3ff);
  }

  .empty-message {
    padding: var(--smrt-spacing-md, 1rem);
    text-align: center;
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .empty-message--success {
    color: var(--smrt-color-tertiary, #006c4f);
  }

  @media (prefers-reduced-motion: reduce) {
    .view-all-btn {
      transition: none;
    }
  }
</style>
