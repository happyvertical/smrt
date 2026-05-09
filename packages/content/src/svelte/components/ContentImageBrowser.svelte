<script lang="ts">
import {
  type ImageLike,
  ImageUploader,
} from '@happyvertical/smrt-images/svelte';

export interface Props {
  apiBaseUrl?: string;
  assets?: any[];
  thumbnailAssetId?: string | null;
  addButtonLabel?: string;
  selectActionLabel?: string;
  showUploaderInitially?: boolean;
  onSelectImage?: (image: ImageLike | File | string) => void;
  onUseAsset?: (asset: any) => void;
  onRemoveAsset?: (assetId: string) => void;
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
  if (showUploaderInitially) {
    showUploader = true;
  }
});

function getAssetImageSource(asset: any): string {
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

function getAssetLabel(asset: any): string {
  return String(
    asset?.name || asset?.title || asset?.filename || asset?.id || 'Image',
  );
}

function handleSelect(selected: ImageLike | File | string) {
  onSelectImage?.(selected);
  showUploader = false;
}
</script>

<div class="content-image-browser">
  {#if assets.length}
    <div class="asset-grid">
      {#each assets as asset (asset.id || getAssetLabel(asset))}
        {@const source = getAssetImageSource(asset)}
        <article class="asset-card" class:asset-card--thumbnail={thumbnailAssetId === asset.id}>
          <div class="asset-preview">
            {#if source}
              <img src={source} alt={getAssetLabel(asset)} />
            {:else}
              <span>{getAssetLabel(asset).slice(0, 1).toUpperCase()}</span>
            {/if}
          </div>
          <div class="asset-meta">
            <strong>{getAssetLabel(asset)}</strong>
            {#if thumbnailAssetId === asset.id}
              <span>Thumbnail</span>
            {/if}
          </div>
          <div class="asset-actions">
            {#if onUseAsset}
              <button type="button" onclick={() => onUseAsset?.(asset)}>{selectActionLabel}</button>
            {/if}
            {#if onUseAsThumbnail && asset.id && thumbnailAssetId !== asset.id}
              <button type="button" onclick={() => onUseAsThumbnail?.(asset.id)}>Thumbnail</button>
            {/if}
            {#if onRemoveAsset && asset.id}
              <button type="button" class="danger" onclick={() => onRemoveAsset?.(asset.id)}>Remove</button>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {:else}
    <p class="empty-state">No images attached.</p>
  {/if}

  {#if showUploader}
    <div class="uploader-panel">
      <ImageUploader {apiBaseUrl} onSelect={handleSelect} onCancel={() => showUploader = false} />
    </div>
  {:else if onSelectImage}
    <button type="button" class="add-image-button" onclick={() => showUploader = true}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2"></rect>
        <circle cx="8.5" cy="8.5" r="1.5"></circle>
        <path d="m21 15-5-5L5 21"></path>
      </svg>
      {addButtonLabel}
    </button>
  {/if}
</div>

<style>
  .content-image-browser {
    display: grid;
    gap: 1rem;
    min-height: 5.5rem;
    padding: 1rem;
    border: 1px dashed color-mix(in srgb, var(--smrt-color-outline) 45%, transparent);
    border-radius: 0.5rem;
  }

  .asset-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: 0.75rem;
  }

  .asset-card {
    display: grid;
    gap: 0.75rem;
    border: 1px solid color-mix(in srgb, var(--smrt-color-outline) 28%, transparent);
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container-low);
    padding: 0.75rem;
  }

  .asset-card--thumbnail {
    border-color: var(--smrt-color-primary);
  }

  .asset-preview {
    display: grid;
    place-items: center;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border-radius: 0.375rem;
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
    font-size: 1.5rem;
    font-weight: 700;
  }

  .asset-preview img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .asset-meta {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }

  .asset-meta strong {
    overflow: hidden;
    color: var(--smrt-color-on-surface);
    font-size: 0.875rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .asset-meta span,
  .empty-state {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.875rem;
  }

  .empty-state {
    margin: 0;
    font-style: italic;
  }

  .asset-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    min-height: 2.35rem;
    border: 1px solid var(--smrt-color-outline);
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
    cursor: pointer;
    font: inherit;
    font-size: 0.875rem;
    font-weight: 600;
    padding: 0.5rem 0.875rem;
  }

  button:hover {
    background: var(--smrt-color-surface-container-high);
  }

  button.danger {
    color: var(--smrt-color-error);
  }

  .add-image-button {
    justify-self: start;
  }

  .add-image-button svg {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .uploader-panel {
    border-radius: 0.5rem;
    overflow: hidden;
  }
</style>
