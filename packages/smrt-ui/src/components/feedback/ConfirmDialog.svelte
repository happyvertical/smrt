<script lang="ts">
/**
 * ConfirmDialog - Modal confirmation dialog
 * refactored for Material 3
 *
 * Provides a consistent confirmation dialog for destructive actions
 * or important decisions.
 *
 * Native showModal() puts confirmations above existing Modal/Drawer surfaces,
 * traps focus and makes the background inert. Escape is handled locally so
 * only the active confirmation requests cancellation.
 */
import { type Snippet, tick } from 'svelte';
import { ripple } from '../../actions/ripple.js';

/** Props for ConfirmDialog component */
export interface Props {
  /** Whether the dialog is open */
  open: boolean;
  /** Dialog title */
  title: string;
  /** Plain text or rich message snippet */
  message: string | Snippet;
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

const instanceId = $props.id();
let backdropEl = $state<HTMLDialogElement | null>(null);
let confirmBtnEl = $state<HTMLButtonElement | null>(null);
// The element focused before the dialog opened, restored on close.
let previouslyFocused: HTMLElement | null = null;

function focusableEls(): HTMLElement[] {
  if (!backdropEl) return [];
  return Array.from(
    backdropEl.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

// Keep the parent's open prop authoritative; native cancellation requests it.
$effect(() => {
  const dialog = backdropEl;
  if (!open || !dialog) return;
  previouslyFocused = document.activeElement as HTMLElement | null;
  dialog.showModal();
  void tick().then(() => {
    if (!dialog.open) return;
    const target = confirmBtnEl?.disabled
      ? (focusableEls()[0] ?? dialog)
      : confirmBtnEl;
    target?.focus();
  });
  return () => {
    if (dialog.open) dialog.close();
    previouslyFocused?.focus();
    previouslyFocused = null;
  };
});

function handleCancel(event: Event) {
  event.preventDefault();
  event.stopPropagation();
  oncancel?.();
}

function handleBackdropClick(e: MouseEvent) {
  if (e.target === e.currentTarget) {
    oncancel?.();
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    handleCancel(e);
    return;
  }
  if (e.key !== 'Tab') return;

  // Trap focus within the dialog so Tab can't escape to the page behind.
  const focusables = focusableEls();
  if (focusables.length === 0) {
    e.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;

  if (e.shiftKey) {
    if (active === first || !backdropEl?.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else if (active === last || !backdropEl?.contains(active)) {
    e.preventDefault();
    first.focus();
  }
}
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <dialog
    bind:this={backdropEl}
    class="dialog-backdrop"
    aria-modal="true"
    aria-labelledby={`${instanceId}-title`}
    aria-describedby={`${instanceId}-message`}
    tabindex="-1"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
    oncancel={handleCancel}
  >
    <div class="dialog-content">
      <h2 id={`${instanceId}-title`} class="dialog-title">{title}</h2>
      <div id={`${instanceId}-message`} class="dialog-message">
        {#if typeof message === 'string'}
          {message}
        {:else}
          {@render message()}
        {/if}
      </div>

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
          bind:this={confirmBtnEl}
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
  </dialog>
{/if}

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
    margin: 0;
    border: none;
    box-sizing: border-box;
    background: transparent;
    padding: 1rem;
  }

  .dialog-backdrop::backdrop {
    background-color: var(--smrt-color-scrim, rgba(0, 0, 0, 0.4));
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
    font-weight: var(--smrt-typography-weight-medium, 500);
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