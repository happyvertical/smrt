<script lang="ts">
/**
 * FileUpload - Drag-and-drop file upload component
 *
 * Features:
 * - Drag-and-drop zone with visual feedback
 * - File list with remove buttons
 * - Accept filter (mime types / extensions)
 * - Multiple file support
 * - Max size validation
 * - Material 3 styling
 */

interface Props {
  /** Accepted file types (e.g., '.pdf,.csv' or 'application/pdf,text/csv') */
  accept?: string;
  /** Allow multiple files */
  multiple?: boolean;
  /** Selected files (bindable) */
  files?: File[];
  /** Callback when files change */
  onchange?: (files: File[]) => void;
  /** Maximum file size in bytes */
  maxSize?: number;
  /** Disabled state */
  disabled?: boolean;
  /** Label text for the drop zone */
  label?: string;
  /** Hint text shown below the label */
  hint?: string;
}

let {
  accept,
  multiple = false,
  files = $bindable([]),
  onchange,
  maxSize,
  disabled = false,
  label = 'Drag and drop files here',
  hint = 'or click to browse',
}: Props = $props();

let isDragging = $state(false);
let error = $state<string | null>(null);
let inputRef = $state<HTMLInputElement | null>(null);

function handleDragEnter(e: DragEvent) {
  e.preventDefault();
  if (!disabled) isDragging = true;
}

function handleDragLeave(e: DragEvent) {
  e.preventDefault();
  isDragging = false;
}

function handleDragOver(e: DragEvent) {
  e.preventDefault();
}

function handleDrop(e: DragEvent) {
  e.preventDefault();
  isDragging = false;
  if (disabled) return;

  const droppedFiles = e.dataTransfer?.files;
  if (droppedFiles) {
    addFiles(Array.from(droppedFiles));
  }
}

function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files) {
    addFiles(Array.from(input.files));
    input.value = '';
  }
}

function handleZoneClick() {
  if (!disabled) inputRef?.click();
}

function handleKeyDown(e: KeyboardEvent) {
  if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
    e.preventDefault();
    inputRef?.click();
  }
}

function addFiles(newFiles: File[]) {
  error = null;

  let filtered = newFiles;

  // Validate max size
  if (maxSize) {
    const oversized = filtered.filter((f) => f.size > maxSize!);
    if (oversized.length > 0) {
      error = `${oversized.length} file(s) exceed the maximum size of ${formatFileSize(maxSize)}`;
      filtered = filtered.filter((f) => f.size <= maxSize!);
    }
  }

  if (!multiple) {
    files = filtered.slice(0, 1);
  } else {
    // Avoid duplicates by name
    const existingNames = new Set(files.map((f) => f.name));
    const unique = filtered.filter((f) => !existingNames.has(f.name));
    files = [...files, ...unique];
  }

  onchange?.(files);
}

function removeFile(index: number) {
  files = files.filter((_, i) => i !== index);
  onchange?.(files);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<div class="file-upload" class:disabled>
  <div
    class="drop-zone"
    class:dragging={isDragging}
    role="button"
    tabindex={disabled ? -1 : 0}
    ondragenter={handleDragEnter}
    ondragleave={handleDragLeave}
    ondragover={handleDragOver}
    ondrop={handleDrop}
    onclick={handleZoneClick}
    onkeydown={handleKeyDown}
  >
    <div class="drop-zone__icon">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
    </div>
    <p class="drop-zone__label">{label}</p>
    <p class="drop-zone__hint">{hint}</p>
    <input
      bind:this={inputRef}
      type="file"
      {accept}
      {multiple}
      onchange={handleFileSelect}
      hidden
      {disabled}
    />
  </div>

  {#if error}
    <p class="file-upload__error">{error}</p>
  {/if}

  {#if files.length > 0}
    <ul class="file-list">
      {#each files as file, i (file.name)}
        <li class="file-list__item">
          <span class="file-list__name">{file.name}</span>
          <span class="file-list__size">{formatFileSize(file.size)}</span>
          <button
            class="file-list__remove"
            onclick={() => removeFile(i)}
            aria-label="Remove {file.name}"
            type="button"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .file-upload {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-3, 0.75rem);
  }

  .file-upload.disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  .drop-zone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-8, 2rem) var(--smrt-spacing-6, 1.5rem);
    border: 2px dashed var(--md-sys-color-outline, #79747e);
    border-radius: var(--smrt-radius-lg, 1rem);
    background: var(--md-sys-color-surface-container-low, #f7f2fa);
    cursor: pointer;
    transition: all 200ms;
    text-align: center;
  }

  .drop-zone:hover {
    border-color: var(--md-sys-color-primary, #6750a4);
    background: var(--md-sys-color-surface-container, #f3edf7);
  }

  .drop-zone:focus-visible {
    outline: 2px solid var(--md-sys-color-primary, #6750a4);
    outline-offset: 2px;
  }

  .drop-zone.dragging {
    border-color: var(--md-sys-color-primary, #6750a4);
    background: var(--md-sys-color-primary-container, #eaddff);
    border-style: solid;
  }

  .drop-zone__icon {
    color: var(--md-sys-color-on-surface-variant, #49454f);
  }

  .drop-zone__label {
    margin: 0;
    font: var(--md-sys-typescale-body-large-font);
    color: var(--md-sys-color-on-surface, #1d1b20);
  }

  .drop-zone__hint {
    margin: 0;
    font: var(--md-sys-typescale-body-small-font);
    font-size: 0.875rem;
    color: var(--md-sys-color-on-surface-variant, #49454f);
  }

  .file-upload__error {
    margin: 0;
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    background: var(--md-sys-color-error-container, #f9dedc);
    color: var(--md-sys-color-on-error-container, #410e0b);
    border-radius: var(--smrt-radius-sm, 0.25rem);
    font-size: 0.875rem;
  }

  .file-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--md-sys-color-outline-variant, #cac4d0);
    border-radius: var(--smrt-radius-md, 0.5rem);
    overflow: hidden;
  }

  .file-list__item {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3, 0.75rem);
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    border-bottom: 1px solid var(--md-sys-color-outline-variant, #cac4d0);
  }

  .file-list__item:last-child {
    border-bottom: none;
  }

  .file-list__name {
    flex: 1;
    font-size: 0.875rem;
    color: var(--md-sys-color-on-surface, #1d1b20);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-list__size {
    font-size: 0.75rem;
    color: var(--md-sys-color-on-surface-variant, #49454f);
    white-space: nowrap;
  }

  .file-list__remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--md-sys-color-on-surface-variant, #49454f);
    cursor: pointer;
    transition: background-color 200ms;
  }

  .file-list__remove:hover {
    background: var(--md-sys-color-error-container, #f9dedc);
    color: var(--md-sys-color-error, #b3261e);
  }
</style>
