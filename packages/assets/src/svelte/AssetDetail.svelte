<script lang="ts">
/**
 * AssetDetail - Detail drawer/modal for a single asset
 *
 * Shows preview, SEO fields (alt text, title, caption, description),
 * metadata, content references ("Used In"), copy utilities, and actions.
 */

import type { Snippet } from 'svelte';
import type { Asset } from '../asset';

export interface AssetDetailProps {
  /** The asset to display */
  asset: Asset | null;
  /** Whether the detail view is open */
  open: boolean;
  /** Callback when detail is closed */
  onclose: () => void;
  /** Callback when asset is updated (save metadata) */
  onsave: (asset: Asset, updates: AssetDetailUpdates) => void | Promise<void>;
  /** Callback when asset is deleted */
  ondelete: (asset: Asset) => void;
  /** Callback to open the image editor */
  onedit?: (asset: Asset) => void;
  /** Content references snippet (injected by smrt-content) */
  contentReferences?: Snippet<[{ assetId: string }]>;
}

export interface AssetDetailUpdates {
  name?: string;
  description?: string;
  alt?: string;
  title?: string;
  caption?: string;
}

let {
  asset,
  open,
  onclose,
  onsave,
  ondelete,
  onedit,
  contentReferences,
}: AssetDetailProps = $props();

let dialogEl: HTMLDialogElement | null = $state(null);
let saving = $state(false);
let copyFeedback = $state('');

// Editable fields (synced from asset)
let editName = $state('');
let editDescription = $state('');
let editAlt = $state('');

// Sync from asset
$effect(() => {
  if (asset) {
    editName = asset.name || '';
    editDescription = asset.description || '';
    editAlt = (asset as any).alt || '';
  }
});

// Sync open state with dialog
$effect(() => {
  if (!dialogEl) return;
  if (open && !dialogEl.open) {
    dialogEl.showModal();
  } else if (!open && dialogEl.open) {
    dialogEl.close();
  }
});

function handleClose() {
  onclose();
}

async function handleSave() {
  if (!asset) return;
  saving = true;
  try {
    await onsave(asset, {
      name: editName,
      description: editDescription,
      alt: editAlt,
    });
  } finally {
    saving = false;
  }
}

function handleDelete() {
  if (!asset) return;
  ondelete(asset);
}

function handleEdit() {
  if (!asset) return;
  onedit?.(asset);
}

async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    copyFeedback = `${label} copied!`;
    setTimeout(() => {
      copyFeedback = '';
    }, 2000);
  } catch {
    copyFeedback = 'Copy failed';
    setTimeout(() => {
      copyFeedback = '';
    }, 2000);
  }
}

function copyUrl() {
  if (asset?.sourceUri) {
    copyToClipboard(asset.sourceUri, 'URL');
  }
}

function copyMarkdown() {
  if (asset?.sourceUri) {
    const alt = (asset as any).alt || asset.name || 'image';
    copyToClipboard(`![${alt}](${asset.sourceUri})`, 'Markdown');
  }
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

const isImage = $derived(asset?.mimeType?.startsWith('image/') ?? false);
const isVideo = $derived(asset?.mimeType?.startsWith('video/') ?? false);
const isAudio = $derived(asset?.mimeType?.startsWith('audio/') ?? false);
const isPdf = $derived(asset?.mimeType?.includes('pdf') ?? false);
const missingAlt = $derived(isImage && !editAlt);
const fileSizeWarning = $derived(false); // file size not directly on Asset; can be enhanced later

function formatDate(date: Date | string | undefined): string {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialogEl}
  class="detail-modal"
  oncancel={handleCancel}
  onkeydown={handleKeydown}
  onclick={(e) => { if (e.target === dialogEl) handleClose(); }}
  aria-label="Asset details"
>
  {#if asset}
    <div class="detail-modal__container" onclick={(e) => e.stopPropagation()}>
      <!-- Header -->
      <header class="detail__header">
        <h2 class="detail__title">{asset.name || 'Untitled Asset'}</h2>
        <button type="button" class="detail__close" onclick={handleClose} aria-label="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </header>

      <div class="detail__body">
        <!-- Preview Section -->
        <section class="detail__section">
          <div class="detail__preview">
            {#if isImage && asset.sourceUri}
              <img src={asset.sourceUri} alt={editAlt || asset.name} class="preview-image" />
            {:else if isVideo && asset.sourceUri}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video src={asset.sourceUri} controls class="preview-video"></video>
            {:else if isAudio && asset.sourceUri}
              <audio src={asset.sourceUri} controls class="preview-audio"></audio>
            {:else if isPdf && asset.sourceUri}
              <div class="preview-document">
                <span class="preview-document__icon">📄</span>
                <a href={asset.sourceUri} target="_blank" rel="noopener noreferrer" class="preview-document__link">Open PDF in new tab</a>
              </div>
            {:else}
              <div class="preview-generic">
                <span class="preview-generic__icon">📎</span>
                <span class="preview-generic__mime">{asset.mimeType || 'Unknown type'}</span>
              </div>
            {/if}
          </div>
        </section>

        <!-- SEO & Accessibility -->
        <section class="detail__section">
          <h3 class="section-heading">SEO & Accessibility</h3>

          <div class="detail__form">
            <div class="form-field">
              <label for="detail-name" class="form-label">Name</label>
              <input id="detail-name" type="text" class="form-input" bind:value={editName} />
            </div>

            {#if isImage}
              <div class="form-field">
                <label for="detail-alt" class="form-label">
                  Alt Text
                  {#if missingAlt}
                    <span class="label-warning">⚠️ Missing — required for accessibility</span>
                  {/if}
                </label>
                <input id="detail-alt" type="text" class="form-input" bind:value={editAlt} placeholder="Describe this image for screen readers" />
              </div>
            {/if}

            <div class="form-field">
              <label for="detail-desc" class="form-label">Description</label>
              <textarea id="detail-desc" class="form-textarea" bind:value={editDescription} rows="3" placeholder="Optional description"></textarea>
            </div>
          </div>
        </section>

        <!-- Metadata -->
        <section class="detail__section">
          <h3 class="section-heading">Metadata</h3>
          <div class="metadata-grid">
            <div class="metadata-item">
              <span class="metadata-label">Type</span>
              <span class="metadata-value">{asset.mimeType || '—'}</span>
            </div>
            <div class="metadata-item">
              <span class="metadata-label">Status</span>
              <span class="metadata-value">{asset.statusSlug || 'draft'}</span>
            </div>
            <div class="metadata-item">
              <span class="metadata-label">Version</span>
              <span class="metadata-value">{asset.version}</span>
            </div>
            <div class="metadata-item">
              <span class="metadata-label">Created</span>
              <span class="metadata-value">{formatDate(asset.createdAt)}</span>
            </div>
            <div class="metadata-item">
              <span class="metadata-label">Updated</span>
              <span class="metadata-value">{formatDate(asset.updatedAt)}</span>
            </div>
            {#if isImage && (asset as any).width}
              <div class="metadata-item">
                <span class="metadata-label">Dimensions</span>
                <span class="metadata-value">{(asset as any).width} × {(asset as any).height}px</span>
              </div>
            {/if}
          </div>
        </section>

        <!-- Quick Actions -->
        <section class="detail__section">
          <h3 class="section-heading">Quick Actions</h3>
          <div class="quick-actions">
            <button type="button" class="quick-btn" onclick={copyUrl} disabled={!asset.sourceUri}>
              📋 Copy URL
            </button>
            {#if isImage}
              <button type="button" class="quick-btn" onclick={copyMarkdown} disabled={!asset.sourceUri}>
                📝 Copy Markdown
              </button>
            {/if}
            {#if onedit && isImage}
              <button type="button" class="quick-btn" onclick={handleEdit}>
                ✏️ Edit Image
              </button>
            {/if}
          </div>
          {#if copyFeedback}
            <div class="copy-feedback">{copyFeedback}</div>
          {/if}
        </section>

        <!-- Content References (injected) -->
        {#if contentReferences && asset.id}
          <section class="detail__section">
            <h3 class="section-heading">Used In</h3>
            {@render contentReferences({ assetId: asset.id })}
          </section>
        {/if}
      </div>

      <!-- Footer -->
      <footer class="detail__footer">
        <button type="button" class="footer-btn footer-btn--danger" onclick={handleDelete}>
          Delete
        </button>
        <div class="footer-right">
          <button type="button" class="footer-btn footer-btn--ghost" onclick={handleClose}>
            Cancel
          </button>
          <button type="button" class="footer-btn footer-btn--primary" onclick={handleSave} disabled={saving}>
            {#if saving}Saving...{:else}Save{/if}
          </button>
        </div>
      </footer>
    </div>
  {/if}
</dialog>

<style>
  .detail-modal {
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
    justify-content: flex-end;
  }

  .detail-modal::backdrop {
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(2px);
  }

  .detail-modal:not([open]) {
    display: none;
  }

  .detail-modal__container {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 520px;
    height: calc(100vh - 2rem);
    margin-right: 1rem;
    background: var(--smrt-color-surface, #ffffff);
    border-radius: var(--smrt-radius-large, 0.75rem);
    box-shadow: var(--smrt-elevation-level3);
    overflow: hidden;
    animation: slideIn 300ms cubic-bezier(0.2, 0, 0, 1);
  }

  @keyframes slideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  /* Header */
  .detail__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--smrt-spacing-4, 1rem) var(--smrt-spacing-5, 1.25rem);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    flex-shrink: 0;
  }

  .detail__title {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--smrt-color-on-surface, #111827);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .detail__close {
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
    border-radius: 50%;
    flex-shrink: 0;
  }

  .detail__close:hover {
    background: var(--smrt-color-surface-container-highest, #e0e2ec);
  }

  /* Body */
  .detail__body {
    flex: 1;
    overflow-y: auto;
    padding: 0;
  }

  .detail__section {
    padding: var(--smrt-spacing-4, 1rem) var(--smrt-spacing-5, 1.25rem);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #f3f4f6);
  }

  .detail__section:last-child {
    border-bottom: none;
  }

  .section-heading {
    margin: 0 0 var(--smrt-spacing-3, 0.75rem);
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    font-weight: 600;
    color: var(--smrt-color-on-surface, #111827);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.75rem;
  }

  /* Preview */
  .detail__preview {
    border-radius: var(--smrt-radius-medium, 0.5rem);
    overflow: hidden;
    background: var(--smrt-color-surface-container-low, #f9fafb);
  }

  .preview-image {
    width: 100%;
    max-height: 300px;
    object-fit: contain;
    display: block;
  }

  .preview-video {
    width: 100%;
    max-height: 300px;
    display: block;
  }

  .preview-audio {
    width: 100%;
    display: block;
    padding: var(--smrt-spacing-4, 1rem);
  }

  .preview-document, .preview-generic {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--smrt-spacing-8, 2rem);
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .preview-document__icon, .preview-generic__icon {
    font-size: 2.5rem;
  }

  .preview-document__link {
    color: var(--smrt-color-primary, #005ac1);
    font-weight: 500;
    text-decoration: none;
  }

  .preview-document__link:hover {
    text-decoration: underline;
  }

  .preview-generic__mime {
    font-size: 0.8rem;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  /* Form */
  .detail__form {
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
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--smrt-color-on-surface, #111827);
  }

  .label-warning {
    font-weight: 400;
    font-size: 0.7rem;
    color: var(--smrt-color-error, #dc2626);
    margin-left: 4px;
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

  /* Metadata */
  .metadata-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .metadata-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .metadata-label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .metadata-value {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface, #111827);
    word-break: break-word;
  }

  /* Quick Actions */
  .quick-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .quick-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 32px;
    padding: 0 var(--smrt-spacing-3, 0.75rem);
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 500;
    border: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    background: var(--smrt-color-surface, #ffffff);
    color: var(--smrt-color-on-surface, #111827);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    cursor: pointer;
    transition: all 150ms ease;
  }

  .quick-btn:hover:not(:disabled) {
    background: var(--smrt-color-surface-container-low, #f9fafb);
    box-shadow: var(--smrt-elevation-level1);
  }

  .quick-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .copy-feedback {
    margin-top: var(--smrt-spacing-2, 0.5rem);
    font-size: 0.8rem;
    color: #22c55e;
    font-weight: 500;
    animation: fadeIn 150ms ease;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  /* Footer */
  .detail__footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-5, 1.25rem);
    border-top: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    flex-shrink: 0;
  }

  .footer-right {
    display: flex;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .footer-btn {
    height: 36px;
    padding: 0 var(--smrt-spacing-4, 1rem);
    font-family: inherit;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: 500;
    border-radius: var(--smrt-radius-medium, 0.5rem);
    cursor: pointer;
    border: none;
    transition: all 150ms ease;
  }

  .footer-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .footer-btn--primary {
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
  }

  .footer-btn--primary:hover:not(:disabled) {
    box-shadow: var(--smrt-elevation-level2);
  }

  .footer-btn--ghost {
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .footer-btn--ghost:hover {
    background: var(--smrt-color-surface-container, #f3f4f6);
  }

  .footer-btn--danger {
    background: transparent;
    color: var(--smrt-color-error, #dc2626);
  }

  .footer-btn--danger:hover {
    background: var(--smrt-color-error-container, #fef2f2);
  }

  @media (prefers-reduced-motion: reduce) {
    .detail-modal__container {
      animation: none;
    }
  }

  @media (max-width: 640px) {
    .detail-modal__container {
      max-width: 100%;
      margin-right: 0;
      height: 100vh;
      border-radius: 0;
    }
  }
</style>
