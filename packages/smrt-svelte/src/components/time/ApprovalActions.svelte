<script lang="ts">
/**
 * ApprovalActions - Status-based action buttons for approval workflow
 * Shows appropriate buttons based on current status
 */

import type { ApprovalStatus } from './utils.js';

interface Props {
  status: ApprovalStatus;
  onsubmit?: () => void;
  onapprove?: () => void;
  onreject?: () => void;
  onedit?: () => void;
  ondelete?: () => void;
  loading?: boolean;
  disabled?: boolean;
  layout?: 'horizontal' | 'vertical';
}

let {
  status,
  onsubmit,
  onapprove,
  onreject,
  onedit,
  ondelete,
  loading = false,
  disabled = false,
  layout = 'horizontal',
}: Props = $props();

// Determine which actions are available based on status
const canSubmit = $derived(status === 'draft' && onsubmit);
const canApprove = $derived(status === 'submitted' && onapprove);
const canReject = $derived(status === 'submitted' && onreject);
const canEdit = $derived(
  (status === 'draft' || status === 'rejected') && onedit,
);
const canDelete = $derived(status === 'draft' && ondelete);
</script>

<div class="approval-actions" class:vertical={layout === 'vertical'}>
  {#if canSubmit}
    <button
      type="button"
      class="btn btn-filled"
      onclick={onsubmit}
      disabled={disabled || loading}
    >
      {loading ? 'Submitting...' : 'Submit for Approval'}
    </button>
  {/if}

  {#if canApprove}
    <button
      type="button"
      class="btn btn-filled-tonal"
      onclick={onapprove}
      disabled={disabled || loading}
    >
      {loading ? 'Approving...' : 'Approve'}
    </button>
  {/if}

  {#if canReject}
    <button
      type="button"
      class="btn btn-error"
      onclick={onreject}
      disabled={disabled || loading}
    >
      Reject
    </button>
  {/if}

  {#if canEdit}
    <button
      type="button"
      class="btn btn-outlined"
      onclick={onedit}
      disabled={disabled || loading}
    >
      Edit
    </button>
  {/if}

  {#if canDelete}
    <button
      type="button"
      class="btn btn-error-outlined"
      onclick={ondelete}
      disabled={disabled || loading}
    >
      Delete
    </button>
  {/if}

  {#if status === 'approved'}
    <span class="status-message success">
      This entry has been approved
    </span>
  {/if}

  {#if status === 'rejected'}
    <span class="status-message error">
      This entry was rejected
    </span>
  {/if}
</div>

<style>
  .approval-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
  }

  .approval-actions.vertical {
    flex-direction: column;
    align-items: stretch;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.625rem 1.5rem;
    font-size: var(--md-sys-typescale-label-large-size, 0.875rem);
    font-weight: var(--md-sys-typescale-label-large-weight, 500);
    letter-spacing: var(--md-sys-typescale-label-large-tracking, 0.1px);
    border-radius: var(--md-sys-shape-corner-full, 9999px);
    border: none;
    cursor: pointer;
    transition: all 0.2s var(--md-sys-motion-easing-standard);
  }

  .btn:disabled {
    opacity: 0.38;
    cursor: not-allowed;
  }

  .btn-filled {
    background: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
  }

  .btn-filled:hover:not(:disabled) {
    box-shadow: var(--md-sys-elevation-level1);
  }

  .btn-filled-tonal {
    background: var(--md-sys-color-secondary-container);
    color: var(--md-sys-color-on-secondary-container);
  }

  .btn-filled-tonal:hover:not(:disabled) {
    box-shadow: var(--md-sys-elevation-level1);
  }

  .btn-error {
    background: var(--md-sys-color-error);
    color: var(--md-sys-color-on-error);
  }

  .btn-error:hover:not(:disabled) {
    box-shadow: var(--md-sys-elevation-level1);
  }

  .btn-error-outlined {
    background: transparent;
    border: 1px solid var(--md-sys-color-error);
    color: var(--md-sys-color-error);
  }

  .btn-error-outlined:hover:not(:disabled) {
    background: var(--md-sys-color-error-container);
  }

  .btn-outlined {
    background: transparent;
    border: 1px solid var(--md-sys-color-outline);
    color: var(--md-sys-color-on-surface);
  }

  .btn-outlined:hover:not(:disabled) {
    background: var(--md-sys-color-surface-container-highest);
  }

  .status-message {
    font-size: var(--md-sys-typescale-body-medium-size, 0.875rem);
    font-weight: var(--md-sys-typescale-label-large-weight, 500);
    padding: 0.5rem 1rem;
    border-radius: var(--md-sys-shape-corner-small, 8px);
  }

  .status-message.success {
    background: var(--md-sys-color-primary-container);
    color: var(--md-sys-color-on-primary-container);
  }

  .status-message.error {
    background: var(--md-sys-color-error-container);
    color: var(--md-sys-color-on-error-container);
  }
</style>
