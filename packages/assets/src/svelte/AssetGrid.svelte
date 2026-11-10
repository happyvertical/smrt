<script lang="ts">
/**
 * AssetGrid - Thumbnail grid view for assets
 *
 * Displays assets as cards in a responsive grid, with selection checkboxes,
 * type-based thumbnails, and missing alt-text warnings for images.
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from './i18n.js';
import type { AssetGridProps, PersistedAsset } from './types';

const { t } = useI18n();

let {
  assets,
  selectedIds,
  onSelectionChange,
  onAssetClick,
  onAssetDblClick,
  loading = false,
  mode = 'manage',
}: AssetGridProps = $props();

// A card click opens the detail view in manage mode, or toggles selection in
// pick mode — label the action accordingly.
function openCardLabel(name: string): string {
  return mode === 'pick'
    ? t(M['assets.asset_grid.select_named'], { name })
    : t(M['assets.asset_grid.open_named'], { name });
}

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

<div class="smrt-asset-grid__root" class:smrt-asset-grid__loading={loading} data-smrt-component="AssetGrid">
  {#if loading}
    <div class="smrt-asset-grid__loading-panel" data-smrt-part="status">
      <span class="smrt-asset-grid__spinner" data-smrt-part="icon"></span>
      <span>{t(M['assets.asset_grid.loading'])}</span>
    </div>
  {:else if assets.length === 0}
    <div class="smrt-asset-grid__empty" data-smrt-part="empty">
      <div class="smrt-asset-grid__empty-icon" data-smrt-part="icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <polyline points="21 15 16 10 5 21"></polyline>
        </svg>
      </div>
      <p class="smrt-asset-grid__empty-title" data-smrt-part="title">{t(M['assets.asset_grid.no_assets_found'])}</p>
      <p class="smrt-asset-grid__empty-desc" data-smrt-part="hint">{t(M['assets.asset_grid.empty_hint'])}</p>
    </div>
  {:else}
    <div class="smrt-asset-grid__grid" data-smrt-part="list">
      {#each assets as asset (asset.id)}
        {@const selected = selectedIds.has(asset.id)}
        <div class="smrt-asset-grid__card" class:smrt-asset-grid__card-selected={selected} data-smrt-part="item">
          <!-- Whole-card "open" action. A stretched, transparent button (vs. a
               role="button" on the card) avoids nesting the interactive checkbox
               inside an interactive control (axe nested-interactive). It sits
               above the non-interactive content but below the checkbox (z-index),
               and is keyboard-activatable natively (Enter/Space). -->
          <!-- raw-primitive-allow: stretched transparent click-catching card overlay positioned absolute inset 0, layered under the checkbox by z-index; not a styled action button -->
          <button
            type="button"
            class="smrt-asset-grid__card-open"
            data-smrt-part="trigger"
            aria-label={openCardLabel(asset.name || 'Untitled')}
            title={asset.name || 'Untitled'}
            onclick={() => handleClick(asset)}
            ondblclick={() => handleDblClick(asset)}
          ></button>

          <!-- Selection checkbox -->
          <div class="smrt-asset-grid__checkbox" data-smrt-part="selection">
            <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
            <input
              type="checkbox"
              checked={selected}
              onchange={(e) => toggleSelection(asset, e)}
              onclick={(e) => e.stopPropagation()}
              aria-label={t(M['assets.asset_grid.select_named_checkbox'], { name: asset.name })}
            />
          </div>

          <!-- Thumbnail area -->
          <div class="smrt-asset-grid__thumb" data-smrt-part="thumbnail">
            {#if isImage(asset) && asset.sourceUri}
              <img
                src={asset.sourceUri}
                alt={getAltText(asset) || asset.name}
                class="smrt-asset-grid__image"
                data-smrt-part="content"
                loading="lazy"
              />
            {:else}
              <span class="smrt-asset-grid__type-icon" data-smrt-part="icon">{getTypeIcon(asset)}</span>
            {/if}
          </div>

          <!-- Info bar -->
          <div class="smrt-asset-grid__info" data-smrt-part="details">
            <span class="smrt-asset-grid__name" data-smrt-part="title" title={asset.name}>{asset.name || 'Untitled'}</span>

            <div class="smrt-asset-grid__meta" data-smrt-part="meta">
              {#if asset.mimeType}
                <span class="smrt-asset-grid__type" data-smrt-part="value">{asset.mimeType.split('/')[1]?.toUpperCase()}</span>
              {/if}
            </div>
          </div>

          <!-- Badges / warnings -->
          {#if isMissingAlt(asset)}
            <span class="smrt-asset-grid__badge smrt-asset-grid__badge-warning" data-smrt-part="badge" title={t(M['assets.asset_grid.missing_alt_text'])}>{t(M['assets.asset_grid.no_alt'])}</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-asset-grid__root {
    padding: var(--smrt-spacing-4, 1rem);
  }
  /* Loading state blocks interaction while a fetch is in flight. */
  .smrt-asset-grid__loading {
    pointer-events: none;
  }
  .smrt-asset-grid__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: var(--smrt-spacing-4, 1rem);
  }
  /* Card */
  .smrt-asset-grid__card {
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    cursor: pointer;
  }
  /* Stretched whole-card open action. Transparent, covers the card, sits above
  the non-interactive content (z-index 1) but below the checkbox (z-index 2). */
  .smrt-asset-grid__card-open {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    cursor: pointer;
    z-index: 1;
  }
  /* Checkbox */
  .smrt-asset-grid__checkbox {
    position: absolute;
    top: var(--smrt-spacing-2, 0.5rem);
    left: var(--smrt-spacing-2, 0.5rem);
    z-index: 2;
    opacity: 0;
  }
  .smrt-asset-grid__checkbox input {
    width: 18px;
    height: 18px;
    cursor: pointer;
  }
  .smrt-asset-grid__card:hover .smrt-asset-grid__checkbox,
  .smrt-asset-grid__card-selected .smrt-asset-grid__checkbox {
    opacity: 1;
  }
  /* Thumbnail */
  .smrt-asset-grid__thumb {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 140px;
    overflow: hidden;
  }
  .smrt-asset-grid__image {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  /* Info */
  .smrt-asset-grid__info {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-asset-grid__name {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-asset-grid__meta {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    margin-top: var(--smrt-spacing-1);
  }
  /* Badge */
  .smrt-asset-grid__badge {
    position: absolute;
    top: var(--smrt-spacing-2, 0.5rem);
    right: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
    z-index: 2;
    /* Informational only — let clicks fall through to the stretched open button
    below so the badge corner isn't a dead zone for opening the asset. */
    pointer-events: none;
  }
  /* Loading */
  .smrt-asset-grid__loading-panel {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-8, 2rem);
  }
  .smrt-asset-grid__spinner {
    width: 20px;
    height: 20px;
  }
  @media (max-width: 640px) {
    .smrt-asset-grid__grid {
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: var(--smrt-spacing-3, 0.75rem);
    }
    .smrt-asset-grid__thumb {
      height: 100px;
    }
  }
}

@layer smrt.theme {
  .smrt-asset-grid__loading {
    opacity: 0.6;
  }
  /* Card */
  .smrt-asset-grid__card {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    transition: all 150ms ease;
  }
  .smrt-asset-grid__card:hover {
    box-shadow: var(--smrt-elevation-2, 0 1px 3px rgba(0,0,0,0.1));
    transform: translateY(-1px);
  }
  /* Stretched whole-card open action. Transparent, covers the card, sits above
  the non-interactive content (z-index 1) but below the checkbox (z-index 2). */
  .smrt-asset-grid__card-open {
    border: none;
    background: transparent;
    border-radius: inherit;
  }
  .smrt-asset-grid__card-open:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    /* Inset so the card's `overflow: hidden` doesn't clip the focus ring. */
    outline-offset: -2px;
  }
  .smrt-asset-grid__card-selected {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary-container);
  }
  /* Checkbox */
  .smrt-asset-grid__checkbox {
    transition: opacity 150ms ease;
  }
  .smrt-asset-grid__checkbox input {
    accent-color: var(--smrt-color-primary);
  }
  /* Thumbnail */
  .smrt-asset-grid__thumb {
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-asset-grid__type-icon {
    font-size: var(--smrt-typography-display-medium-size, 2.5rem);
  }
  .smrt-asset-grid__name {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
  }
  .smrt-asset-grid__type {
    font-size: var(--smrt-typography-label-small-size, 0.7rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.05em);
  }
  /* Badge */
  .smrt-asset-grid__badge {
    font-size: var(--smrt-typography-label-small-size, 0.65rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    border-radius: var(--smrt-radius-small, 0.25rem);
  }
  .smrt-asset-grid__badge-warning {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  /* Loading */
  .smrt-asset-grid__loading-panel {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-asset-grid__spinner {
    border: 2px solid var(--smrt-color-outline-variant);
    border-top-color: var(--smrt-color-primary);
    border-radius: var(--smrt-radius-full);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-asset-grid__spinner {
      animation: none;
    }
  }
}

</style>
