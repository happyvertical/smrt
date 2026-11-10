<script lang="ts">
/**
 * CreateAssetModal - Upload/create new assets
 *
 * Modal with drag-and-drop dropzone, paste support, and metadata fields.
 * When a file is pasted or dragged onto the AssetManager, this modal
 * opens with the file pre-loaded.
 */

// Import primitives from subpaths (not the root barrel) so downstream
// consumers of `@happyvertical/smrt-assets/svelte` don't have to resolve the
// entire smrt-svelte surface — including optional peers like smrt-agents /
// smrt-users — just to compile this modal.
import { Modal } from '@happyvertical/smrt-ui/feedback';
import { Input, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from './i18n.js';

const { t } = useI18n();

export interface CreateAssetModalProps {
  /** Whether the modal is open */
  open: boolean;
  /** Pre-loaded file (from paste or drag) */
  initialFile?: File | null;
  /** Callback when creation is complete. May be async; a rejection keeps the
   * form populated and surfaces an error instead of clearing silently. */
  oncreate: (data: {
    file: File;
    name: string;
    description: string;
    altText: string;
  }) => void | Promise<void>;
  /** Callback when modal is closed */
  onclose: () => void;
}

let {
  open,
  initialFile = null,
  oncreate,
  onclose,
}: CreateAssetModalProps = $props();

let file = $state<File | null>(null);
let name = $state('');
let description = $state('');
let altText = $state('');
let dragOver = $state(false);
let previewUrl: string | null = $state(null);
let submitting = $state(false);
let error = $state('');

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

async function handleSubmit() {
  if (!file || submitting) return;
  submitting = true;
  error = '';
  try {
    // Await in case `oncreate` performs an async upload; awaiting a sync
    // (void) return is a harmless no-op. Only clear the form on success so a
    // rejected upload keeps the user's input and surfaces the failure.
    await oncreate({ file, name, description, altText });
    resetForm();
  } catch (err) {
    error =
      err instanceof Error
        ? err.message
        : t(M['assets.create_asset_modal.upload_failed']);
  } finally {
    submitting = false;
  }
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
  error = '';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const isImage = $derived(file?.type?.startsWith('image/') ?? false);
const isLargeFile = $derived((file?.size ?? 0) > 2 * 1024 * 1024);
</script>

<Modal open={open} title={t(M['assets.create_asset_modal.upload_asset'])} onClose={handleClose} size="md">
      {#if !file}
        <!-- Dropzone -->
        <div
          class="smrt-create-asset-modal__dropzone"
          class:smrt-create-asset-modal__dropzone-active={dragOver}
          data-smrt-part="panel"
          role="button"
          tabindex="0"
          ondragover={handleDragOver}
          ondragleave={handleDragLeave}
          ondrop={handleDrop}
          onclick={() => document.getElementById('file-input')?.click()}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') document.getElementById('file-input')?.click(); }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="smrt-create-asset-modal__dropzone-icon" data-smrt-part="icon">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
          <p class="smrt-create-asset-modal__dropzone-text" data-smrt-part="title">{t(M['assets.create_asset_modal.dropzone_text'])}</p>
          <p class="smrt-create-asset-modal__dropzone-hint" data-smrt-part="hint">{t(M['assets.create_asset_modal.dropzone_hint'])}</p>
          <!-- raw-primitive-allow: hidden native file input behind the custom drop zone, triggered programmatically; styled Input is unwanted here (visually hidden, opened via the dropzone click/keydown) -->
          <input id="file-input" type="file" class="smrt-create-asset-modal__dropzone-input" data-smrt-part="field" onchange={handleFileSelect} />
        </div>
      {:else}
        <!-- File preview + metadata form -->
        <div class="smrt-create-asset-modal__file-preview" data-smrt-part="preview">
          {#if previewUrl}
            <img src={previewUrl} alt={t(M['assets.create_asset_modal.preview_alt'])} class="smrt-create-asset-modal__file-preview-image" data-smrt-part="thumbnail" />
          {:else}
            <div class="smrt-create-asset-modal__file-preview-icon" data-smrt-part="icon">📎</div>
          {/if}
          <div class="smrt-create-asset-modal__file-preview-meta" data-smrt-part="details">
            <span class="smrt-create-asset-modal__file-preview-filename" data-smrt-part="title">{file.name}</span>
            <span class="smrt-create-asset-modal__file-preview-size" data-smrt-part="meta">{formatSize(file.size)}</span>
            {#if isLargeFile}
              <span class="smrt-create-asset-modal__file-preview-warning" data-smrt-part="hint">{t(M['assets.create_asset_modal.large_file_warning'])}</span>
            {/if}
          </div>
          <Button variant="ghost" size="sm" onclick={() => { file = null; }} aria-label={t(M['assets.create_asset_modal.remove_file'])}>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </Button>
        </div>

        <div class="smrt-create-asset-modal__form-fields" data-smrt-part="form">
          <div class="smrt-create-asset-modal__form-field" data-smrt-part="field">
            <label for="asset-name" class="smrt-create-asset-modal__form-label" data-smrt-part="label">Name</label>
            <Input id="asset-name" type="text" bind:value={name} placeholder={t(M['assets.create_asset_modal.name_placeholder'])} />
          </div>

          <div class="smrt-create-asset-modal__form-field" data-smrt-part="field">
            <label for="asset-desc" class="smrt-create-asset-modal__form-label" data-smrt-part="label">Description</label>
            <Textarea id="asset-desc" bind:value={description} placeholder={t(M['assets.create_asset_modal.description_placeholder'])} rows={2} />
          </div>

          {#if isImage}
            <div class="smrt-create-asset-modal__form-field" data-smrt-part="field">
              <label for="asset-alt" class="smrt-create-asset-modal__form-label" data-smrt-part="label">
                {t(M['assets.create_asset_modal.alt_text'])}
                {#if !altText}
                  <span class="smrt-create-asset-modal__form-label-warning" data-smrt-part="hint">{t(M['assets.create_asset_modal.alt_text_recommended_warning'])}</span>
                {/if}
              </label>
              <Input id="asset-alt" type="text" bind:value={altText} placeholder={t(M['assets.create_asset_modal.alt_text_placeholder'])} />
            </div>
          {/if}
        </div>
      {/if}

  {#if error}
    <p class="smrt-create-asset-modal__error" data-smrt-part="error" role="alert" aria-live="assertive">{error}</p>
  {/if}

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={handleClose} disabled={submitting}>Cancel</Button>
    <Button variant="primary" size="sm" onclick={handleSubmit} disabled={!file || submitting}>
      {submitting ? 'Uploading…' : 'Upload'}
    </Button>
  {/snippet}
</Modal>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-create-asset-modal__error {
    margin: var(--smrt-spacing-2, 0.5rem) 0 0;
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }
  /* Dropzone */
  .smrt-create-asset-modal__dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--smrt-spacing-8, 2rem);
    cursor: pointer;
  }
  .smrt-create-asset-modal__dropzone-icon {
    margin-bottom: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-create-asset-modal__dropzone-text {
    margin: 0;
  }
  .smrt-create-asset-modal__dropzone-hint {
    margin: var(--smrt-spacing-1, 0.25rem) 0 0;
  }
  .smrt-create-asset-modal__dropzone-input {
    display: none;
  }
  /* File preview */
  .smrt-create-asset-modal__file-preview {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3, 0.75rem);
    padding: var(--smrt-spacing-3, 0.75rem);
    margin-bottom: var(--smrt-spacing-4, 1rem);
  }
  .smrt-create-asset-modal__file-preview-image {
    width: 60px;
    height: 60px;
    object-fit: cover;
  }
  .smrt-create-asset-modal__file-preview-icon {
    width: 60px;
    height: 60px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .smrt-create-asset-modal__file-preview-meta {
    flex: 1;
    min-width: 0;
  }
  .smrt-create-asset-modal__file-preview-filename {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-create-asset-modal__file-preview-size {
    display: block;
  }
  .smrt-create-asset-modal__file-preview-warning {
    display: block;
    margin-top: var(--smrt-spacing-1);
  }
  /* The remove control renders via <Button> (issue #1589). The overrides shape
  it into a small round icon button and reach the child <button> via :global()
  scoping. */
  .smrt-create-asset-modal__file-preview :global([data-smrt-component="Button"]) {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    padding: 0;
  }
  /* Form fields */
  .smrt-create-asset-modal__form-fields {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-create-asset-modal__form-field {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-create-asset-modal__form-label-warning {
    margin-left: var(--smrt-spacing-1);
  }
}

@layer smrt.theme {
  .smrt-create-asset-modal__error {
    border-radius: var(--smrt-radius-medium, 0.5rem);
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
    font-size: var(--smrt-typography-body-small-size, 0.8rem);
  }
  /* Dropzone */
  .smrt-create-asset-modal__dropzone {
    border: 2px dashed var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    transition: all 150ms ease;
    text-align: center;
  }
  .smrt-create-asset-modal__dropzone:hover, .smrt-create-asset-modal__dropzone-active {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary-container, rgba(0, 90, 193, 0.05));
  }
  .smrt-create-asset-modal__dropzone-icon {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-create-asset-modal__dropzone-text {
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
  }
  .smrt-create-asset-modal__dropzone-hint {
    font-size: var(--smrt-typography-body-small-size, 0.8rem);
    color: var(--smrt-color-on-surface-variant);
  }
  /* File preview */
  .smrt-create-asset-modal__file-preview {
    background: var(--smrt-color-surface-container-low);
    border-radius: var(--smrt-radius-medium, 0.5rem);
  }
  .smrt-create-asset-modal__file-preview-image {
    border-radius: var(--smrt-radius-small, 0.25rem);
  }
  .smrt-create-asset-modal__file-preview-icon {
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-small, 0.25rem);
  }
  .smrt-create-asset-modal__file-preview-filename {
    font-weight: var(--smrt-typography-weight-medium, 500);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  .smrt-create-asset-modal__file-preview-size {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-create-asset-modal__file-preview-warning {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-error);
  }
  /* The remove control renders via <Button> (issue #1589). The overrides shape
  it into a small round icon button and reach the child <button> via :global()
  scoping. */
  .smrt-create-asset-modal__file-preview :global([data-smrt-component="Button"]) {
    border: none;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    border-radius: var(--smrt-radius-full);
  }
  .smrt-create-asset-modal__file-preview :global([data-smrt-component="Button"]:hover) {
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-error);
  }
  .smrt-create-asset-modal__form-label {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
  }
  .smrt-create-asset-modal__form-label-warning {
    font-weight: var(--smrt-typography-weight-normal, 400);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-error);
  }
}

</style>
