<script lang="ts">
/**
 * RejectDialog - Modal dialog for rejecting with a reason
 * Requires a reason to be entered before confirming
 */

interface Props {
  open: boolean;
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  placeholder?: string;
  required?: boolean;
  loading?: boolean;
  onconfirm: (reason: string) => void;
  oncancel: () => void;
}

let {
  open,
  title = 'Reject Entry',
  message = 'Please provide a reason for rejection:',
  confirmLabel = 'Reject',
  cancelLabel = 'Cancel',
  placeholder = 'Enter rejection reason...',
  required = true,
  loading = false,
  onconfirm,
  oncancel,
}: Props = $props();

let reason = $state('');
let textarea: HTMLTextAreaElement;

const canConfirm = $derived(!required || reason.trim().length > 0);

function handleConfirm() {
  if (canConfirm) {
    onconfirm(reason.trim());
    reason = '';
  }
}

function handleCancel() {
  reason = '';
  oncancel();
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    handleCancel();
  }
}

function handleBackdropClick(event: MouseEvent) {
  if (event.target === event.currentTarget) {
    handleCancel();
  }
}

$effect(() => {
  if (open && textarea) {
    textarea.focus();
  }
});
</script>

{#if open}
  <div
    class="dialog-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="reject-dialog-title"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
  >
    <div class="dialog" tabindex="-1">
      <h2 id="reject-dialog-title" class="dialog-title">{title}</h2>

      <p class="dialog-message">{message}</p>

      <textarea
        bind:this={textarea}
        bind:value={reason}
        class="reason-input"
        placeholder={placeholder}
        rows="3"
        disabled={loading}
      ></textarea>

      {#if required && reason.trim().length === 0}
        <p class="hint">A reason is required to reject</p>
      {/if}

      <div class="dialog-actions">
        <button
          type="button"
          class="btn btn-secondary"
          onclick={handleCancel}
          disabled={loading}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          class="btn btn-danger"
          onclick={handleConfirm}
          disabled={!canConfirm || loading}
        >
          {loading ? 'Rejecting...' : confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    z-index: 1000;
  }

  .dialog {
    background: var(--color-surface, #fff);
    border-radius: var(--radius-lg, 12px);
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.2);
    width: 100%;
    max-width: 28rem;
    padding: 1.5rem;
  }

  .dialog-title {
    margin: 0 0 0.5rem;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--color-text, #1f2937);
  }

  .dialog-message {
    margin: 0 0 1rem;
    font-size: 0.9375rem;
    color: var(--color-text-muted, #6b7280);
  }

  .reason-input {
    width: 100%;
    padding: 0.75rem;
    font-size: 0.9375rem;
    font-family: inherit;
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    resize: vertical;
    min-height: 80px;
  }

  .reason-input:focus {
    outline: none;
    border-color: var(--color-primary, #3b82f6);
    box-shadow: 0 0 0 3px var(--color-primary-bg, #eff6ff);
  }

  .reason-input:disabled {
    background: var(--color-surface-disabled, #f9fafb);
    cursor: not-allowed;
  }

  .hint {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
    color: var(--color-text-muted, #6b7280);
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    margin-top: 1.5rem;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
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

  .btn-secondary {
    background: var(--color-surface, #fff);
    border-color: var(--color-border, #e5e7eb);
    color: var(--color-text, #1f2937);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-surface-hover, #f9fafb);
  }

  .btn-danger {
    background: var(--color-error, #ef4444);
    color: white;
  }

  .btn-danger:hover:not(:disabled) {
    background: var(--color-error-dark, #dc2626);
  }
</style>
