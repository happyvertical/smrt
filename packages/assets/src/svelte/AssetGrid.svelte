<script lang="ts">
/**
 * AssetGrid - Thumbnail grid view for assets
 *
 * Displays assets as cards in a responsive grid, with selection checkboxes,
 * type-based thumbnails, and missing alt-text warnings for images.
 */

import type { AssetGridProps, PersistedAsset } from './types';

let {
  assets,
  selectedIds,
  onSelectionChange,
  onAssetClick,
  onAssetDblClick,
  loading = false,
}: AssetGridProps = $props();

function toggleSelection(asset: PersistedAsset, event: Event) {
  event.stopPropagation();
  const next = new Set(selectedIds);
  if (next.has(asset.id)) {
    next.delete(asset.id);
  } else {
    next.add(asset.id);
  }
  onSelectionChange(next);
}

function handleClick(asset: PersistedAsset) {
  onAssetClick(asset);
}

function handleDblClick(asset: PersistedAsset) {
  onAssetDblClick?.(asset);
}

function isImage(asset: PersistedAsset): boolean {
  return asset.mimeType?.startsWith('image/') ?? false;
}

function isVideo(asset: PersistedAsset): boolean {
  return asset.mimeType?.startsWith('video/') ?? false;
}

function isAudio(asset: PersistedAsset): boolean {
  return asset.mimeType?.startsWith('audio/') ?? false;
}

/** True if it's an image-like asset missing alt text */
function isMissingAlt(asset: PersistedAsset): boolean {
  return isImage(asset) && !getAltText(asset);
}

function getTypeIcon(asset: PersistedAsset): string {
  if (isVideo(asset)) return '🎬';
  if (isAudio(asset)) return '🎵';
  if (asset.mimeType?.includes('pdf')) return '📄';
  if (asset.mimeType?.startsWith('text/')) return '📝';
  return '📎';
}

function getAltText(asset: PersistedAsset): string {
  return 'alt' in asset && typeof asset.alt === 'string' ? asset.alt : '';
}
</script>

<div class="asset-grid" class:asset-grid--loading={loading}>
  {#if loading}
    <div class="asset-grid__loading">
      <span class="spinner"></span>
      <span>Loading assets...</span>
    </div>
  {:else if assets.length === 0}
    <div class="empty-state">
      <div class="empty-state__icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <polyline points="21 15 16 10 5 21"></polyline>
        </svg>
      </div>
      <p class="empty-state__title">No assets found</p>
      <p class="empty-state__desc">Upload an asset or change your search filters to see results.</p>
    </div>
  {:else}
    <div class="grid">
      {#each assets as asset (asset.id)}
        {@const selected = selectedIds.has(asset.id)}
        <div class="asset-card" class:asset-card--selected={selected}>
          <!-- Whole-card "open" action. A stretched, transparent button (vs. a
               role="button" on the card) avoids nesting the interactive checkbox
               inside an interactive control (axe nested-interactive). It sits
               above the non-interactive content but below the checkbox (z-index),
               and is keyboard-activatable natively (Enter/Space). -->
          <button
            type="button"
            class="asset-card__open"
            aria-label="Open {asset.name || 'Untitled'}"
            onclick={() => handleClick(asset)}
            ondblclick={() => handleDblClick(asset)}
          ></button>

          <!-- Selection checkbox -->
          <div class="asset-card__checkbox">
            <input
              type="checkbox"
              checked={selected}
              onchange={(e) => toggleSelection(asset, e)}
              onclick={(e) => e.stopPropagation()}
              aria-label="Select {asset.name}"
            />
          </div>

          <!-- Thumbnail area -->
          <div class="asset-card__thumb">
            {#if isImage(asset) && asset.sourceUri}
              <img
                src={asset.sourceUri}
                alt={getAltText(asset) || asset.name}
                class="asset-card__image"
                loading="lazy"
              />
            {:else}
              <span class="asset-card__type-icon">{getTypeIcon(asset)}</span>
            {/if}
          </div>

          <!-- Info bar -->
          <div class="asset-card__info">
            <span class="asset-card__name" title={asset.name}>{asset.name || 'Untitled'}</span>

            <div class="asset-card__meta">
              {#if asset.mimeType}
                <span class="asset-card__type">{asset.mimeType.split('/')[1]?.toUpperCase()}</span>
              {/if}
            </div>
          </div>

          <!-- Badges / warnings -->
          {#if isMissingAlt(asset)}
            <span class="asset-card__badge asset-card__badge--warning" title="Missing alt text">⚠️ No alt</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .asset-grid {
    padding: var(--smrt-spacing-4, 1rem);
  }

  .asset-grid--loading {
    opacity: 0.6;
    pointer-events: none;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: var(--smrt-spacing-4, 1rem);
  }

  /* Card */
  .asset-card {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--smrt-color-surface, #ffffff);
    border: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    overflow: hidden;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .asset-card:hover {
    box-shadow: var(--smrt-elevation-2, 0 1px 3px rgba(0,0,0,0.1));
    transform: translateY(-1px);
  }

  /* Stretched whole-card open action. Transparent, covers the card, sits above
     the non-interactive content (z-index 1) but below the checkbox (z-index 2). */
  .asset-card__open {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
    z-index: 1;
    border-radius: inherit;
  }

  .asset-card__open:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: 2px;
  }

  .asset-card--selected {
    border-color: var(--smrt-color-primary, #005ac1);
    background: var(--smrt-color-primary-container, #dbeafe);
  }

  /* Checkbox */
  .asset-card__checkbox {
    position: absolute;
    top: var(--smrt-spacing-2, 0.5rem);
    left: var(--smrt-spacing-2, 0.5rem);
    z-index: 2;
    opacity: 0;
    transition: opacity 150ms ease;
  }

  .asset-card:hover .asset-card__checkbox,
  .asset-card--selected .asset-card__checkbox {
    opacity: 1;
  }

  .asset-card__checkbox input {
    width: 18px;
    height: 18px;
    cursor: pointer;
    accent-color: var(--smrt-color-primary, #005ac1);
  }

  /* Thumbnail */
  .asset-card__thumb {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 140px;
    background: var(--smrt-color-surface-container-low, #f9fafb);
    overflow: hidden;
  }

  .asset-card__image {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .asset-card__type-icon {
    font-size: var(--smrt-typography-display-medium-size, 2.5rem);
  }

  /* Info */
  .asset-card__info {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }

  .asset-card__name {
    display: block;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface, #111827);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .asset-card__meta {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    margin-top: var(--smrt-spacing-1, 4px);
  }

  .asset-card__type {
    font-size: var(--smrt-typography-label-small-size, 0.7rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface-variant, #6b7280);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.05em);
  }

  /* Badge */
  .asset-card__badge {
    position: absolute;
    top: var(--smrt-spacing-2, 0.5rem);
    right: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    font-size: var(--smrt-typography-label-small-size, 0.65rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    border-radius: var(--smrt-radius-small, 0.25rem);
    z-index: 2;
  }

  .asset-card__badge--warning {
    background: var(--smrt-color-error-container, #fef2f2);
    color: var(--smrt-color-on-error-container, #991b1b);
  }

  /* Loading */
  .asset-grid__loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-8, 2rem);
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--smrt-color-outline-variant, #e5e7eb);
    border-top-color: var(--smrt-color-primary, #005ac1);
    border-radius: var(--smrt-radius-full, 9999px);
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 640px) {
    .grid {
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: var(--smrt-spacing-3, 0.75rem);
    }

    .asset-card__thumb {
      height: 100px;
    }
  }
</style>
