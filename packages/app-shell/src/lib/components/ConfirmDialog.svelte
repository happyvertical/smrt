<script lang="ts">
import type { Snippet } from 'svelte';

interface Props {
  open: boolean;
  title: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string;
  onconfirm: () => void;
  oncancel: () => void;
  children?: Snippet;
}

let {
  open,
  title,
  confirmLabel,
  danger = false,
  busy = false,
  error = '',
  onconfirm,
  oncancel,
  children,
}: Props = $props();

let dialog: HTMLDialogElement | undefined = $state();
const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;

$effect(() => {
  if (!dialog) return;
  if (open && !dialog.open) dialog.showModal();
  if (!open && dialog.open) dialog.close();
});
</script>

<dialog
  bind:this={dialog}
  class="smrt-app-shell__dialog"
  aria-labelledby={titleId}
  oncancel={(e) => {
    e.preventDefault();
    if (!busy) oncancel();
  }}
>
  <h2 id={titleId}>{title}</h2>
  {@render children?.()}
  {#if error}<p class="smrt-app-shell__alert smrt-app-shell__alert-error" role="alert">{error}</p>{/if}
  <div class="smrt-app-shell__dialog-actions">
    <button type="button" class="smrt-app-shell__btn" disabled={busy} onclick={oncancel}>
      Cancel
    </button>
    <button
      type="button"
      class="smrt-app-shell__btn {danger ? 'smrt-app-shell__btn-danger' : 'smrt-app-shell__btn-primary'}"
      disabled={busy}
      onclick={onconfirm}
    >
      {busy ? 'Working…' : confirmLabel}
    </button>
  </div>
</dialog>
