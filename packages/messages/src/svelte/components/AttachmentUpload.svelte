<script lang="ts" module>
import type { AttachmentData } from '../types.js';

export interface Props {
  attachments: AttachmentData[];
  onattach?: (files: File[]) => void;
  onremove?: (index: number) => void;
  maxSize?: number;
}
</script>

<script lang="ts">
  let {
    attachments = [],
    onattach,
    onremove,
    maxSize = 25 * 1024 * 1024,
  }: Props = $props();

  let isDragOver = $state(false);

  function handleFiles(files: FileList | null) {
    if (!files) return;
    const fileArray = Array.from(files).filter((f) => f.size <= maxSize);
    onattach?.(fileArray);
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    isDragOver = false;
    handleFiles(event.dataTransfer?.files ?? null);
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
    isDragOver = true;
  }

  function handleDragLeave() {
    isDragOver = false;
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<div class="attachment-upload">
  {#if attachments.length > 0}
    <div class="attachment-list">
      {#each attachments as attachment, i}
        <div class="attachment-item">
          <span class="filename">{attachment.filename}</span>
          <span class="size">{formatSize(attachment.size)}</span>
          <button
            class="remove"
            onclick={() => onremove?.(i)}
            type="button"
          >×</button>
        </div>
      {/each}
    </div>
  {/if}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="drop-zone"
    class:drag-over={isDragOver}
    ondrop={handleDrop}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
  >
    <label class="upload-label">
      <input
        type="file"
        multiple
        class="file-input"
        onchange={(e) => handleFiles((e.target as HTMLInputElement).files)}
      />
      <span class="upload-text">Drop files or click to attach</span>
    </label>
  </div>
</div>

<style>
  .attachment-upload {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 8px);
  }

  .attachment-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-1, 4px);
  }

  .attachment-item {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    border-radius: var(--smrt-radius-sm, 8px);
    background: var(--smrt-color-surface-variant, #e7e0ec);
    font-size: var(--smrt-typography-body-medium-size, 13px);
    font-family: var(--smrt-font-family, system-ui);
  }

  .filename {
    color: var(--smrt-color-on-surface-variant, #49454f);
  }

  .size {
    color: var(--smrt-color-outline, #79747e);
    font-size: var(--smrt-typography-label-small-size, 11px);
  }

  .remove {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0 var(--smrt-spacing-1, 4px);
    color: var(--smrt-color-error, #ba1a1a);
    font-size: var(--smrt-typography-label-large-size, 14px);
  }

  .drop-zone {
    border: 2px dashed var(--smrt-color-outline-variant, #cac4d0);
    border-radius: var(--smrt-radius-md, 12px);
    padding: var(--smrt-spacing-3, 12px);
    text-align: center;
    transition: border-color var(--smrt-duration-short, 150ms) var(--smrt-easing-standard, ease);
  }

  .drop-zone.drag-over {
    border-color: var(--smrt-color-primary, #6750a4);
    background: var(--smrt-color-primary-container, #eaddff);
  }

  .upload-label {
    cursor: pointer;
  }

  .file-input {
    display: none;
  }

  .upload-text {
    color: var(--smrt-color-outline, #79747e);
    font-size: var(--smrt-typography-body-medium-size, 13px);
    font-family: var(--smrt-font-family, system-ui);
  }
</style>
