<script lang="ts">
import {
  type ImageLike,
  ImageUploader,
} from '@happyvertical/smrt-images/svelte';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { ContentEditorAsset } from '../content-editor-form';
import { M } from '../i18n.editor.js';

const { t } = useI18n();

export interface Props {
  /** Base URL for asset upload and retrieval API requests. */
  apiBaseUrl?: string;
  /** List of assets to display in the browser grid. */
  assets?: ContentEditorAsset[];
  /** ID of the asset currently marked as the thumbnail. */
  thumbnailAssetId?: string | null;
  /** Label text displayed on the button to open the image uploader. */
  addButtonLabel?: string;
  /** Label text displayed on buttons to select an asset for use. */
  selectActionLabel?: string;
  /** Whether to display the image uploader panel on initial render. */
  showUploaderInitially?: boolean;
  /** Invoked when a new image is selected through the uploader. */
  onSelectImage?: (image: ImageLike | File | string) => void;
  /** Invoked when an existing asset is selected from the grid. */
  onUseAsset?: (asset: ContentEditorAsset) => void;
  /** Invoked when an asset is deleted from the collection. */
  onRemoveAsset?: (assetId: string) => void;
  /** Invoked when an asset is designated as the thumbnail. */
  onUseAsThumbnail?: (assetId: string) => void;
}

let {
  apiBaseUrl = '/api/v1',
  assets = [],
  thumbnailAssetId = null,
  addButtonLabel = 'Add Image',
  selectActionLabel = 'Use',
  showUploaderInitially = false,
  onSelectImage = undefined,
  onUseAsset = undefined,
  onRemoveAsset = undefined,
  onUseAsThumbnail = undefined,
}: Props = $props();

let showUploader = $state(false);

$effect(() => {
  showUploader = showUploaderInitially;
});

function getAssetImageSource(asset: ContentEditorAsset): string {
  return String(
    asset?.sourceUri ||
      asset?.thumbnailUri ||
      asset?.thumbnailUrl ||
      asset?.deliveryUrl ||
      asset?.url ||
      asset?.src ||
      '',
  );
}

function getAssetLabel(asset: ContentEditorAsset): string {
  return String(
    asset?.name || asset?.title || asset?.filename || asset?.id || 'Image',
  );
}

function handleSelect(selected: ImageLike | File | string) {
  onSelectImage?.(selected);
  showUploader = false;
}
</script>

<div class="smrt-content-image-browser__root" data-smrt-component="ContentImageBrowser">
  {#if assets.length}
    <div class="smrt-content-image-browser__asset-grid" data-smrt-part="grid">
      {#each assets as asset, index (asset.id || `${getAssetLabel(asset)}-${index}`)}
        {@const source = getAssetImageSource(asset)}
        {@const assetId = typeof asset.id === 'string' ? asset.id : ''}
        <article class="smrt-content-image-browser__asset-card" class:smrt-content-image-browser__asset-card--thumbnail={thumbnailAssetId === assetId} data-smrt-part="card">
          <div class="smrt-content-image-browser__asset-preview" data-smrt-part="preview">
            {#if source}
              <img src={source} alt={getAssetLabel(asset)} loading="lazy" decoding="async" />
            {:else}
              <span>{getAssetLabel(asset).slice(0, 1).toUpperCase()}</span>
            {/if}
          </div>
          <div class="smrt-content-image-browser__asset-meta" data-smrt-part="meta">
            <strong>{getAssetLabel(asset)}</strong>
            {#if thumbnailAssetId === assetId}
              <span>Thumbnail</span>
            {/if}
          </div>
          <div class="smrt-content-image-browser__asset-actions" data-smrt-part="actions">
            {#if onUseAsset}
              <Button variant="ghost" type="button" class="asset-action-btn" onclick={() => onUseAsset?.(asset)}>{selectActionLabel}</Button>
            {/if}
            {#if onUseAsThumbnail && assetId && thumbnailAssetId !== assetId}
              <Button variant="ghost" type="button" class="asset-action-btn" onclick={() => onUseAsThumbnail?.(assetId)}>Thumbnail</Button>
            {/if}
            {#if onRemoveAsset && assetId}
              <Button variant="ghost" type="button" class="asset-action-btn asset-action-btn--danger" onclick={() => onRemoveAsset?.(assetId)}>Remove</Button>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {:else}
    <p class="smrt-content-image-browser__empty-state" data-smrt-part="empty">{t(M['content.content_image_browser.no_images_attached'])}</p>
  {/if}

  {#if showUploader}
    <div class="smrt-content-image-browser__uploader-panel" data-smrt-part="panel">
      <ImageUploader {apiBaseUrl} onSelect={handleSelect} onCancel={() => showUploader = false} />
    </div>
  {:else if onSelectImage}
    <Button variant="ghost" type="button" class="asset-action-btn add-image-button" onclick={() => showUploader = true}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2"></rect>
        <circle cx="8.5" cy="8.5" r="1.5"></circle>
        <path d="m21 15-5-5L5 21"></path>
      </svg>
      {addButtonLabel}
    </Button>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-content-image-browser__root {
    display: grid;
    gap: 1rem;
    min-height: 5.5rem;
    padding: 1rem;
  }
  .smrt-content-image-browser__asset-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: 0.75rem;
  }
  .smrt-content-image-browser__asset-card {
    display: grid;
    gap: 0.75rem;
    padding: 0.75rem;
  }
  .smrt-content-image-browser__asset-preview {
    display: grid;
    place-items: center;
    aspect-ratio: 16 / 9;
    overflow: hidden;
  }
  .smrt-content-image-browser__asset-preview img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .smrt-content-image-browser__asset-meta {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }
  .smrt-content-image-browser__asset-meta strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-content-image-browser__empty-state {
    margin: 0;
  }
  .smrt-content-image-browser__asset-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .smrt-content-image-browser__root :global(.asset-action-btn) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    min-height: 2.35rem;
    cursor: pointer;
    padding: 0.5rem 0.875rem;
  }
  .smrt-content-image-browser__root :global(.add-image-button) {
    justify-self: start;
  }
  .smrt-content-image-browser__root :global(.add-image-button svg) {
    width: 1rem;
    height: 1rem;
  }
  .smrt-content-image-browser__uploader-panel {
    overflow: hidden;
  }
}

@layer smrt.theme {
  .smrt-content-image-browser__root {
    border: 1px dashed color-mix(in srgb, var(--smrt-color-outline) 45%, transparent);
    border-radius: 0.5rem;
  }
  .smrt-content-image-browser__asset-card {
    border: 1px solid color-mix(in srgb, var(--smrt-color-outline) 28%, transparent);
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-content-image-browser__asset-card--thumbnail {
    border-color: var(--smrt-color-primary);
  }
  .smrt-content-image-browser__asset-preview {
    border-radius: 0.375rem;
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }
  .smrt-content-image-browser__asset-meta strong {
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
  }
  .smrt-content-image-browser__asset-meta span,
  .smrt-content-image-browser__empty-state {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  .smrt-content-image-browser__empty-state {
    font-style: italic;
  }
  .smrt-content-image-browser__root :global(.asset-action-btn) {
    border: var(--smrt-hairline-strong);
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
    font: inherit;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-content-image-browser__root :global(.asset-action-btn:hover) {
    background: var(--smrt-color-surface-container-high);
  }
  .smrt-content-image-browser__root :global(.asset-action-btn--danger) {
    color: var(--smrt-color-error);
  }
  .smrt-content-image-browser__root :global(.add-image-button svg) {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .smrt-content-image-browser__uploader-panel {
    border-radius: 0.5rem;
  }
}

</style>
