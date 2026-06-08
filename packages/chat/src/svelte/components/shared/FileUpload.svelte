<script lang="ts">
/**
 * FileUpload - Attachment upload UI
 * Button with drag-and-drop zone. Shows file preview before upload.
 * Supports file type filtering and max size constraints.
 */

export interface Props {
  /** Callback when files are selected */
  onupload: (files: FileList) => void;
  /** Accepted file types (e.g., "image/*,.pdf") */
  accept?: string;
  /** Maximum file size in bytes */
  maxSize?: number;
  /** Whether the upload is disabled */
  disabled?: boolean;
}

const {
  onupload,
  accept,
  maxSize = 25 * 1024 * 1024,
  disabled = false,
}: Props = $props();

let isDragOver = $state(false);
let pendingFiles = $state<File[]>([]);
let sizeError = $state('');

function validateAndStage(fileList: FileList | null) {
  if (!fileList || fileList.length === 0) return;
  sizeError = '';

  const valid: File[] = [];
  const oversized: string[] = [];

  for (const file of Array.from(fileList)) {
    if (file.size > maxSize) {
      oversized.push(file.name);
    } else {
      valid.push(file);
    }
  }

  if (oversized.length > 0) {
    sizeError = `${oversized.join(', ')} exceed${oversized.length === 1 ? 's' : ''} the ${formatSize(maxSize)} limit`;
  }

  pendingFiles = [...pendingFiles, ...valid];
}

function handleDrop(event: DragEvent) {
  event.preventDefault();
  isDragOver = false;
  if (disabled) return;
  validateAndStage(event.dataTransfer?.files ?? null);
}

function handleDragOver(event: DragEvent) {
  event.preventDefault();
  if (!disabled) isDragOver = true;
}

function handleDragLeave() {
  isDragOver = false;
}

function handleInputChange(event: Event) {
  const input = event.target as HTMLInputElement;
  validateAndStage(input.files);
  input.value = '';
}

function removePending(index: number) {
  pendingFiles = pendingFiles.filter((_, i) => i !== index);
  if (pendingFiles.length === 0) sizeError = '';
}

function confirmUpload() {
  if (pendingFiles.length === 0) return;
  const dt = new DataTransfer();
  for (const file of pendingFiles) {
    dt.items.add(file);
  }
  onupload(dt.files);
  pendingFiles = [];
  sizeError = '';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(type: string): string {
  if (type.startsWith('image/')) return 'img';
  if (type.startsWith('video/')) return 'vid';
  if (type.startsWith('audio/')) return 'aud';
  if (type === 'application/pdf') return 'pdf';
  return 'file';
}
</script>

<div class="file-upload" class:file-upload--disabled={disabled}>
  {#if pendingFiles.length > 0}
    <div class="file-upload__preview" aria-label="Files to upload">
      {#each pendingFiles as file, i (file.name + i)}
        <div class="file-upload__file">
          <span class="file-upload__file-icon">{getFileIcon(file.type)}</span>
          <div class="file-upload__file-info">
            <span class="file-upload__file-name">{file.name}</span>
            <span class="file-upload__file-size">{formatSize(file.size)}</span>
          </div>
          <button
            class="file-upload__file-remove"
            type="button"
            onclick={() => removePending(i)}
            aria-label="Remove {file.name}"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
      {/each}

      <div class="file-upload__preview-actions">
        <button
          class="file-upload__confirm-btn"
          type="button"
          onclick={confirmUpload}
        >
          Upload {pendingFiles.length} file{pendingFiles.length !== 1 ? 's' : ''}
        </button>
        <button
          class="file-upload__clear-btn"
          type="button"
          onclick={() => { pendingFiles = []; sizeError = ''; }}
        >
          Clear
        </button>
      </div>
    </div>
  {/if}

  {#if sizeError}
    <div class="file-upload__error" role="alert">
      {sizeError}
    </div>
  {/if}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="file-upload__drop-zone"
    class:file-upload__drop-zone--active={isDragOver}
    class:file-upload__drop-zone--disabled={disabled}
    ondrop={handleDrop}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
  >
    <label class="file-upload__label">
      <input
        type="file"
        class="file-upload__input"
        {accept}
        multiple
        {disabled}
        onchange={handleInputChange}
      />
      <svg class="file-upload__icon" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z" />
      </svg>
      <span class="file-upload__text">
        {#if disabled}
          Upload disabled
        {:else}
          Drop files here or click to browse
        {/if}
      </span>
      <span class="file-upload__hint">Max {formatSize(maxSize)} per file</span>
    </label>
  </div>
</div>

<style>
  .file-upload {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 8px);
  }

  .file-upload--disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  .file-upload__drop-zone {
    border: 2px dashed var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: var(--smrt-radius-large, 12px);
    padding: var(--smrt-spacing-5, 20px);
    text-align: center;
    transition:
      border-color var(--smrt-duration-short2, 150ms),
      background var(--smrt-duration-short2, 150ms);
  }

  .file-upload__drop-zone--active {
    border-color: var(--smrt-color-primary, #005ac1);
    background: var(--smrt-color-primary-container, #d6e3ff);
  }

  .file-upload__drop-zone--disabled {
    cursor: not-allowed;
  }

  .file-upload__label {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    cursor: pointer;
  }

  .file-upload__drop-zone--disabled .file-upload__label {
    cursor: not-allowed;
  }

  .file-upload__input {
    display: none;
  }

  .file-upload__icon {
    color: var(--smrt-color-outline, #74777f);
  }

  .file-upload__text {
    font: var(--smrt-typography-body-medium-font, 0.875rem/1.4 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .file-upload__hint {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-outline, #74777f);
  }

  .file-upload__preview {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
    padding: var(--smrt-spacing-2, 8px);
    background: var(--smrt-color-surface-container-low, #f7f7fb);
    border-radius: var(--smrt-radius-medium, 8px);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
  }

  .file-upload__file {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-2, 8px);
    border-radius: var(--smrt-radius-small, 4px);
    background: var(--smrt-color-surface, #fefbff);
  }

  .file-upload__file-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--smrt-radius-small, 4px);
    background: var(--smrt-color-surface-variant, #e1e2ec);
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .file-upload__file-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
    min-width: 0;
  }

  .file-upload__file-name {
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .file-upload__file-size {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-outline, #74777f);
  }

  .file-upload__file-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    background: none;
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
    border-radius: var(--smrt-radius-full, 9999px);
    flex-shrink: 0;
    transition: background var(--smrt-duration-short2, 150ms);
  }

  .file-upload__file-remove:hover {
    background: var(--smrt-color-error-container, #ffdad6);
    color: var(--smrt-color-error, #ba1a1a);
  }

  .file-upload__preview-actions {
    display: flex;
    gap: var(--smrt-spacing-2, 8px);
    padding-top: var(--smrt-spacing-1, 4px);
  }

  .file-upload__confirm-btn {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-4, 16px);
    border: none;
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
    font: var(--smrt-typography-label-large-font, 500 0.875rem/1.25 sans-serif);
    cursor: pointer;
    transition: opacity var(--smrt-duration-short2, 150ms);
  }

  .file-upload__confirm-btn:hover {
    opacity: 0.85;
  }

  .file-upload__confirm-btn:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: 2px;
  }

  .file-upload__clear-btn {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-4, 16px);
    border: 1px solid var(--smrt-color-outline, #74777f);
    border-radius: var(--smrt-radius-full, 9999px);
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #43474e);
    font: var(--smrt-typography-label-large-font, 500 0.875rem/1.25 sans-serif);
    cursor: pointer;
    transition: background var(--smrt-duration-short2, 150ms);
  }

  .file-upload__clear-btn:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .file-upload__error {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border-radius: var(--smrt-radius-small, 4px);
    background: var(--smrt-color-error-container, #ffdad6);
    color: var(--smrt-color-on-error-container, #410002);
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
  }

  @media (prefers-reduced-motion: reduce) {
    .file-upload__drop-zone,
    .file-upload__file-remove,
    .file-upload__confirm-btn,
    .file-upload__clear-btn {
      transition: none;
    }
  }
</style>
