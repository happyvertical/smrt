<script lang="ts">
/**
 * CreateAssetModal - Upload/create new assets
 *
 * Modal with drag-and-drop dropzone, paste support, and metadata fields.
 * When a file is pasted or dragged onto the AssetManager, this modal
 * opens with the file pre-loaded.
 */

import type { Snippet } from 'svelte';

export interface CreateAssetModalProps {
  /** Whether the modal is open */
  open: boolean;
  /** Pre-loaded file (from paste or drag) */
  initialFile?: File | null;
  /** Callback when creation is complete */
  oncreate: (data: {
    file: File;
    name: string;
    description: string;
    altText: string;
  }) => void;
  /** Callback when modal is closed */
  onclose: () => void;
}

let {
  open,
  initialFile = null,
  oncreate,
  onclose,
}: CreateAssetModalProps = $props();

let dialogEl: HTMLDialogElement | null = $state(null);
let file = $state<File | null>(null);
let name = $state('');
let description = $state('');
let altText = $state('');
let dragOver = $state(false);
let previewUrl: string | null = $state(null);

// Sync open state with dialog
$effect(() => {
  if (!dialogEl) return;
  if (open && !dialogEl.open) {
    dialogEl.showModal();
  } else if (!open && dialogEl.open) {
    dialogEl.close();
  }
});

// Sync initial file
$effect(() => {
  if (initialFile) {
    file = initialFile;
    name = initialFile.name.replace(/\.[^/.]+$/, '');
  }
});

// Preview URL for images
$effect(() => {
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
  }
  if (file?.type.startsWith('image/')) {
    previewUrl = URL.createObjectURL(file);
  } else {
    previewUrl = null;
  }

  return () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  };
});

function handleDragOver(e: DragEvent) {
  e.preventDefault();
  dragOver = true;
}

function handleDragLeave() {
  dragOver = false;
}

function handleDrop(e: DragEvent) {
  e.preventDefault();
  dragOver = false;
  const dropped = e.dataTransfer?.files?.[0];
  if (dropped) {
    file = dropped;
    name = dropped.name.replace(/\.[^/.]+$/, '');
  }
}

function handleFileSelect(e: Event) {
  const target = e.target as HTMLInputElement;
  const selected = target.files?.[0];
  if (selected) {
    file = selected;
    name = selected.name.replace(/\.[^/.]+$/, '');
  }
}

function handleSubmit() {
  if (!file) return;
  oncreate({ file, name, description, altText });
  resetForm();
}

function handleClose() {
  resetForm();
  onclose();
}

function resetForm() {
  file = null;
  name = '';
  description = '';
  altText = '';
}

function handleCancel(e: Event) {
  e.preventDefault();
  handleClose();
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    handleClose();
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const isImage = $derived(file?.type?.startsWith('image/') ?? false);
const isLargeFile = $derived((file?.size ?? 0) > 2 * 1024 * 1024);
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialogEl}
  class="create-modal"
  oncancel={handleCancel}
  onkeydown={handleKeydown}
  onclick={(e) => { if (e.target === dialogEl) handleClose(); }}
  aria-label="Upload asset"
>
  <div
    class="create-modal__container"
    role="presentation"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    <header class="create-modal__header">
      <h2 class="create-modal__title">Upload Asset</h2>
      <button type="button" class="create-modal__close" onclick={handleClose} aria-label="Close">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </header>

    <div class="create-modal__body">
      {#if !file}
        <!-- Dropzone -->
        <div
          class="dropzone"
          class:dropzone--active={dragOver}
          role="button"
          tabindex="0"
          ondragover={handleDragOver}
          ondragleave={handleDragLeave}
          ondrop={handleDrop}
          onclick={() => document.getElementById('file-input')?.click()}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') document.getElementById('file-input')?.click(); }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="dropzone__icon">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
          <p class="dropzone__text">Drag & drop a file here, or click to browse</p>
          <p class="dropzone__hint">You can also paste an image from your clipboard</p>
          <input id="file-input" type="file" class="dropzone__input" onchange={handleFileSelect} />
        </div>
      {:else}
        <!-- File preview + metadata form -->
        <div class="file-preview">
          {#if previewUrl}
            <img src={previewUrl} alt="Preview" class="file-preview__image" />
          {:else}
            <div class="file-preview__icon">📎</div>
          {/if}
          <div class="file-preview__meta">
            <span class="file-preview__filename">{file.name}</span>
            <span class="file-preview__size">{formatSize(file.size)}</span>
            {#if isLargeFile}
              <span class="file-preview__warning">⚠️ Large file — may slow page loads</span>
            {/if}
          </div>
          <button type="button" class="file-preview__remove" onclick={() => { file = null; }} aria-label="Remove file">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>

        <div class="form-fields">
          <div class="form-field">
            <label for="asset-name" class="form-label">Name</label>
            <input id="asset-name" type="text" class="form-input" bind:value={name} placeholder="Asset name" />
          </div>

          <div class="form-field">
            <label for="asset-desc" class="form-label">Description</label>
            <textarea id="asset-desc" class="form-textarea" bind:value={description} placeholder="Optional description" rows="2"></textarea>
          </div>

          {#if isImage}
            <div class="form-field">
              <label for="asset-alt" class="form-label">
                Alt Text
                {#if !altText}
                  <span class="form-label__warning">⚠️ Recommended for accessibility</span>
                {/if}
              </label>
              <input id="asset-alt" type="text" class="form-input" bind:value={altText} placeholder="Describe this image for screen readers" />
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <footer class="create-modal__footer">
      <button type="button" class="footer-btn footer-btn--cancel" onclick={handleClose}>Cancel</button>
      <button type="button" class="footer-btn footer-btn--create" onclick={handleSubmit} disabled={!file}>
        Upload
      </button>
    </footer>
  </div>
</dialog>

<style>
  .create-modal {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
    margin: 0;
    padding: 0;
    border: none;
    background: transparent;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .create-modal::backdrop {
    background: var(--smrt-color-scrim, rgba(0, 0, 0, 0.5));
    backdrop-filter: blur(2px);
  }

  .create-modal:not([open]) {
    display: none;
  }

  .create-modal__container {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 32rem;
    max-height: calc(100vh - 2rem);
    background: var(--smrt-color-surface, #ffffff);
    border-radius: var(--smrt-radius-large, 0.75rem);
    box-shadow: var(--smrt-elevation-3);
    overflow: hidden;
    animation: modalEnter 300ms cubic-bezier(0.2, 0, 0, 1);
  }

  @keyframes modalEnter {
    from { opacity: 0; transform: scale(0.9) translateY(-16px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }

  .create-modal__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--smrt-spacing-4, 1rem) var(--smrt-spacing-5, 1.25rem);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
  }

  .create-modal__title {
    margin: 0;
    font-size: var(--smrt-typography-title-medium-size, 1.125rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface, #111827);
  }

  .create-modal__close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    cursor: pointer;
    border-radius: var(--smrt-radius-full, 9999px);
  }

  .create-modal__close:hover {
    background: var(--smrt-color-surface-container-highest, #e0e2ec);
  }

  .create-modal__body {
    flex: 1;
    padding: var(--smrt-spacing-5, 1.25rem);
    overflow-y: auto;
  }

  /* Dropzone */
  .dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--smrt-spacing-8, 2rem);
    border: 2px dashed var(--smrt-color-outline-variant, #d1d5db);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    cursor: pointer;
    transition: all 150ms ease;
    text-align: center;
  }

  .dropzone:hover, .dropzone--active {
    border-color: var(--smrt-color-primary, #005ac1);
    background: var(--smrt-color-primary-container, rgba(0, 90, 193, 0.05));
  }

  .dropzone__icon {
    color: var(--smrt-color-on-surface-variant, #6b7280);
    margin-bottom: var(--smrt-spacing-3, 0.75rem);
  }

  .dropzone__text {
    margin: 0;
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface, #111827);
  }

  .dropzone__hint {
    margin: var(--smrt-spacing-1, 0.25rem) 0 0;
    font-size: var(--smrt-typography-body-small-size, 0.8rem);
    color: var(--smrt-color-on-surface-variant, #9ca3af);
  }

  .dropzone__input {
    display: none;
  }

  /* File preview */
  .file-preview {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3, 0.75rem);
    padding: var(--smrt-spacing-3, 0.75rem);
    background: var(--smrt-color-surface-container-low, #f9fafb);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    margin-bottom: var(--smrt-spacing-4, 1rem);
  }

  .file-preview__image {
    width: 60px;
    height: 60px;
    object-fit: cover;
    border-radius: var(--smrt-radius-small, 0.25rem);
  }

  .file-preview__icon {
    width: 60px;
    height: 60px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    background: var(--smrt-color-surface-container, #f3f4f6);
    border-radius: var(--smrt-radius-small, 0.25rem);
  }

  .file-preview__meta {
    flex: 1;
    min-width: 0;
  }

  .file-preview__filename {
    display: block;
    font-weight: var(--smrt-typography-weight-medium, 500);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .file-preview__size {
    display: block;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .file-preview__warning {
    display: block;
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-error, #dc2626);
    margin-top: var(--smrt-spacing-1, 4px);
  }

  .file-preview__remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    cursor: pointer;
    border-radius: var(--smrt-radius-full, 9999px);
  }

  .file-preview__remove:hover {
    background: var(--smrt-color-surface-container, #f3f4f6);
    color: var(--smrt-color-error, #dc2626);
  }

  /* Form fields */
  .form-fields {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-3, 0.75rem);
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
  }

  .form-label {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface, #111827);
  }

  .form-label__warning {
    font-weight: var(--smrt-typography-weight-normal, 400);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-error, #dc2626);
    margin-left: var(--smrt-spacing-1, 4px);
  }

  .form-input, .form-textarea {
    width: 100%;
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    border: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    font-family: inherit;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface, #111827);
    background: var(--smrt-color-surface, #ffffff);
    box-sizing: border-box;
  }

  .form-input:focus, .form-textarea:focus {
    outline: none;
    border-color: var(--smrt-color-primary, #005ac1);
    box-shadow: 0 0 0 2px var(--smrt-color-primary-container, rgba(0, 90, 193, 0.1));
  }

  .form-textarea {
    resize: vertical;
    min-height: 60px;
  }

  /* Footer */
  .create-modal__footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-4, 1rem) var(--smrt-spacing-5, 1.25rem);
    border-top: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
  }

  .footer-btn {
    height: 36px;
    padding: 0 var(--smrt-spacing-4, 1rem);
    font-family: inherit;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    cursor: pointer;
    border: none;
    transition: all 150ms ease;
  }

  .footer-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .footer-btn--cancel {
    background: transparent;
    color: var(--smrt-color-primary, #005ac1);
  }

  .footer-btn--cancel:hover {
    background: var(--smrt-color-surface-container, #f3f4f6);
  }

  .footer-btn--create {
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
  }

  .footer-btn--create:hover:not(:disabled) {
    box-shadow: var(--smrt-elevation-2);
  }

  @media (prefers-reduced-motion: reduce) {
    .create-modal__container {
      animation: none;
    }
  }
</style>
