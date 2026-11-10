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
import { M } from '../../i18n/strings.ui.js';
import { useI18n } from '../../i18n/use-i18n.js';

const { t } = useI18n();

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
  /** Placement: center (default), start, or end for full-height drawers */
  placement?: 'center' | 'start' | 'end';
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
  /** Target density; omit to inherit the ThemeProvider setting. */
  density?: 'comfortable' | 'touch';
}

let {
  open = $bindable(false),
  onClose,
  title,
  size = 'md',
  placement = 'center',
  closeOnBackdrop = true,
  closeOnEscape = true,
  showClose = true,
  header,
  footer,
  children,
  ariaLabel,
  ariaDescribedBy,
  density,
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
  sm: 'smrt-modal__sm',
  md: 'smrt-modal__md',
  lg: 'smrt-modal__lg',
  xl: 'smrt-modal__xl',
  full: 'smrt-modal__full',
};

const placementClass = $derived(`smrt-modal__${placement}`);
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialogEl}
  class="smrt-modal__root {sizeClasses[size]} {placementClass}"
  onclick={handleBackdropClick}
  onkeydown={handleKeydown}
  oncancel={handleCancel}
  aria-label={ariaLabel ?? title}
  aria-describedby={ariaDescribedBy} data-density={density} data-smrt-component="Modal"
>
  <div class="smrt-modal__container" data-smrt-part="panel">
    {#if header}
      <header class="smrt-modal__header smrt-modal__header--custom" data-smrt-part="header">
        {@render header()}
      </header>
    {:else if title || showClose}
      <header class="smrt-modal__header" data-smrt-part="header">
        {#if title}
          <h2 class="smrt-modal__title" data-smrt-part="title">{title}</h2>
        {:else}
          <span></span>
        {/if}
        {#if showClose}
          <button
            type="button"
            class="smrt-modal__close" data-smrt-part="close"
            onclick={handleClose}
            aria-label={t(M['ui.modal.close'])}
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

    <div class="smrt-modal__body" data-smrt-part="body">
      {#if children}
        {@render children()}
      {/if}
    </div>

    {#if footer}
      <footer class="smrt-modal__footer" data-smrt-part="footer">
        {@render footer()}
      </footer>
    {/if}
  </div>
</dialog>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-modal__root {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
    margin: 0;
    padding: 0;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .smrt-modal__root:not([open]) {
    display: none;
  }
  /* Density overrides the hit size of the close control and any control it
  contains, so they belong with the other hit-area geometry. */
  .smrt-modal__root[data-density='touch'] {
    --smrt-control-target-min: var(--smrt-touch-target-min);
  }
  .smrt-modal__root[data-density='comfortable'] {
    --smrt-control-target-min: 0px;
  }
  .smrt-modal__container {
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - var(--smrt-spacing-8, 2rem));
    max-width: calc(100vw - var(--smrt-spacing-8, 2rem));
    overflow: hidden;
  }
  /* Size variants */
  .smrt-modal__sm .smrt-modal__container {
    width: 100%;
    max-width: 24rem;
  }
  .smrt-modal__md .smrt-modal__container {
    width: 100%;
    max-width: 32rem;
  }
  .smrt-modal__lg .smrt-modal__container {
    width: 100%;
    max-width: 48rem;
  }
  .smrt-modal__xl .smrt-modal__container {
    width: 100%;
    max-width: 64rem;
  }
  .smrt-modal__full .smrt-modal__container {
    width: calc(100vw - var(--smrt-spacing-8, 2rem));
    height: calc(100vh - var(--smrt-spacing-8, 2rem));
    max-width: none;
    max-height: none;
  }
  /* Placement: end = right-anchored, full-height drawer (e.g. detail panels).
  The size variant still sets the panel width. */
  .smrt-modal__start,
  .smrt-modal__end {
    justify-content: flex-end;
    align-items: stretch;
  }
  .smrt-modal__start {
    justify-content: flex-start;
  }
  .smrt-modal__start .smrt-modal__container,
  .smrt-modal__end .smrt-modal__container {
    height: 100%;
    max-height: 100%;
  }
  /* Header */
  .smrt-modal__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-3, 0.75rem);
    padding: var(--smrt-spacing-4, 1rem) var(--smrt-spacing-5, 1.25rem);
    flex-shrink: 0;
  }
  .smrt-modal__header--custom {
    padding: 0;
  }
  .smrt-modal__title {
    margin: 0;
  }
  .smrt-modal__close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: max(32px, var(--smrt-control-target-min));
    height: max(32px, var(--smrt-control-target-min));
    padding: 0;
    cursor: pointer;
    flex-shrink: 0;
  }
  /* Body */
  .smrt-modal__body {
    flex: 1;
    padding: var(--smrt-spacing-5, 1.25rem);
    overflow-y: auto;
  }
  /* A form's action bar in the body (a dialog that is one form, such as a
  widget's options) stays in view at the foot of the scrolling body, as a
  footer does, however long the form. Phones already pin it to the screen. */
  @media (width > 48rem) {
    .smrt-modal__body :global([data-form-action-bar]) {
      position: sticky;
      inset-block-end: calc(-1 * var(--smrt-spacing-5, 1.25rem));
      z-index: 1;
      margin-inline: calc(-1 * var(--smrt-spacing-5, 1.25rem));
      margin-block-end: calc(-1 * var(--smrt-spacing-5, 1.25rem));
      padding: var(--smrt-spacing-4, 1rem) var(--smrt-spacing-5, 1.25rem);
    }
  }
  /* Footer */
  .smrt-modal__footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--smrt-spacing-3, 0.75rem);
    padding: var(--smrt-spacing-4, 1rem) var(--smrt-spacing-5, 1.25rem);
    flex-shrink: 0;
  }
  /* Responsive */
  @media (max-width: 640px) {
    .smrt-modal__container {
      max-height: calc(100vh - var(--smrt-spacing-4, 1rem));
      max-width: calc(100vw - var(--smrt-spacing-4, 1rem));
    }
    .smrt-modal__sm .smrt-modal__container,
    .smrt-modal__md .smrt-modal__container,
    .smrt-modal__lg .smrt-modal__container,
    .smrt-modal__xl .smrt-modal__container {
      max-width: calc(100vw - var(--smrt-spacing-4, 1rem));
    }
    /* A drawer goes full-bleed on mobile — no backdrop strip. Declared after the
    size-cap rule above so it wins for end placement regardless of size. */
    .smrt-modal__end .smrt-modal__container {
      width: 100%;
      max-width: 100%;
      max-height: 100%;
    }
  }
}

@layer smrt.theme {
  .smrt-modal__root {
    border: none;
    background: transparent;
  }
  .smrt-modal__root::backdrop {
    background: var(--smrt-surface-overlay);
    backdrop-filter: blur(var(--smrt-glass-blur));
  }
  .smrt-modal__container {
    background: var(--smrt-glass-surface-strong);
    backdrop-filter: blur(var(--smrt-glass-blur)) saturate(var(--smrt-glass-saturation));
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-large, 0.75rem);
    box-shadow: var(--smrt-inset-highlight), var(--smrt-elevation-4);
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
    .smrt-modal__container {
      animation: none;
    }
  }
  /* Size variants */
  .smrt-modal__full .smrt-modal__container {
    border-radius: var(--smrt-radius-medium, 0.5rem);
  }
  .smrt-modal__start .smrt-modal__container,
  .smrt-modal__end .smrt-modal__container {
    border-radius: var(--smrt-radius-none, 0);
    animation: modal-slide-end var(--smrt-duration-medium2, 300ms)
      var(--smrt-easing-emphasized, cubic-bezier(0.2, 0, 0, 1));
  }
  @keyframes modal-slide-end {
    from {
      opacity: 0;
      transform: translateX(100%);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-modal__end .smrt-modal__container {
      animation: none;
    }
  }
  /* Header */
  .smrt-modal__header {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-modal__header--custom {
    border-bottom: none;
  }
  .smrt-modal__title {
    font-size: var(--smrt-typography-headline-small-size, 1.125rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface);
    line-height: var(--smrt-typography-headline-small-line-height, 1.4);
  }
  .smrt-modal__close {
    border: none;
    background: transparent;
    border-radius: var(--smrt-radius-full);
    color: var(--smrt-color-on-surface-variant);
    transition: all var(--smrt-duration-short3, 150ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
  }
  .smrt-modal__close:hover {
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent);
    color: var(--smrt-color-on-surface);
  }
  .smrt-modal__close:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  /* Body */
  .smrt-modal__body {
    color: var(--smrt-color-on-surface);
  }
  /* A form's action bar in the body (a dialog that is one form, such as a
  widget's options) stays in view at the foot of the scrolling body, as a
  footer does, however long the form. Phones already pin it to the screen. */
  @media (width > 48rem) {
    .smrt-modal__body :global([data-form-action-bar]) {
      background: var(--smrt-glass-surface-strong);
      backdrop-filter: blur(var(--smrt-glass-blur)) saturate(var(--smrt-glass-saturation));
    }
  }
  /* Footer */
  .smrt-modal__footer {
    border-top: var(--smrt-hairline);
  }
}

</style>
