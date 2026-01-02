<script lang="ts">
/**
 * ConfirmDialog - Modal confirmation dialog
 *
 * Provides a consistent confirmation dialog for destructive actions
 * or important decisions.
 */

interface Props {
  /** Whether the dialog is open */
  open: boolean;
  /** Dialog title */
  title: string;
  /** Dialog message */
  message: string;
  /** Confirm button label */
  confirmLabel?: string;
  /** Cancel button label */
  cancelLabel?: string;
  /** Use destructive (red) styling for confirm */
  destructive?: boolean;
  /** Show loading state on confirm */
  loading?: boolean;
  /** Called when confirm is clicked */
  onconfirm?: () => void;
  /** Called when cancel is clicked or dialog closed */
  oncancel?: () => void;
}

const {
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  loading = false,
  onconfirm,
  oncancel,
}: Props = $props();

function handleBackdropClick(e: MouseEvent) {
  if (e.target === e.currentTarget) {
    oncancel?.();
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    oncancel?.();
  }
}
</script>

{#if open}
  <div
    class="dialog-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dialog-title"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
  >
    <div class="dialog-content">
      <h2 id="dialog-title" class="dialog-title">{title}</h2>
      <p class="dialog-message">{message}</p>

      <div class="dialog-actions">
        <button
          type="button"
          class="btn btn-cancel"
          onclick={oncancel}
          disabled={loading}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          class="btn btn-confirm"
          class:destructive
          onclick={onconfirm}
          disabled={loading}
        >
          {#if loading}
            <span class="spinner"></span>
          {/if}
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    z-index: 50;
    padding: 1rem;
  }

  .dialog-content {
    background: white;
    border-radius: 0.75rem;
    padding: 1.5rem;
    max-width: 400px;
    width: 100%;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
    animation: dialogEnter 0.2s ease-out;
  }

  @keyframes dialogEnter {
    from {
      opacity: 0;
      transform: scale(0.95);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .dialog-title {
    font-size: 1.125rem;
    font-weight: 600;
    color: #111827;
    margin: 0 0 0.5rem;
  }

  .dialog-message {
    font-size: 0.875rem;
    color: #6b7280;
    margin: 0 0 1.5rem;
    line-height: 1.5;
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    border-radius: 0.375rem;
    cursor: pointer;
    transition: all 0.15s;
    border: none;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-cancel {
    background: white;
    color: #374151;
    border: 1px solid #d1d5db;
  }

  .btn-cancel:hover:not(:disabled) {
    background: #f9fafb;
  }

  .btn-confirm {
    background: #3b82f6;
    color: white;
  }

  .btn-confirm:hover:not(:disabled) {
    background: #2563eb;
  }

  .btn-confirm.destructive {
    background: #dc2626;
  }

  .btn-confirm.destructive:hover:not(:disabled) {
    background: #b91c1c;
  }

  .spinner {
    width: 1rem;
    height: 1rem;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
