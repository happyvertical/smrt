<script lang="ts">
/**
 * AssetDetail - Detail drawer/modal for a single asset
 *
 * Shows preview, SEO fields (alt text, title, caption, description),
 * metadata, content references ("Used In"), copy utilities, and actions.
 */

import { Modal } from '@happyvertical/smrt-ui/feedback';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import { M } from './i18n.js';
import type { PersistedAsset } from './types';

const { t } = useI18n();

export interface AssetDetailProps {
  /** The asset to display */
  asset: PersistedAsset | null;
  /** Whether the detail view is open */
  open: boolean;
  /** Callback when detail is closed */
  onClose?: () => void;
  onclose?: () => void;
  /** Callback when asset is updated (save metadata) */
  onSave?: (
    asset: PersistedAsset,
    updates: AssetDetailUpdates,
  ) => void | Promise<void>;
  onsave?: (
    asset: PersistedAsset,
    updates: AssetDetailUpdates,
  ) => void | Promise<void>;
  /** Callback when asset is deleted */
  onDelete?: (asset: PersistedAsset) => void;
  ondelete?: (asset: PersistedAsset) => void;
  /** Callback to open the image editor */
  onEdit?: (asset: PersistedAsset) => void;
  onedit?: (asset: PersistedAsset) => void;
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
  onClose,
  onclose,
  onSave,
  onsave,
  onDelete,
  ondelete,
  onEdit,
  onedit,
  contentReferences,
}: AssetDetailProps = $props();

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

function handleClose() {
  (onclose ?? onClose)?.();
}

async function handleSave() {
  if (!asset) return;
  saving = true;
  try {
    await (onsave ?? onSave)?.(asset, {
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
  (ondelete ?? onDelete)?.(asset);
}

function handleEdit() {
  if (!asset) return;
  (onedit ?? onEdit)?.(asset);
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

{#if asset}
  <!-- Shell consolidated onto the library Modal (S10 #1415): title + close X,
       backdrop, Esc, and showModal lifecycle come from Modal. `placement="end"`
       preserves the original right-anchored detail-drawer presentation; this
       file owns only the asset-detail body + action footer. -->
  <Modal
    open={open}
    title={asset.name || 'Untitled Asset'}
    onClose={handleClose}
    size="md"
    placement="end"
  >
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
                <a href={asset.sourceUri} target="_blank" rel="noopener noreferrer" class="preview-document__link">{t(M['assets.asset_detail.open_pdf_in_new_tab'])}</a>
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
                  {t(M['assets.asset_detail.alt_text'])}
                  {#if missingAlt}
                    <span class="label-warning">{t(M['assets.asset_detail.alt_text_missing_warning'])}</span>
                  {/if}
                </label>
                <input id="detail-alt" type="text" class="form-input" bind:value={editAlt} placeholder={t(M['assets.asset_detail.alt_text_placeholder'])} />
              </div>
            {/if}

            <div class="form-field">
              <label for="detail-desc" class="form-label">Description</label>
              <textarea id="detail-desc" class="form-textarea" bind:value={editDescription} rows="3" placeholder={t(M['assets.asset_detail.description_placeholder'])}></textarea>
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
          <h3 class="section-heading">{t(M['assets.asset_detail.quick_actions'])}</h3>
          <div class="quick-actions">
            <button type="button" class="quick-btn" onclick={copyUrl} disabled={!asset.sourceUri}>
              {t(M['assets.asset_detail.copy_url'])}
            </button>
            {#if isImage}
              <button type="button" class="quick-btn" onclick={copyMarkdown} disabled={!asset.sourceUri}>
                {t(M['assets.asset_detail.copy_markdown'])}
              </button>
            {/if}
            {#if onedit && isImage}
              <button type="button" class="quick-btn" onclick={handleEdit}>
                {t(M['assets.asset_detail.edit_image'])}
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
            <h3 class="section-heading">{t(M['assets.asset_detail.used_in'])}</h3>
            {@render contentReferences({ assetId: asset.id })}
          </section>
        {/if}
      </div>

    {#snippet footer()}
      <div class="detail-footer">
        <Button variant="danger" onclick={handleDelete}>Delete</Button>
        <div class="detail-footer__right">
          <Button variant="ghost" onclick={handleClose}>Cancel</Button>
          <Button variant="primary" onclick={handleSave} disabled={saving}>
            {#if saving}Saving...{:else}Save{/if}
          </Button>
        </div>
      </div>
    {/snippet}
  </Modal>
{/if}

<style>
  /* Body — negative margin cancels Modal's .modal__body padding so the section
     dividers stay full-bleed (Modal owns the dialog shell + scroll container). */
  .detail__body {
    margin: calc(-1 * var(--smrt-spacing-5, 1.25rem));
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
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface, #111827);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.05em);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
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
    font-size: var(--smrt-typography-display-medium-size, 2.5rem);
  }

  .preview-document__link {
    color: var(--smrt-color-primary, #005ac1);
    font-weight: var(--smrt-typography-weight-medium, 500);
    text-decoration: none;
  }

  .preview-document__link:hover {
    text-decoration: underline;
  }

  .preview-generic__mime {
    font-size: var(--smrt-typography-body-small-size, 0.8rem);
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
    font-size: var(--smrt-typography-label-medium-size, 0.8rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface, #111827);
  }

  .label-warning {
    font-weight: var(--smrt-typography-weight-normal, 400);
    font-size: var(--smrt-typography-label-small-size, 0.7rem);
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

  /* Metadata */
  .metadata-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .metadata-item {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
  }

  .metadata-label {
    font-size: var(--smrt-typography-label-small-size, 0.7rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.05em);
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
    gap: var(--smrt-spacing-1, 4px);
    height: 32px;
    padding: 0 var(--smrt-spacing-3, 0.75rem);
    font-family: inherit;
    font-size: var(--smrt-typography-label-medium-size, 0.8rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    border: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    background: var(--smrt-color-surface, #ffffff);
    color: var(--smrt-color-on-surface, #111827);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    cursor: pointer;
    transition: all 150ms ease;
  }

  .quick-btn:hover:not(:disabled) {
    background: var(--smrt-color-surface-container-low, #f9fafb);
    box-shadow: var(--smrt-elevation-1);
  }

  .quick-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .copy-feedback {
    margin-top: var(--smrt-spacing-2, 0.5rem);
    font-size: var(--smrt-typography-label-medium-size, 0.8rem);
    color: var(--smrt-color-success, #22c55e);
    font-weight: var(--smrt-typography-weight-medium, 500);
    animation: fadeIn 150ms ease;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  /* Footer — split layout: destructive Delete on the left, Cancel/Save on the
     right. The buttons are library <Button>s; only the split layout is local. */
  .detail-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .detail-footer__right {
    display: flex;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
</style>
