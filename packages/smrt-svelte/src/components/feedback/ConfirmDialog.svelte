<script lang="ts">
/**
 * ConfirmDialog - Modal confirmation dialog
 * refactored for Material 3
 *
 * Provides a consistent confirmation dialog for destructive actions
 * or important decisions.
 */
import { ripple } from '../../actions/ripple.js';

/** Props for ConfirmDialog component */
export interface Props {
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
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="dialog-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dialog-title"
    tabindex="-1"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
  >
    <div class="dialog-content">
      <h2 id="dialog-title" class="dialog-title">{title}</h2>
      <p class="dialog-message">{message}</p>

      <div class="dialog-actions">
        <button
          type="button"
          class="btn btn-text"
          onclick={oncancel}
          disabled={loading}
          use:ripple
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          class="btn btn-filled"
          class:destructive
          onclick={onconfirm}
          disabled={loading}
          use:ripple
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
    background-color: rgba(0, 0, 0, 0.4);
    z-index: var(--md-sys-z-index-dialog, 1000);
    padding: 1rem;
    backdrop-filter: blur(2px);
  }

  .dialog-content {
    background-color: var(--md-sys-color-surface-container-high);
    border-radius: 28px;
    padding: 24px;
    max-width: 400px;
    width: 100%;
    box-shadow: var(--md-sys-elevation-level3);
    animation: dialogEnter 300ms cubic-bezier(0.2, 0, 0, 1);
    display: flex;
    flex-direction: column;
  }

  @keyframes dialogEnter {
    from {
      opacity: 0;
      transform: translateY(20px) scale(0.9);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .dialog-title {
    font: var(--md-sys-typescale-headline-small-font);
    color: var(--md-sys-color-on-surface);
    margin: 0 0 16px;
  }

  .dialog-message {
    font: var(--md-sys-typescale-body-medium-font);
    color: var(--md-sys-color-on-surface-variant);
    margin: 0 0 24px;
    line-height: 1.5;
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 40px;
    padding: 0 24px;
    font: var(--md-sys-typescale-label-large-font);
    font-weight: 500;
    border-radius: 20px;
    cursor: pointer;
    transition: all 200ms;
    border: none;
    position: relative;
    overflow: hidden;
  }

  .btn:disabled {
    opacity: 0.38;
    cursor: not-allowed;
  }

  .btn-text {
    background: transparent;
    color: var(--md-sys-color-primary);
    padding: 0 12px;
  }

  .btn-text:hover:not(:disabled) {
    background-color: var(--md-sys-color-surface-container-highest);
  }

  .btn-filled {
    background-color: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
    box-shadow: var(--md-sys-elevation-level1);
  }

  .btn-filled:hover:not(:disabled) {
    box-shadow: var(--md-sys-elevation-level2);
  }

  .btn-filled.destructive {
    background-color: var(--md-sys-color-error);
    color: var(--md-sys-color-on-error);
  }

  .spinner {
    width: 18px;
    height: 18px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dialog-content {
      animation: none;
    }
    .spinner {
      animation: none;
    }
  }
</style>