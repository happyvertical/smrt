<script lang="ts">
/**
 * AttachmentChip - File chip with icon, name, and size
 */
import { Button } from '@happyvertical/smrt-ui/ui';
import type { AttachmentData } from '../types.js';

export interface Props {
  /** File attachment to display with icon, name, and size. */
  attachment: AttachmentData;
  /** Called when user clicks on the attachment chip. */
  onclick?: (attachment: AttachmentData) => void;
}

const { attachment, onclick }: Props = $props();

const _icon = $derived.by(() => {
  const ct = attachment.contentType;
  if (ct.startsWith('image/')) return '🖼️';
  if (ct === 'application/pdf') return '📄';
  if (ct.startsWith('video/')) return '🎥';
  if (ct.startsWith('audio/')) return '🎧';
  return '📎';
});

const _formattedSize = $derived.by(() => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = attachment.size;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
});
</script>

{#if onclick}
  <Button
    variant="ghost"
    class="chip chip--button"
    onclick={() => onclick?.(attachment)}
    title={`${attachment.filename} (${_formattedSize})`}
  >
    <span class="smrt-attachment-chip__icon" data-smrt-part="icon">{_icon}</span>
    <span class="smrt-attachment-chip__name" data-smrt-part="name">{attachment.filename}</span>
    <span class="smrt-attachment-chip__size" data-smrt-part="size">{_formattedSize}</span>
  </Button>
{:else}
  <span class="smrt-attachment-chip__root" title={`${attachment.filename} (${_formattedSize})`} data-smrt-component="AttachmentChip">
    <span class="smrt-attachment-chip__icon" data-smrt-part="icon">{_icon}</span>
    <span class="smrt-attachment-chip__name" data-smrt-part="name">{attachment.filename}</span>
    <span class="smrt-attachment-chip__size" data-smrt-part="size">{_formattedSize}</span>
  </span>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-attachment-chip__root {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.625rem;
    cursor: default;
    max-width: 200px;
  }
  /*
  * The interactive chip now renders through smrt-ui's <Button variant="ghost">.
  * The <button> is emitted inside the Button child carrying Button's scope hash,
  * so the local `.smrt-attachment-chip__root` rule above no longer reaches it. `:global(.chip--button)`
  * pierces that scope to give the button the same chip styling plus the
  * pressable affordances; `chip--button` is a non-colliding modifier (issue
  * #1589). The non-interactive `<span class="smrt-attachment-chip__root">` branch still uses the
  * scoped `.smrt-attachment-chip__root` rule above.
  */
  :global(.chip.chip--button) {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.625rem;
    cursor: pointer;
    max-width: 200px;
  }
  .smrt-attachment-chip__icon {
    flex-shrink: 0;
  }
  .smrt-attachment-chip__name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-attachment-chip__size {
    flex-shrink: 0;
  }
}

@layer smrt.theme {
  .smrt-attachment-chip__root {
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1.33 sans-serif);
    border: none;
  }
  /*
  * The interactive chip now renders through smrt-ui's <Button variant="ghost">.
  * The <button> is emitted inside the Button child carrying Button's scope hash,
  * so the local `.smrt-attachment-chip__root` rule above no longer reaches it. `:global(.chip--button)`
  * pierces that scope to give the button the same chip styling plus the
  * pressable affordances; `chip--button` is a non-colliding modifier (issue
  * #1589). The non-interactive `<span class="smrt-attachment-chip__root">` branch still uses the
  * scoped `.smrt-attachment-chip__root` rule above.
  */
  :global(.chip.chip--button) {
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1.33 sans-serif);
    transition: background var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  :global(.chip.chip--button):hover {
    background: color-mix(in srgb, var(--smrt-color-surface-variant) 92%, var(--smrt-color-shadow));
  }
  :global(.chip.chip--button):focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 1px;
  }
  .smrt-attachment-chip__icon {
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }
  .smrt-attachment-chip__size {
    opacity: 0.7;
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
  }
}

</style>
