<script lang="ts">
/**
 * ApprovalActions - Status-based action buttons for approval workflow
 * Shows appropriate buttons based on current status
 */

export type ApprovalStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

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
      class="btn btn-primary"
      onclick={onsubmit}
      disabled={disabled || loading}
    >
      {loading ? 'Submitting...' : 'Submit for Approval'}
    </button>
  {/if}

  {#if canApprove}
    <button
      type="button"
      class="btn btn-success"
      onclick={onapprove}
      disabled={disabled || loading}
    >
      {loading ? 'Approving...' : 'Approve'}
    </button>
  {/if}

  {#if canReject}
    <button
      type="button"
      class="btn btn-danger"
      onclick={onreject}
      disabled={disabled || loading}
    >
      Reject
    </button>
  {/if}

  {#if canEdit}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={onedit}
      disabled={disabled || loading}
    >
      Edit
    </button>
  {/if}

  {#if canDelete}
    <button
      type="button"
      class="btn btn-danger-outline"
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
    padding: 0.625rem 1.25rem;
    font-size: 0.875rem;
    font-weight: 500;
    border-radius: var(--radius-md, 8px);
    border: 2px solid transparent;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--color-primary, #3b82f6);
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-dark, #2563eb);
  }

  .btn-success {
    background: var(--color-success, #10b981);
    color: white;
  }

  .btn-success:hover:not(:disabled) {
    background: var(--color-success-dark, #059669);
  }

  .btn-danger {
    background: var(--color-error, #ef4444);
    color: white;
  }

  .btn-danger:hover:not(:disabled) {
    background: var(--color-error-dark, #dc2626);
  }

  .btn-danger-outline {
    background: transparent;
    border-color: var(--color-error, #ef4444);
    color: var(--color-error, #ef4444);
  }

  .btn-danger-outline:hover:not(:disabled) {
    background: var(--color-error, #ef4444);
    color: white;
  }

  .btn-secondary {
    background: var(--color-surface, #fff);
    border-color: var(--color-border, #e5e7eb);
    color: var(--color-text, #1f2937);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-surface-hover, #f9fafb);
    border-color: var(--color-border-hover, #d1d5db);
  }

  .status-message {
    font-size: 0.875rem;
    font-weight: 500;
    padding: 0.5rem 1rem;
    border-radius: var(--radius-md, 8px);
  }

  .status-message.success {
    background: var(--color-success-bg, #ecfdf5);
    color: var(--color-success, #10b981);
  }

  .status-message.error {
    background: var(--color-error-bg, #fef2f2);
    color: var(--color-error, #ef4444);
  }
</style>
