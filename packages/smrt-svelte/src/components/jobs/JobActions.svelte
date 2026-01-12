<script lang="ts">
/**
 * JobActions - Action buttons for job management
 */

import Button from '../ui/Button.svelte';
import type { JobActionsProps, JobData } from './types.js';

let {
  job,
  showRetry = true,
  showCancel = true,
  showDelete = false,
  onRetry,
  onCancel,
  onDelete,
  compact = false,
}: JobActionsProps = $props();

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
    gap: var(--spacing-sm, 0.5rem);
    align-items: center;
  }

  .compact {
    gap: var(--spacing-xs, 0.25rem);
  }
</style>
