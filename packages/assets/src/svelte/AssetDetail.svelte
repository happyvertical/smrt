<script lang="ts">
/**
 * AssetDetail - Detail drawer/modal for a single asset
 *
 * Shows preview, SEO fields (alt text, title, caption, description),
 * metadata, content references ("Used In"), copy utilities, and actions.
 */

import { Modal } from '@happyvertical/smrt-ui/feedback';
import { Input, Textarea } from '@happyvertical/smrt-ui/forms';
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
  /** Fired when the detail view is closed. */
  onclose?: () => void;
  /** Callback when asset is updated (save metadata) */
  onSave?: (
    asset: PersistedAsset,
    updates: AssetDetailUpdates,
  ) => void | Promise<void>;
  /** Fired when the user saves metadata changes. */
  onsave?: (
    asset: PersistedAsset,
    updates: AssetDetailUpdates,
  ) => void | Promise<void>;
  /** Callback when asset is deleted */
  onDelete?: (asset: PersistedAsset) => void;
  /** Fired when the user deletes the asset. */
  ondelete?: (asset: PersistedAsset) => void;
  /** Callback to open the image editor */
  onEdit?: (asset: PersistedAsset) => void;
  /** Fired when the user clicks to edit the image. */
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
    // `alt` lives on the Image subclass (smrt-images), not the base Asset.
    // Read it defensively without a hard dependency on that subclass.
    editAlt = (asset as { alt?: string }).alt || '';
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
    const alt = (asset as { alt?: string }).alt || asset.name || 'image';
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
      <div class="smrt-asset-detail__body" data-smrt-part="body">
        <!-- Preview Section -->
        <section class="smrt-asset-detail__section" data-smrt-part="group">
          <div class="smrt-asset-detail__preview" data-smrt-part="preview">
            {#if isImage && asset.sourceUri}
              <img src={asset.sourceUri} alt={editAlt || asset.name} class="smrt-asset-detail__preview-image" data-smrt-part="content" />
            {:else if isVideo && asset.sourceUri}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video src={asset.sourceUri} controls class="smrt-asset-detail__preview-video" data-smrt-part="content"></video>
            {:else if isAudio && asset.sourceUri}
              <audio src={asset.sourceUri} controls class="smrt-asset-detail__preview-audio" data-smrt-part="content"></audio>
            {:else if isPdf && asset.sourceUri}
              <div class="smrt-asset-detail__preview-document" data-smrt-part="content">
                <span class="smrt-asset-detail__preview-document-icon" data-smrt-part="icon">📄</span>
                <a href={asset.sourceUri} target="_blank" rel="noopener noreferrer" class="smrt-asset-detail__preview-document-link" data-smrt-part="actions">{t(M['assets.asset_detail.open_pdf_in_new_tab'])}</a>
              </div>
            {:else}
              <div class="smrt-asset-detail__preview-generic" data-smrt-part="content">
                <span class="smrt-asset-detail__preview-generic-icon" data-smrt-part="icon">📎</span>
                <span class="smrt-asset-detail__preview-generic-mime" data-smrt-part="value">{asset.mimeType || 'Unknown type'}</span>
              </div>
            {/if}
          </div>
        </section>

        <!-- SEO & Accessibility -->
        <section class="smrt-asset-detail__section" data-smrt-part="group">
          <h3 class="smrt-asset-detail__section-heading" data-smrt-part="heading">SEO & Accessibility</h3>

          <div class="smrt-asset-detail__form" data-smrt-part="form">
            <div class="smrt-asset-detail__form-field" data-smrt-part="field">
              <label for="detail-name" class="smrt-asset-detail__form-label" data-smrt-part="label">Name</label>
              <Input id="detail-name" type="text" bind:value={editName} />
            </div>

            {#if isImage}
              <div class="smrt-asset-detail__form-field" data-smrt-part="field">
                <label for="detail-alt" class="smrt-asset-detail__form-label" data-smrt-part="label">
                  {t(M['assets.asset_detail.alt_text'])}
                  {#if missingAlt}
                    <span class="smrt-asset-detail__label-warning" data-smrt-part="hint">{t(M['assets.asset_detail.alt_text_missing_warning'])}</span>
                  {/if}
                </label>
                <Input id="detail-alt" type="text" bind:value={editAlt} placeholder={t(M['assets.asset_detail.alt_text_placeholder'])} />
              </div>
            {/if}

            <div class="smrt-asset-detail__form-field" data-smrt-part="field">
              <label for="detail-desc" class="smrt-asset-detail__form-label" data-smrt-part="label">Description</label>
              <Textarea id="detail-desc" bind:value={editDescription} rows={3} placeholder={t(M['assets.asset_detail.description_placeholder'])} />
            </div>
          </div>
        </section>

        <!-- Metadata -->
        <section class="smrt-asset-detail__section" data-smrt-part="group">
          <h3 class="smrt-asset-detail__section-heading" data-smrt-part="heading">Metadata</h3>
          <div class="smrt-asset-detail__metadata-grid" data-smrt-part="meta">
            <div class="smrt-asset-detail__metadata-item" data-smrt-part="item">
              <span class="smrt-asset-detail__metadata-label" data-smrt-part="label">Type</span>
              <span class="smrt-asset-detail__metadata-value" data-smrt-part="value">{asset.mimeType || '—'}</span>
            </div>
            <div class="smrt-asset-detail__metadata-item" data-smrt-part="item">
              <span class="smrt-asset-detail__metadata-label" data-smrt-part="label">Status</span>
              <span class="smrt-asset-detail__metadata-value" data-smrt-part="value">{asset.statusSlug || 'draft'}</span>
            </div>
            <div class="smrt-asset-detail__metadata-item" data-smrt-part="item">
              <span class="smrt-asset-detail__metadata-label" data-smrt-part="label">Version</span>
              <span class="smrt-asset-detail__metadata-value" data-smrt-part="value">{asset.version}</span>
            </div>
            <div class="smrt-asset-detail__metadata-item" data-smrt-part="item">
              <span class="smrt-asset-detail__metadata-label" data-smrt-part="label">Created</span>
              <span class="smrt-asset-detail__metadata-value" data-smrt-part="value">{formatDate(asset.createdAt)}</span>
            </div>
            <div class="smrt-asset-detail__metadata-item" data-smrt-part="item">
              <span class="smrt-asset-detail__metadata-label" data-smrt-part="label">Updated</span>
              <span class="smrt-asset-detail__metadata-value" data-smrt-part="value">{formatDate(asset.updatedAt)}</span>
            </div>
            {#if isImage && (asset as any).width}
              <div class="smrt-asset-detail__metadata-item" data-smrt-part="item">
                <span class="smrt-asset-detail__metadata-label" data-smrt-part="label">Dimensions</span>
                <span class="smrt-asset-detail__metadata-value" data-smrt-part="value">{(asset as any).width} × {(asset as any).height}px</span>
              </div>
            {/if}
          </div>
        </section>

        <!-- Quick Actions -->
        <section class="smrt-asset-detail__section" data-smrt-part="group">
          <h3 class="smrt-asset-detail__section-heading" data-smrt-part="heading">{t(M['assets.asset_detail.quick_actions'])}</h3>
          <div class="smrt-asset-detail__quick-actions" data-smrt-part="actions">
            <Button variant="ghost" size="sm" onclick={copyUrl} disabled={!asset.sourceUri}>
              {t(M['assets.asset_detail.copy_url'])}
            </Button>
            {#if isImage}
              <Button variant="ghost" size="sm" onclick={copyMarkdown} disabled={!asset.sourceUri}>
                {t(M['assets.asset_detail.copy_markdown'])}
              </Button>
            {/if}
            {#if onedit && isImage}
              <Button variant="ghost" size="sm" onclick={handleEdit}>
                {t(M['assets.asset_detail.edit_image'])}
              </Button>
            {/if}
          </div>
          <div class="smrt-asset-detail__copy-feedback" data-smrt-part="status" role="status" aria-live="polite">{copyFeedback}</div>
        </section>

        <!-- Content References (injected) -->
        {#if contentReferences && asset.id}
          <section class="smrt-asset-detail__section" data-smrt-part="group">
            <h3 class="smrt-asset-detail__section-heading" data-smrt-part="heading">{t(M['assets.asset_detail.used_in'])}</h3>
            {@render contentReferences({ assetId: asset.id })}
          </section>
        {/if}
      </div>

    {#snippet footer()}
      <div class="smrt-asset-detail__footer" data-smrt-part="footer">
        <Button variant="danger" onclick={handleDelete}>Delete</Button>
        <div class="smrt-asset-detail__footer-right" data-smrt-part="actions">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  /* Body — negative margin cancels Modal's .modal__body padding so the section
  dividers stay full-bleed (Modal owns the dialog shell + scroll container). */
  .smrt-asset-detail__body {
    margin: calc(-1 * var(--smrt-spacing-5, 1.25rem));
  }
  .smrt-asset-detail__section {
    padding: var(--smrt-spacing-4, 1rem) var(--smrt-spacing-5, 1.25rem);
  }
  .smrt-asset-detail__section-heading {
    margin: 0 0 var(--smrt-spacing-3, 0.75rem);
  }
  /* Preview */
  .smrt-asset-detail__preview {
    overflow: hidden;
  }
  .smrt-asset-detail__preview-image {
    width: 100%;
    max-height: 300px;
    object-fit: contain;
    display: block;
  }
  .smrt-asset-detail__preview-video {
    width: 100%;
    max-height: 300px;
    display: block;
  }
  .smrt-asset-detail__preview-audio {
    width: 100%;
    display: block;
    padding: var(--smrt-spacing-4, 1rem);
  }
  .smrt-asset-detail__preview-document, .smrt-asset-detail__preview-generic {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--smrt-spacing-8, 2rem);
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  /* Form */
  .smrt-asset-detail__form {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-asset-detail__form-field {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-asset-detail__label-warning {
    margin-left: var(--smrt-spacing-1);
  }
  /* Metadata */
  .smrt-asset-detail__metadata-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-asset-detail__metadata-item {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
  }
  .smrt-asset-detail__metadata-value {
    word-break: break-word;
  }
  /* Quick Actions */
  .smrt-asset-detail__quick-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  /* The quick-action buttons render via <Button> (issue #1589). They keep a
  bespoke bordered-surface look (vs. the transparent ghost variant), so the
  overrides reach the child-rendered <button> through :global() scoping. */
  .smrt-asset-detail__quick-actions :global([data-smrt-component="Button"]) {
    gap: var(--smrt-spacing-1);
    height: 32px;
    padding: 0 var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-asset-detail__copy-feedback {
    margin-top: var(--smrt-spacing-2, 0.5rem);
  }
  /* The live region stays in the DOM (empty) so screen readers announce
  copy results; collapse its spacing/animation when there's no message. */
  .smrt-asset-detail__copy-feedback:empty {
    margin-top: 0;
  }
  /* Footer — split layout: destructive Delete on the left, Cancel/Save on the
  right. The buttons are library <Button>s; only the split layout is local. */
  .smrt-asset-detail__footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-asset-detail__footer-right {
    display: flex;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
}

@layer smrt.theme {
  .smrt-asset-detail__section {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-asset-detail__section:last-child {
    border-bottom: none;
  }
  .smrt-asset-detail__section-heading {
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.05em);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
  }
  /* Preview */
  .smrt-asset-detail__preview {
    border-radius: var(--smrt-radius-medium, 0.5rem);
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-asset-detail__preview-document-icon, .smrt-asset-detail__preview-generic-icon {
    font-size: var(--smrt-typography-display-medium-size, 2.5rem);
  }
  .smrt-asset-detail__preview-document-link {
    color: var(--smrt-color-primary);
    font-weight: var(--smrt-typography-weight-medium, 500);
    text-decoration: none;
  }
  .smrt-asset-detail__preview-document-link:hover {
    text-decoration: underline;
  }
  .smrt-asset-detail__preview-generic-mime {
    font-size: var(--smrt-typography-body-small-size, 0.8rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-asset-detail__form-label {
    font-size: var(--smrt-typography-label-medium-size, 0.8rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
  }
  .smrt-asset-detail__label-warning {
    font-weight: var(--smrt-typography-weight-normal, 400);
    font-size: var(--smrt-typography-label-small-size, 0.7rem);
    color: var(--smrt-color-error);
  }
  .smrt-asset-detail__metadata-label {
    font-size: var(--smrt-typography-label-small-size, 0.7rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.05em);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-asset-detail__metadata-value {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface);
  }
  /* The quick-action buttons render via <Button> (issue #1589). They keep a
  bespoke bordered-surface look (vs. the transparent ghost variant), so the
  overrides reach the child-rendered <button> through :global() scoping. */
  .smrt-asset-detail__quick-actions :global([data-smrt-component="Button"]) {
    font-size: var(--smrt-typography-label-medium-size, 0.8rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    border: var(--smrt-hairline);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }
  .smrt-asset-detail__quick-actions :global([data-smrt-component="Button"]:hover:not(:disabled)) {
    background: var(--smrt-color-surface-container-low);
    box-shadow: var(--smrt-elevation-1);
  }
  .smrt-asset-detail__copy-feedback {
    font-size: var(--smrt-typography-label-medium-size, 0.8rem);
    color: var(--smrt-color-success);
    font-weight: var(--smrt-typography-weight-medium, 500);
    animation: fadeIn 150ms ease;
  }
  /* The live region stays in the DOM (empty) so screen readers announce
  copy results; collapse its spacing/animation when there's no message. */
  .smrt-asset-detail__copy-feedback:empty {
    animation: none;
  }
  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
}

</style>
