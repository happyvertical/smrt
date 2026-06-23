<script lang="ts">
/**
 * JobDashboard - Combined overview panel for background jobs
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button, Card } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import JobList from './JobList.svelte';
import JobStatsSummary from './JobStats.svelte';
import type { JobData, JobStats, QueueStats } from './types.js';

const { t } = useI18n();

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
            <h2>{t(M['jobs.job_dashboard.recent_jobs'])}</h2>
            {#if onViewAll}
              <Button variant="ghost" size="sm" onclick={onViewAll}>{t(M['jobs.job_dashboard.view_all'])}</Button>
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
            <p class="empty-message">{t(M['jobs.job_dashboard.no_recent_jobs'])}</p>
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
              <h2>{t(M['jobs.job_dashboard.failed_jobs'])}</h2>
              {#if onViewFailed}
                <Button variant="ghost" size="sm" onclick={onViewFailed}>
                  {t(M['jobs.job_dashboard.view_all_count'], { count: stats.failed })}
                </Button>
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
                {t(M['jobs.job_dashboard.no_failed_jobs'])}
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

  .empty-message {
    padding: var(--smrt-spacing-md, 1rem);
    text-align: center;
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .empty-message--success {
    color: var(--smrt-color-tertiary, #006c4f);
  }

</style>
