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
    background-color: var(--smrt-color-scrim, rgba(0, 0, 0, 0.4));
    z-index: var(--smrt-z-index-dialog, 1000);
    padding: 1rem;
    backdrop-filter: blur(2px);
  }

  .dialog-content {
    background-color: var(--smrt-color-surface-container-high);
    border-radius: var(--smrt-radius-3xl, 32px);
    padding: var(--smrt-spacing-6, 24px);
    max-width: 400px;
    width: 100%;
    box-shadow: var(--smrt-elevation-3);
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
    font: var(--smrt-typography-headline-small-font);
    color: var(--smrt-color-on-surface);
    margin: 0 0 var(--smrt-spacing-4, 16px);
  }

  .dialog-message {
    font: var(--smrt-typography-body-medium-font);
    color: var(--smrt-color-on-surface-variant);
    margin: 0 0 var(--smrt-spacing-6, 24px);
    line-height: 1.5;
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--smrt-spacing-2, 8px);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-2, 8px);
    height: 40px;
    padding: 0 var(--smrt-spacing-6, 24px);
    font: var(--smrt-typography-label-large-font);
    font-weight: 500;
    border-radius: var(--smrt-radius-2xl, 24px);
    cursor: pointer;
    transition: all var(--smrt-duration-short3, 200ms) var(--smrt-easing-standard, ease);
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
    color: var(--smrt-color-primary);
    padding: 0 var(--smrt-spacing-3, 12px);
  }

  .btn-text:hover:not(:disabled) {
    background-color: var(--smrt-color-surface-container-highest);
  }

  .btn-filled {
    background-color: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    box-shadow: var(--smrt-elevation-1);
  }

  .btn-filled:hover:not(:disabled) {
    box-shadow: var(--smrt-elevation-2);
  }

  .btn-filled.destructive {
    background-color: var(--smrt-color-error);
    color: var(--smrt-color-on-error);
  }

  .spinner {
    width: 18px;
    height: 18px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: var(--smrt-radius-full, 9999px);
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