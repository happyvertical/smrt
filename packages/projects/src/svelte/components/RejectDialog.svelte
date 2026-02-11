<script lang="ts">
/**
 * RejectDialog - Modal dialog for rejecting with a reason
 * Requires a reason to be entered before confirming
 */

/** Props for RejectDialog component */
export interface Props {
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
          class="btn btn-error"
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
    background: rgba(0, 0, 0, 0.32);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    z-index: 1000;
  }

  .dialog {
    background: var(--smrt-color-surface);
    border-radius: var(--smrt-radius-extra-large, 28px);
    box-shadow: var(--smrt-elevation-level3);
    width: 100%;
    max-width: 28rem;
    padding: 1.5rem;
  }

  .dialog-title {
    margin: 0 0 0.5rem;
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-headline-small-weight, 400);
    color: var(--smrt-color-on-surface);
    line-height: var(--smrt-typography-headline-small-line-height, 2rem);
  }

  .dialog-message {
    margin: 0 0 1rem;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
    line-height: var(--smrt-typography-body-medium-line-height, 1.25rem);
  }

  .reason-input {
    width: 100%;
    padding: 0.75rem;
    font-size: var(--smrt-typography-body-large-size, 1rem);
    font-family: inherit;
    border: 1px solid var(--smrt-color-outline);
    border-radius: var(--smrt-radius-small, 8px);
    resize: vertical;
    min-height: 80px;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }

  .reason-input:focus {
    outline: none;
    border-color: var(--smrt-color-primary);
    box-shadow: 0 0 0 1px var(--smrt-color-primary);
  }

  .reason-input:disabled {
    background: var(--smrt-color-surface-container-highest);
    color: var(--smrt-color-on-surface);
    opacity: 0.38;
    cursor: not-allowed;
  }

  .hint {
    margin: 0.5rem 0 0;
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1.5rem;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.625rem 1.5rem;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    font-weight: var(--smrt-typography-label-large-weight, 500);
    letter-spacing: var(--smrt-typography-label-large-tracking, 0.1px);
    border-radius: var(--smrt-radius-full, 9999px);
    border: none;
    cursor: pointer;
    transition: all 0.2s var(--smrt-easing-standard);
  }

  .btn:disabled {
    opacity: 0.38;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: transparent;
    color: var(--smrt-color-primary);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--smrt-color-primary);
    background: color-mix(in srgb, var(--smrt-color-primary) 8%, transparent);
  }

  .btn-error {
    background: var(--smrt-color-error);
    color: var(--smrt-color-on-error);
  }

  .btn-error:hover:not(:disabled) {
    box-shadow: var(--smrt-elevation-level1);
  }
</style>
