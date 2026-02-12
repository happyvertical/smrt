<script lang="ts">
/**
 * Modal - An accessible dialog component
 *
 * Features:
 * - Native dialog element for accessibility
 * - Backdrop click to close (optional)
 * - Escape key to close
 * - Focus trap
 * - Multiple sizes
 * - Custom header/footer via snippets
 * - Material 3 styling
 */

import type { Snippet } from 'svelte';

/** Props for Modal component */
export interface Props {
  /** Whether the modal is open */
  open?: boolean;
  /** Callback when modal requests to close */
  onClose?: () => void;
  /** Modal title */
  title?: string;
  /** Modal size variant */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** Whether clicking backdrop closes modal */
  closeOnBackdrop?: boolean;
  /** Whether pressing Escape closes modal */
  closeOnEscape?: boolean;
  /** Show close button */
  showClose?: boolean;
  /** Custom header snippet */
  header?: Snippet;
  /** Custom footer snippet */
  footer?: Snippet;
  /** Main content */
  children?: Snippet;
  /** ARIA label for the dialog */
  ariaLabel?: string;
  /** ARIA described by ID */
  ariaDescribedBy?: string;
}

let {
  open = $bindable(false),
  onClose,
  title,
  size = 'md',
  closeOnBackdrop = true,
  closeOnEscape = true,
  showClose = true,
  header,
  footer,
  children,
  ariaLabel,
  ariaDescribedBy,
}: Props = $props();

let dialogEl: HTMLDialogElement | null = $state(null);

// Sync open state with dialog
$effect(() => {
  if (!dialogEl) return;

  if (open && !dialogEl.open) {
    dialogEl.showModal();
  } else if (!open && dialogEl.open) {
    dialogEl.close();
  }
});

function handleClose() {
  open = false;
  onClose?.();
}

function handleBackdropClick(event: MouseEvent) {
  if (!closeOnBackdrop) return;

  // Only close if clicking directly on the dialog (backdrop)
  if (event.target === dialogEl) {
    handleClose();
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && closeOnEscape) {
    event.preventDefault();
    handleClose();
  }
}

function handleCancel(event: Event) {
  // Prevent default browser behavior and handle ourselves
  event.preventDefault();
  if (closeOnEscape) {
    handleClose();
  }
}

const sizeClasses = {
  sm: 'modal--sm',
  md: 'modal--md',
  lg: 'modal--lg',
  xl: 'modal--xl',
  full: 'modal--full',
};
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialogEl}
  class="modal {sizeClasses[size]}"
  onclick={handleBackdropClick}
  onkeydown={handleKeydown}
  oncancel={handleCancel}
  aria-label={ariaLabel ?? title}
  aria-describedby={ariaDescribedBy}
>
  <div class="modal__container" onclick={(e) => e.stopPropagation()}>
    {#if header}
      <header class="modal__header modal__header--custom">
        {@render header()}
      </header>
    {:else if title || showClose}
      <header class="modal__header">
        {#if title}
          <h2 class="modal__title">{title}</h2>
        {:else}
          <span></span>
        {/if}
        {#if showClose}
          <button
            type="button"
            class="modal__close"
            onclick={handleClose}
            aria-label="Close modal"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        {/if}
      </header>
    {/if}

    <div class="modal__body">
      {#if children}
        {@render children()}
      {/if}
    </div>

    {#if footer}
      <footer class="modal__footer">
        {@render footer()}
      </footer>
    {/if}
  </div>
</dialog>

<style>
  .modal {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
    margin: 0;
    padding: 0;
    border: none;
    background: transparent;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .modal::backdrop {
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(2px);
  }

  .modal:not([open]) {
    display: none;
  }

  .modal__container {
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - var(--smrt-spacing-8, 2rem));
    max-width: calc(100vw - var(--smrt-spacing-8, 2rem));
    background: var(--smrt-color-surface, #ffffff);
    border-radius: var(--smrt-radius-large, 0.75rem);
    box-shadow: var(--smrt-elevation-level3, 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05));
    overflow: hidden;
    animation: modal-enter var(--smrt-duration-medium2, 300ms) var(--smrt-easing-emphasized, cubic-bezier(0.2, 0, 0, 1));
  }

  @keyframes modal-enter {
    from {
      opacity: 0;
      transform: scale(0.9) translateY(-16px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .modal__container {
      animation: none;
    }
  }

  /* Size variants */
  .modal--sm .modal__container {
    width: 100%;
    max-width: 24rem; /* 384px */
  }

  .modal--md .modal__container {
    width: 100%;
    max-width: 32rem; /* 512px */
  }

  .modal--lg .modal__container {
    width: 100%;
    max-width: 48rem; /* 768px */
  }

  .modal--xl .modal__container {
    width: 100%;
    max-width: 64rem; /* 1024px */
  }

  .modal--full .modal__container {
    width: calc(100vw - var(--smrt-spacing-8, 2rem));
    height: calc(100vh - var(--smrt-spacing-8, 2rem));
    max-width: none;
    max-height: none;
    border-radius: var(--smrt-radius-medium, 0.5rem);
  }

  /* Header */
  .modal__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-3, 0.75rem);
    padding: var(--smrt-spacing-4, 1rem) var(--smrt-spacing-5, 1.25rem);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    flex-shrink: 0;
  }

  .modal__header--custom {
    padding: 0;
    border-bottom: none;
  }

  .modal__title {
    margin: 0;
    font-size: var(--smrt-typography-headline-small-size, 1.125rem);
    font-weight: 600;
    color: var(--smrt-color-on-surface, #1b1b1f);
    line-height: 1.4;
  }

  .modal__close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: none;
    background: transparent;
    border-radius: var(--smrt-radius-full, 9999px);
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
    transition: all var(--smrt-duration-short3, 150ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
    flex-shrink: 0;
  }

  .modal__close:hover {
    background: var(--smrt-color-surface-container-highest, #e0e2ec);
    color: var(--smrt-color-on-surface, #1b1b1f);
  }

  .modal__close:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: 2px;
  }

  /* Body */
  .modal__body {
    flex: 1;
    padding: var(--smrt-spacing-5, 1.25rem);
    overflow-y: auto;
    color: var(--smrt-color-on-surface, #1b1b1f);
  }

  /* Footer */
  .modal__footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--smrt-spacing-3, 0.75rem);
    padding: var(--smrt-spacing-4, 1rem) var(--smrt-spacing-5, 1.25rem);
    border-top: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    flex-shrink: 0;
  }

  /* Responsive */
  @media (max-width: 640px) {
    .modal__container {
      max-height: calc(100vh - var(--smrt-spacing-4, 1rem));
      max-width: calc(100vw - var(--smrt-spacing-4, 1rem));
    }

    .modal--sm .modal__container,
    .modal--md .modal__container,
    .modal--lg .modal__container,
    .modal--xl .modal__container {
      max-width: calc(100vw - var(--smrt-spacing-4, 1rem));
    }
  }
</style>
