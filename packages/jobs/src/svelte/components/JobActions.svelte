<script lang="ts">
/**
 * JobActions - Action buttons for job management
 */

import { Button } from '@happyvertical/smrt-svelte/ui';
import type { JobData } from './types.js';

export interface Props {
  /** Job to perform actions on */
  job: JobData;
  /** Show retry button */
  showRetry?: boolean;
  /** Show cancel button */
  showCancel?: boolean;
  /** Show delete button */
  showDelete?: boolean;
  /** Callback when retry is clicked */
  onRetry?: (job: JobData) => void;
  /** Callback when cancel is clicked */
  onCancel?: (job: JobData) => void;
  /** Callback when delete is clicked */
  onDelete?: (job: JobData) => void;
  /** Compact mode */
  compact?: boolean;
}

let {
  job,
  showRetry = true,
  showCancel = true,
  showDelete = false,
  onRetry,
  onCancel,
  onDelete,
  compact = false,
}: Props = $props();

const canRetry = $derived(
  job.status === 'failed' || job.status === 'cancelled',
);
const canCancel = $derived(
  job.status === 'pending' ||
    job.status === 'ready' ||
    job.status === 'running',
);

function handleRetry() {
  onRetry?.(job);
}

function handleCancel() {
  onCancel?.(job);
}

function handleDelete() {
  onDelete?.(job);
}
</script>

<div class="job-actions" class:compact>
  {#if showRetry && canRetry}
    <Button
      variant="secondary"
      size={compact ? 'sm' : 'md'}
      onclick={handleRetry}
    >
      Retry
    </Button>
  {/if}

  {#if showCancel && canCancel}
    <Button
      variant="secondary"
      size={compact ? 'sm' : 'md'}
      onclick={handleCancel}
    >
      Cancel
    </Button>
  {/if}

  {#if showDelete}
    <Button
      variant="danger"
      size={compact ? 'sm' : 'md'}
      onclick={handleDelete}
    >
      Delete
    </Button>
  {/if}
</div>

<style>
  .job-actions {
    display: flex;
    gap: var(--smrt-spacing-sm, 0.5rem);
    align-items: center;
  }

  .compact {
    gap: var(--smrt-spacing-xs, 0.25rem);
  }
</style>
