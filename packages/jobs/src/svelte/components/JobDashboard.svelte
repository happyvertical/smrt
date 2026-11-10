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

<div class="smrt-job-dashboard__root" class:smrt-job-dashboard__loading={loading} data-smrt-component="JobDashboard">
  <!-- Stats Overview -->
  <section class="smrt-job-dashboard__section" data-smrt-part="section">
    <JobStatsSummary {stats} {queues} {loading} />
  </section>

  <div class="smrt-job-dashboard__panels" data-smrt-part="panels">
    <!-- Recent Jobs -->
    <section class="smrt-job-dashboard__section" data-smrt-part="section">
      <Card>
        {#snippet header()}
          <div class="smrt-job-dashboard__header" data-smrt-part="header">
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
            <p class="smrt-job-dashboard__empty-message" data-smrt-part="empty">{t(M['jobs.job_dashboard.no_recent_jobs'])}</p>
          {/snippet}
        </JobList>
      </Card>
    </section>

    <!-- Failed Jobs -->
    {#if failedJobs.length > 0 || stats.failed > 0}
      <section class="smrt-job-dashboard__section" data-smrt-part="section">
        <Card>
          {#snippet header()}
            <div class="smrt-job-dashboard__header smrt-job-dashboard__header-error" data-smrt-part="header">
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
              <p class="smrt-job-dashboard__empty-message smrt-job-dashboard__empty-message-success" data-smrt-part="empty">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-job-dashboard__root {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-lg, 1.5rem);
  }
  .smrt-job-dashboard__section {
    width: 100%;
  }
  .smrt-job-dashboard__panels {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
    gap: var(--smrt-spacing-lg, 1.5rem);
  }
  @media (max-width: 900px) {
    .smrt-job-dashboard__panels {
      grid-template-columns: 1fr;
    }
  }
  .smrt-job-dashboard__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .smrt-job-dashboard__header h2 {
    margin: 0;
  }
  .smrt-job-dashboard__empty-message {
    padding: var(--smrt-spacing-md, 1rem);
  }
  .smrt-job-dashboard__root.smrt-job-dashboard__loading {
    pointer-events: none;
  }
}

@layer smrt.theme {
  .smrt-job-dashboard__root.smrt-job-dashboard__loading {
    opacity: 0.7;
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-job-dashboard__root.smrt-job-dashboard__loading {
      transition: none;
    }
  }
  .smrt-job-dashboard__header h2 {
    font: var(--smrt-typography-title-medium-font, 600 1rem / 1.5 sans-serif);
  }
  .smrt-job-dashboard__header-error h2 {
    color: var(--smrt-color-error);
  }
  .smrt-job-dashboard__empty-message {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-job-dashboard__empty-message-success {
    color: var(--smrt-color-tertiary);
  }
}

</style>
