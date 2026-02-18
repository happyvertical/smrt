<script lang="ts">
/**
 * JobDetail - Detailed view of a single job
 */

import { Card } from '@happyvertical/smrt-svelte/ui';
import JobActions from './JobActions.svelte';
import JobStatusBadge from './JobStatusBadge.svelte';
import type { JobData } from './types.js';
import {
  formatDuration,
  formatRelativeTime,
  getPriorityLabel,
} from './types.js';

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

<div class="job-detail">
  <Card>
    {#snippet header()}
      <div class="job-detail__header">
        <div class="job-detail__title">
          <h2>{job.objectType}.{job.method}()</h2>
          <JobStatusBadge status={job.status} size="md" />
        </div>
        <div class="job-detail__actions">
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

    <div class="job-detail__content">
      <div class="job-detail__grid">
        <!-- Basic Info -->
        <div class="job-detail__section">
          <h3>Job Info</h3>
          <dl class="job-detail__list">
            <dt>ID</dt>
            <dd><code>{job.id}</code></dd>

            <dt>Queue</dt>
            <dd>{job.queue}</dd>

            <dt>Priority</dt>
            <dd>{getPriorityLabel(job.priority)} ({job.priority})</dd>

            <dt>Object Type</dt>
            <dd>{job.objectType}</dd>

            {#if job.objectId}
              <dt>Object ID</dt>
              <dd><code>{job.objectId}</code></dd>
            {/if}

            <dt>Method</dt>
            <dd><code>{job.method}</code></dd>
          </dl>
        </div>

        <!-- Timing -->
        <div class="job-detail__section">
          <h3>Timing</h3>
          <dl class="job-detail__list">
            <dt>Created</dt>
            <dd>{formatRelativeTime(job.createdAt)}</dd>

            <dt>Scheduled For</dt>
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
        <div class="job-detail__section">
          <h3>Execution</h3>
          <dl class="job-detail__list">
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
      <div class="job-detail__section job-detail__section--full">
        <h3>Arguments</h3>
        <pre class="job-detail__code">{formattedArgs}</pre>
      </div>

      <!-- Error -->
      {#if job.lastError}
        <div class="job-detail__section job-detail__section--full job-detail__section--error">
          <h3>Last Error</h3>
          <pre class="job-detail__code job-detail__code--error">{job.lastError}</pre>
        </div>
      {/if}
    </div>
  </Card>
</div>

<style>
  .job-detail {
    width: 100%;
  }

  .job-detail__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--smrt-spacing-md, 1rem);
  }

  .job-detail__title {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-md, 1rem);
  }

  .job-detail__title h2 {
    margin: 0;
    font: var(--smrt-typography-title-large-font, 1.125rem / 1.25 sans-serif);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }

  .job-detail__content {
    padding: var(--smrt-spacing-md, 1rem) 0;
  }

  .job-detail__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: var(--smrt-spacing-lg, 1.5rem);
    margin-bottom: var(--smrt-spacing-lg, 1.5rem);
  }

  .job-detail__section h3 {
    margin: 0 0 var(--spacing-sm, 0.5rem) 0;
    font-size: var(--font-size-sm, 0.875rem);
    font-weight: 600;
    color: var(--color-text-secondary, #6b7280);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .job-detail__section--full {
    grid-column: 1 / -1;
  }

  .job-detail__section--error h3 {
    color: var(--color-error, #dc2626);
  }

  .job-detail__list {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--smrt-spacing-xs, 0.25rem) var(--smrt-spacing-md, 1rem);
    margin: 0;
  }

  .job-detail__list dt {
    color: var(--smrt-color-on-surface-variant, #43474e);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
  }

  .job-detail__list dd {
    margin: 0;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
  }

  .job-detail__list code {
    padding: 0.125rem 0.375rem;
    background: var(--smrt-color-surface-container, #f3f4f6);
    border-radius: var(--smrt-radius-small, 0.25rem);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
  }

  .job-detail__code {
    margin: 0;
    padding: var(--smrt-spacing-md, 1rem);
    background: var(--smrt-color-surface-container, #f3f4f6);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .job-detail__code--error {
    background: var(--smrt-color-error-container, #ffdad6);
    color: var(--smrt-color-on-error-container, #410002);
  }
</style>
