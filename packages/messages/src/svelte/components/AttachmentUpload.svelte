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

<div class="smrt-attachment-upload__root" data-smrt-component="AttachmentUpload">
  {#if attachments.length > 0}
    <div class="smrt-attachment-upload__list" data-smrt-part="list">
      {#each attachments as attachment, i}
        <div class="smrt-attachment-upload__item" data-smrt-part="item">
          <span class="smrt-attachment-upload__name" data-smrt-part="name">{attachment.filename}</span>
          <span class="smrt-attachment-upload__size" data-smrt-part="size">{formatSize(attachment.size)}</span>
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
    class="smrt-attachment-upload__field"
    class:smrt-attachment-upload__drag-over={isDragOver}
    ondrop={handleDrop}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
  >
    <label class="smrt-attachment-upload__label" data-smrt-part="label">
      <!-- raw-primitive-allow: native file input — the Input primitive binds value, which is invalid for type=file (throws InvalidStateError on the bind write-back) and renders a visible control; this hidden picker behind the drop zone stays native -->
      <input
        type="file"
        multiple
        class="smrt-attachment-upload__input"
        data-smrt-part="input"
        onchange={(e) => handleFiles((e.currentTarget as HTMLInputElement).files)}
      />
      <span class="smrt-attachment-upload__message" data-smrt-part="message">{t(M['messages.attachment_upload.drop_files'])}</span>
    </label>
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-attachment-upload__root {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2);
  }
  .smrt-attachment-upload__list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-1);
  }
  .smrt-attachment-upload__item {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
  }
  /*
  * The remove button now renders through smrt-ui's <Button variant="ghost">.
  * The <button> lives inside the Button child, so `.smrt-attachment-upload__item :global(.remove)`
  * anchors on the real `.smrt-attachment-upload__item` element and pierces the child scope to
  * keep the compact error-colored icon styling (issue #1589).
  */
  .smrt-attachment-upload__item :global(.remove) {
    padding: 0 var(--smrt-spacing-1);
  }
  .smrt-attachment-upload__field {
    padding: var(--smrt-spacing-3);
  }
  .smrt-attachment-upload__label {
    cursor: pointer;
  }
  /*
  * The native file input stays visually hidden — the visible affordance is the
  * `.smrt-attachment-upload__message` label inside the styled drop-zone (issue #1589).
  */
  .smrt-attachment-upload__label .smrt-attachment-upload__input {
    display: none;
  }
}

@layer smrt.theme {
  .smrt-attachment-upload__item {
    border-radius: var(--smrt-radius-sm);
    background: var(--smrt-color-surface-variant);
    font-size: var(--smrt-typography-body-medium-size);
    font-family: var(--smrt-font-family, system-ui);
  }
  .smrt-attachment-upload__name {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-attachment-upload__size {
    color: var(--smrt-color-outline);
    font-size: var(--smrt-typography-label-small-size);
  }
  /*
  * The remove button now renders through smrt-ui's <Button variant="ghost">.
  * The <button> lives inside the Button child, so `.smrt-attachment-upload__item :global(.remove)`
  * anchors on the real `.smrt-attachment-upload__item` element and pierces the child scope to
  * keep the compact error-colored icon styling (issue #1589).
  */
  .smrt-attachment-upload__item :global(.remove) {
    background: none;
    border: none;
    color: var(--smrt-color-error);
    font-size: var(--smrt-typography-label-large-size);
  }
  .smrt-attachment-upload__field {
    border: 2px dashed var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md);
    text-align: center;
    transition: border-color var(--smrt-duration-fast, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-attachment-upload__field.smrt-attachment-upload__drag-over {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary-container);
  }
  .smrt-attachment-upload__message {
    color: var(--smrt-color-outline);
    font-size: var(--smrt-typography-body-medium-size);
    font-family: var(--smrt-font-family, system-ui);
  }
}

</style>
