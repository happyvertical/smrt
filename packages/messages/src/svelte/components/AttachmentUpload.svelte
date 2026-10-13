<script lang="ts" module>
import type { AttachmentData } from '../types.js';

export interface Props {
  /** Array of already attached files to display. */
  attachments: AttachmentData[];
  /** Called when user drops or selects files to attach. */
  onattach?: (files: File[]) => void;
  /** Called when user removes an attachment by its index. */
  onremove?: (index: number) => void;
  /** Maximum file size in bytes; files exceeding this are rejected. */
  maxSize?: number;
}
</script>

<script lang="ts">
  import { useI18n } from '@happyvertical/smrt-ui/i18n';
  import { Button } from '@happyvertical/smrt-ui/ui';
  import { M } from '../i18n.js';

  const { t } = useI18n();

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

<div class="attachment-upload" data-smrt-component="AttachmentUpload">
  {#if attachments.length > 0}
    <div class="attachment-list">
      {#each attachments as attachment, i}
        <div class="attachment-item">
          <span class="filename">{attachment.filename}</span>
          <span class="size">{formatSize(attachment.size)}</span>
          <Button
            variant="ghost"
            size="sm"
            class="remove"
            onclick={() => onremove?.(i)}
          >×</Button>
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
      <!-- raw-primitive-allow: native file input — the Input primitive binds value, which is invalid for type=file (throws InvalidStateError on the bind write-back) and renders a visible control; this hidden picker behind the drop zone stays native -->
      <input
        type="file"
        multiple
        class="file-input"
        onchange={(e) => handleFiles((e.currentTarget as HTMLInputElement).files)}
      />
      <span class="upload-text">{t(M['messages.attachment_upload.drop_files'])}</span>
    </label>
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .attachment-upload {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2);
  }

  .attachment-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-1);
  }

  .attachment-item {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
    border-radius: var(--smrt-radius-sm);
    background: var(--smrt-color-surface-variant);
    font-size: var(--smrt-typography-body-medium-size);
    font-family: var(--smrt-font-family, system-ui);
  }

  .filename {
    color: var(--smrt-color-on-surface-variant);
  }

  .size {
    color: var(--smrt-color-outline);
    font-size: var(--smrt-typography-label-small-size);
  }

  /*
   * The remove button now renders through smrt-ui's <Button variant="ghost">.
   * The <button> lives inside the Button child, so `.attachment-item :global(.remove)`
   * anchors on the real `.attachment-item` element and pierces the child scope to
   * keep the compact error-colored icon styling (issue #1589).
   */
  .attachment-item :global(.remove) {
    background: none;
    border: none;
    padding: 0 var(--smrt-spacing-1);
    color: var(--smrt-color-error);
    font-size: var(--smrt-typography-label-large-size);
  }

  .drop-zone {
    border: 2px dashed var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md);
    padding: var(--smrt-spacing-3);
    text-align: center;
    transition: border-color var(--smrt-duration-fast, 150ms) var(--smrt-easing-standard, ease);
  }

  .drop-zone.drag-over {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary-container);
  }

  .upload-label {
    cursor: pointer;
  }

  /*
   * The native file input stays visually hidden — the visible affordance is the
   * `.upload-text` label inside the styled drop-zone (issue #1589).
   */
  .upload-label .file-input {
    display: none;
  }

  .upload-text {
    color: var(--smrt-color-outline);
    font-size: var(--smrt-typography-body-medium-size);
    font-family: var(--smrt-font-family, system-ui);
  }
}
</style>
