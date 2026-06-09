<script lang="ts">
/**
 * AttachmentChip - File chip with icon, name, and size
 */
import type { AttachmentData } from '../types.js';

export interface Props {
  attachment: AttachmentData;
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
  <button
    class="chip"
    type="button"
    onclick={() => onclick?.(attachment)}
    title={`${attachment.filename} (${_formattedSize})`}
  >
    <span class="icon">{_icon}</span>
    <span class="name">{attachment.filename}</span>
    <span class="size">{_formattedSize}</span>
  </button>
{:else}
  <span class="chip" title={`${attachment.filename} (${_formattedSize})`}>
    <span class="icon">{_icon}</span>
    <span class="name">{attachment.filename}</span>
    <span class="size">{_formattedSize}</span>
  </span>
{/if}

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.625rem;
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: var(--smrt-color-surface-variant, #e1e2ec);
    color: var(--smrt-color-on-surface-variant, #43474e);
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1.33 sans-serif);
    border: none;
    cursor: default;
    max-width: 200px;
  }

  button.chip {
    cursor: pointer;
    transition: background var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  button.chip:hover {
    background: color-mix(in srgb, var(--smrt-color-surface-variant, #e1e2ec) 92%, var(--smrt-color-shadow, #000));
  }

  button.chip:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: 1px;
  }

  .icon {
    flex-shrink: 0;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .size {
    flex-shrink: 0;
    opacity: 0.7;
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
  }
</style>
