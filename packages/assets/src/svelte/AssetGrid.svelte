<script lang="ts">
/**
 * AssetGrid - Thumbnail grid view for assets
 *
 * Displays assets as cards in a responsive grid, with selection checkboxes,
 * type-based thumbnails, and missing alt-text warnings for images.
 */

import type { Asset } from '../asset';
import type { AssetGridProps } from './types';

let {
  assets,
  selectedIds,
  onselectionchange,
  onassetclick,
  onassetdblclick,
  loading = false,
}: AssetGridProps = $props();

function toggleSelection(asset: Asset, event: Event) {
  event.stopPropagation();
  const next = new Set(selectedIds);
  if (next.has(asset.id!)) {
    next.delete(asset.id!);
  } else {
    next.add(asset.id!);
  }
  onselectionchange(next);
}

function handleClick(asset: Asset) {
  onassetclick(asset);
}

function handleDblClick(asset: Asset) {
  onassetdblclick?.(asset);
}

function handleKeydown(asset: Asset, event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    onassetclick(asset);
  }
}

function isImage(asset: Asset): boolean {
  return asset.mimeType?.startsWith('image/') ?? false;
}

function isVideo(asset: Asset): boolean {
  return asset.mimeType?.startsWith('video/') ?? false;
}

function isAudio(asset: Asset): boolean {
  return asset.mimeType?.startsWith('audio/') ?? false;
}

/** True if it's an image-like asset missing alt text */
function isMissingAlt(asset: Asset): boolean {
  return isImage(asset) && !(asset as any).alt;
}

function getTypeIcon(asset: Asset): string {
  if (isVideo(asset)) return '🎬';
  if (isAudio(asset)) return '🎵';
  if (asset.mimeType?.includes('pdf')) return '📄';
  if (asset.mimeType?.startsWith('text/')) return '📝';
  return '📎';
}

function formatFileSize(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
        {@const selected = selectedIds.has(asset.id!)}
        <div
          class="asset-card"
          class:asset-card--selected={selected}
          role="button"
          tabindex="0"
          onclick={() => handleClick(asset)}
          ondblclick={() => handleDblClick(asset)}
          onkeydown={(e) => handleKeydown(asset, e)}
        >
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
                alt={(asset as any).alt || asset.name}
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
    box-shadow: var(--smrt-elevation-level2, 0 1px 3px rgba(0,0,0,0.1));
    transform: translateY(-1px);
  }

  .asset-card:focus-visible {
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
    font-size: 2.5rem;
  }

  /* Info */
  .asset-card__info {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }

  .asset-card__name {
    display: block;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: 500;
    color: var(--smrt-color-on-surface, #111827);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .asset-card__meta {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    margin-top: 2px;
  }

  .asset-card__type {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* Badge */
  .asset-card__badge {
    position: absolute;
    top: var(--smrt-spacing-2, 0.5rem);
    right: var(--smrt-spacing-2, 0.5rem);
    padding: 2px 6px;
    font-size: 0.65rem;
    font-weight: 600;
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
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Empty */
  .asset-grid__empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--smrt-spacing-12, 3rem) var(--smrt-spacing-4, 1rem);
    text-align: center;
  }

  .empty-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 80px;
    height: 80px;
    margin-bottom: var(--smrt-spacing-4, 1rem);
    background: var(--smrt-color-secondary-container, #e0e7ef);
    color: var(--smrt-color-on-secondary-container, #1a1c2e);
    border-radius: 24px;
    padding: 16px;
  }

  .empty-title {
    margin: 0 0 var(--smrt-spacing-2, 0.5rem);
    font-size: var(--smrt-typography-title-medium-size, 1rem);
    font-weight: 500;
    color: var(--smrt-color-on-surface, #111827);
  }

  .empty-description {
    margin: 0;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant, #6b7280);
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
