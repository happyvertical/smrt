<script lang="ts">
/**
 * RejectDialog - Modal dialog for rejecting with a reason
 * Requires a reason to be entered before confirming
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';

const { t } = useI18n();

/** Props for RejectDialog component */
export interface Props {
  /** Controls whether the dialog is displayed. */
  open: boolean;
  /** Dialog heading text. */
  title?: string;
  /** Instructions displayed above the reason input. */
  message?: string;
  /** Label for the confirm button. */
  confirmLabel?: string;
  /** Label for the cancel button. */
  cancelLabel?: string;
  /** Placeholder text for the reason textarea. */
  placeholder?: string;
  /** Requires the user to enter a reason before confirming. */
  required?: boolean;
  /** Disables the dialog controls during processing. */
  loading?: boolean;
  /** Invoked when the user confirms the rejection with a reason. */
  onconfirm: (reason: string) => void;
  /** Invoked when the user cancels or closes the dialog. */
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
let textarea: HTMLTextAreaElement | undefined = $state(undefined);

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
  <div class="smrt-reject-dialog__root" data-smrt-component="RejectDialog">
    <!-- raw-primitive-allow: click-catching modal backdrop; structural overlay, not a primitive -->
    <button
      type="button"
      class="smrt-reject-dialog__overlay" data-smrt-part="overlay"
      aria-label={t(M['projects.reject_dialog.close_dialog'])}
      onclick={handleCancel}
    ></button>
    <div
      class="smrt-reject-dialog__dialog" data-smrt-part="panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reject-dialog-title"
      tabindex="-1"
      onkeydown={handleKeydown}
    >
      <h2 id="reject-dialog-title" class="smrt-reject-dialog__title" data-smrt-part="title">{title}</h2>

      <p class="smrt-reject-dialog__message" data-smrt-part="message">{message}</p>

      <!-- raw-primitive-allow: base Textarea primitive cannot resolve in this package's vitest component tests (smrt-vitest does not map the smrt-svelte forms subpath alias); keep native until that shared harness gap is fixed -->
      <textarea
        bind:this={textarea}
        bind:value={reason}
        class="smrt-reject-dialog__input" data-smrt-part="input"
        placeholder={placeholder}
        rows="3"
        disabled={loading}
      ></textarea>

      {#if required && reason.trim().length === 0}
        <p class="smrt-reject-dialog__hint" data-smrt-part="hint">{t(M['projects.reject_dialog.reason_required'])}</p>
      {/if}

      <div class="smrt-reject-dialog__actions" data-smrt-part="actions">
        <Button variant="secondary" onclick={handleCancel} disabled={loading}>
          {cancelLabel}
        </Button>
        <Button
          variant="danger"
          onclick={handleConfirm}
          disabled={!canConfirm || loading}
        >
          {loading ? 'Rejecting...' : confirmLabel}
        </Button>
      </div>
    </div>
  </div>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-reject-dialog__root {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    z-index: var(--smrt-z-index-dialog, 1300);
  }
  .smrt-reject-dialog__overlay {
    position: absolute;
    inset: 0;
    cursor: pointer;
  }
  .smrt-reject-dialog__dialog {
    position: relative;
    width: 100%;
    max-width: 28rem;
    padding: 1.5rem;
  }
  .smrt-reject-dialog__title {
    margin: 0 0 0.5rem;
  }
  .smrt-reject-dialog__message {
    margin: 0 0 1rem;
  }
  .smrt-reject-dialog__input {
    width: 100%;
    padding: 0.75rem;
    resize: vertical;
    min-height: 80px;
  }
  .smrt-reject-dialog__input:disabled {
    cursor: not-allowed;
  }
  .smrt-reject-dialog__hint {
    margin: 0.5rem 0 0;
  }
  .smrt-reject-dialog__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1.5rem;
  }
}

@layer smrt.theme {
  .smrt-reject-dialog__overlay {
    border: none;
    background: var(--smrt-color-scrim, rgba(0, 0, 0, 0.32));
  }
  .smrt-reject-dialog__dialog {
    background: var(--smrt-color-surface);
    border-radius: var(--smrt-radius-extra-large);
    box-shadow: var(--smrt-elevation-3);
  }
  .smrt-reject-dialog__title {
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-headline-small-weight, 400);
    color: var(--smrt-color-on-surface);
    line-height: var(--smrt-typography-headline-small-line-height, 2rem);
  }
  .smrt-reject-dialog__message {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
    line-height: var(--smrt-typography-body-medium-line-height, 1.25rem);
  }
  .smrt-reject-dialog__input {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    font-family: inherit;
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-small);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }
  .smrt-reject-dialog__input:focus {
    outline: none;
    border-color: var(--smrt-color-primary);
    box-shadow: 0 0 0 1px var(--smrt-color-primary);
  }
  .smrt-reject-dialog__input:disabled {
    background: var(--smrt-color-surface-container-highest);
    color: var(--smrt-color-on-surface);
    opacity: 0.38;
  }
  .smrt-reject-dialog__hint {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
