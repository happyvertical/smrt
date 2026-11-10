<script lang="ts">
/**
 * JobDetail - Detailed view of a single job
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Card } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import JobActions from './JobActions.svelte';
import JobStatusBadge from './JobStatusBadge.svelte';
import type { JobData } from './types.js';
import {
  formatDuration,
  formatRelativeTime,
  getPriorityLabel,
} from './types.js';

const { t } = useI18n();

export interface Props {
  /** Job to display */
  job: JobData;
  /** Show result data */
  showResult?: boolean;
  /** Callback when retry is clicked */
  onRetry?: (job: JobData) => void;
  /** Callback when cancel is clicked */
  onCancel?: (job: JobData) => void;
  /** Callback when delete is clicked */
  onDelete?: (job: JobData) => void;
}

let { job, showResult = true, onRetry, onCancel, onDelete }: Props = $props();

// Calculate duration if job has started
const duration = $derived.by(() => {
  if (!job.startedAt) return null;
  const start = new Date(job.startedAt).getTime();
  const end = job.completedAt
    ? new Date(job.completedAt).getTime()
    : Date.now();
  return end - start;
});

// Format args for display
const formattedArgs = $derived(JSON.stringify(job.args, null, 2));
</script>

<div class="smrt-job-detail__root" data-smrt-component="JobDetail">
  <Card>
    {#snippet header()}
      <div class="smrt-job-detail__header" data-smrt-part="header">
        <div class="smrt-job-detail__title" data-smrt-part="title">
          <h2>{job.objectType}.{job.method}()</h2>
          <JobStatusBadge status={job.status} size="md" />
        </div>
        <div class="smrt-job-detail__actions" data-smrt-part="actions">
          <JobActions
            {job}
            showDelete={!!onDelete}
            {onRetry}
            {onCancel}
            {onDelete}
          />
        </div>
      </div>
    {/snippet}

    <div class="smrt-job-detail__content" data-smrt-part="body">
      <div class="smrt-job-detail__grid" data-smrt-part="grid">
        <!-- Basic Info -->
        <div class="smrt-job-detail__section" data-smrt-part="section">
          <h3>{t(M['jobs.job_detail.job_info'])}</h3>
          <dl class="smrt-job-detail__list" data-smrt-part="list">
            <dt>ID</dt>
            <dd><code>{job.id}</code></dd>

            <dt>Queue</dt>
            <dd>{job.queue}</dd>

            <dt>Priority</dt>
            <dd>{getPriorityLabel(job.priority)} ({job.priority})</dd>

            <dt>{t(M['jobs.job_detail.object_type'])}</dt>
            <dd>{job.objectType}</dd>

            {#if job.objectId}
              <dt>{t(M['jobs.job_detail.object_id'])}</dt>
              <dd><code>{job.objectId}</code></dd>
            {/if}

            <dt>Method</dt>
            <dd><code>{job.method}</code></dd>
          </dl>
        </div>

        <!-- Timing -->
        <div class="smrt-job-detail__section" data-smrt-part="section">
          <h3>Timing</h3>
          <dl class="smrt-job-detail__list" data-smrt-part="list">
            <dt>Created</dt>
            <dd>{formatRelativeTime(job.createdAt)}</dd>

            <dt>{t(M['jobs.job_detail.scheduled_for'])}</dt>
            <dd>{formatRelativeTime(job.runAt)}</dd>

            {#if job.startedAt}
              <dt>Started</dt>
              <dd>{formatRelativeTime(job.startedAt)}</dd>
            {/if}

            {#if job.completedAt}
              <dt>Completed</dt>
              <dd>{formatRelativeTime(job.completedAt)}</dd>
            {/if}

            {#if duration !== null}
              <dt>Duration</dt>
              <dd>{formatDuration(duration)}</dd>
            {/if}

            <dt>Timeout</dt>
            <dd>{formatDuration(job.timeout)} ({job.timeoutBehavior})</dd>
          </dl>
        </div>

        <!-- Execution -->
        <div class="smrt-job-detail__section" data-smrt-part="section">
          <h3>Execution</h3>
          <dl class="smrt-job-detail__list" data-smrt-part="list">
            <dt>Attempts</dt>
            <dd>{job.attempts} / {job.maxAttempts}</dd>

            {#if job.workerId}
              <dt>Worker</dt>
              <dd><code>{job.workerId}</code></dd>
            {/if}

            {#if job.resultPointer}
              <dt>Result</dt>
              <dd><code>{job.resultPointer}</code></dd>
            {/if}
          </dl>
        </div>
      </div>

      <!-- Arguments -->
      <div class="smrt-job-detail__section smrt-job-detail__section-full" data-smrt-part="section">
        <h3>Arguments</h3>
        <pre class="smrt-job-detail__code" data-smrt-part="code">{formattedArgs}</pre>
      </div>

      <!-- Error -->
      {#if job.lastError}
        <div class="smrt-job-detail__section smrt-job-detail__section-full smrt-job-detail__section-error" data-smrt-part="section">
          <h3>{t(M['jobs.job_detail.last_error'])}</h3>
          <pre class="smrt-job-detail__code smrt-job-detail__code-error" data-smrt-part="code">{job.lastError}</pre>
        </div>
      {/if}
    </div>
  </Card>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-job-detail__root {
    width: 100%;
  }
  .smrt-job-detail__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--smrt-spacing-md, 1rem);
  }
  .smrt-job-detail__title {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-md, 1rem);
  }
  .smrt-job-detail__title h2 {
    margin: 0;
  }
  .smrt-job-detail__content {
    padding: var(--smrt-spacing-md, 1rem) 0;
  }
  .smrt-job-detail__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: var(--smrt-spacing-lg, 1.5rem);
    margin-bottom: var(--smrt-spacing-lg, 1.5rem);
  }
  .smrt-job-detail__section h3 {
    margin: 0 0 var(--smrt-spacing-sm, 0.5rem) 0;
  }
  .smrt-job-detail__section-full {
    grid-column: 1 / -1;
  }
  .smrt-job-detail__list {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--smrt-spacing-xs, 0.25rem) var(--smrt-spacing-md, 1rem);
    margin: 0;
  }
  .smrt-job-detail__list dd {
    margin: 0;
  }
  .smrt-job-detail__list code {
    padding: 0.125rem 0.375rem;
  }
  .smrt-job-detail__code {
    margin: 0;
    padding: var(--smrt-spacing-md, 1rem);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
}

@layer smrt.theme {
  .smrt-job-detail__title h2 {
    font: var(--smrt-typography-title-large-font, 1.125rem / 1.25 sans-serif);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }
  .smrt-job-detail__section h3 {
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-title-small-tracking, 0.05em);
  }
  .smrt-job-detail__section-error h3 {
    color: var(--smrt-color-error);
  }
  .smrt-job-detail__list dt {
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
  }
  .smrt-job-detail__list dd {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
  }
  .smrt-job-detail__list code {
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-small, 0.25rem);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
  }
  .smrt-job-detail__code {
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
  }
  .smrt-job-detail__code-error {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
}

</style>
