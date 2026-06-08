<script lang="ts">
/**
 * AssetList - Table/list view for assets
 *
 * Displays assets in a sortable table with selection, thumbnail previews,
 * type badges, and metadata columns.
 */

import type {
  AssetListProps,
  AssetSort,
  AssetSortField,
  PersistedAsset,
} from './types';

interface ListAsset extends PersistedAsset {
  alt?: string;
}

let {
  assets,
  selectedIds,
  sort,
  onSelectionChange,
  onAssetClick,
  onSortChange,
  loading = false,
}: AssetListProps = $props();

function toggleSelection(asset: ListAsset, event: Event) {
  event.stopPropagation();
  const next = new Set(selectedIds);
  if (next.has(asset.id)) {
    next.delete(asset.id);
  } else {
    next.add(asset.id);
  }
  onSelectionChange(next);
}

function toggleSelectAll() {
  if (allSelected) {
    onSelectionChange(new Set());
  } else {
    onSelectionChange(new Set(assets.map((a) => a.id)));
  }
}

function handleSort(field: AssetSortField) {
  if (sort.field === field) {
    onSortChange({
      field,
      direction: sort.direction === 'asc' ? 'desc' : 'asc',
    });
  } else {
    onSortChange({ field, direction: 'asc' });
  }
}

function getSortIndicator(field: AssetSortField): string {
  if (sort.field !== field) return '↕';
  return sort.direction === 'asc' ? '↑' : '↓';
}

function isImage(asset: ListAsset): boolean {
  return asset.mimeType?.startsWith('image/') ?? false;
}

function formatDate(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getTypeBadge(asset: ListAsset): string {
  if (isImage(asset)) return 'IMG';
  if (asset.mimeType?.startsWith('video/')) return 'VID';
  if (asset.mimeType?.startsWith('audio/')) return 'AUD';
  if (asset.mimeType?.includes('pdf')) return 'PDF';
  return 'DOC';
}

const allSelected = $derived(
  assets.length > 0 && assets.every((a) => selectedIds.has(a.id)),
);
const someSelected = $derived(
  assets.some((a) => selectedIds.has(a.id)) && !allSelected,
);

// Svelte action to set indeterminate
function setIndeterminate(node: HTMLInputElement, value: boolean) {
  node.indeterminate = value;
  return {
    update(newValue: boolean) {
      node.indeterminate = newValue;
    },
  };
}
</script>

<div class="asset-list" class:asset-list--loading={loading}>
  <table class="list-table">
    <thead class="list-table__head">
      <tr>
        <th class="col-checkbox">
          <input
            type="checkbox"
            checked={allSelected}
            use:setIndeterminate={someSelected}
            onchange={toggleSelectAll}
            aria-label="Select all"
          />
        </th>
        <th class="col-thumb">Preview</th>
        <th class="col-name">
          <button type="button" class="sort-btn" onclick={() => handleSort('name')}>
            Name <span class="sort-indicator">{getSortIndicator('name')}</span>
          </button>
        </th>
        <th class="col-type">Type</th>
        <th class="col-date">
          <button type="button" class="sort-btn" onclick={() => handleSort('createdAt')}>
            Created <span class="sort-indicator">{getSortIndicator('createdAt')}</span>
          </button>
        </th>
        <th class="col-status">Status</th>
      </tr>
    </thead>
    <tbody class="list-table__body">
      {#if loading}
        <tr>
          <td colspan="6" class="cell-empty">
            <div class="asset-list__loading">
              <span class="spinner"></span>
              <span>Loading assets...</span>
            </div>
          </td>
        </tr>
      {:else if assets.length === 0}
        <tr>
          <td colspan="6" class="cell-empty">
            <div class="empty-state">
              <div class="empty-state__icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="8" y1="6" x2="21" y2="6"></line>
                  <line x1="8" y1="12" x2="21" y2="12"></line>
                  <line x1="8" y1="18" x2="21" y2="18"></line>
                  <line x1="3" y1="6" x2="3.01" y2="6"></line>
                  <line x1="3" y1="12" x2="3.01" y2="12"></line>
                  <line x1="3" y1="18" x2="3.01" y2="18"></line>
                </svg>
              </div>
              <p class="empty-state__title">No assets found</p>
              <p class="empty-state__desc">Upload an asset or change your search filters to see results.</p>
            </div>
          </td>
        </tr>
      {:else}
        {#each assets as asset (asset.id)}
          {@const selected = selectedIds.has(asset.id)}
          <tr
            class="list-table__row"
            class:list-table__row--selected={selected}
            onclick={() => onAssetClick(asset)}
            role="button"
            tabindex="0"
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onAssetClick(asset);
              }
            }}
          >
            <td class="col-checkbox">
              <input
                type="checkbox"
                checked={selected}
                onchange={(e) => toggleSelection(asset, e)}
                onclick={(e) => e.stopPropagation()}
                aria-label="Select {asset.name}"
              />
            </td>
            <td class="col-thumb">
              {#if isImage(asset) && asset.sourceUri}
                <img src={asset.sourceUri} alt={(asset as any).alt || asset.name} class="row-thumb" loading="lazy" />
              {:else}
                <span class="row-thumb-placeholder">{getTypeBadge(asset)}</span>
              {/if}
            </td>
            <td class="col-name">
              <span class="row-name">{asset.name || 'Untitled'}</span>
              {#if asset.description}
                <span class="row-desc">{asset.description}</span>
              {/if}
            </td>
            <td class="col-type">
              <span class="type-badge">{getTypeBadge(asset)}</span>
            </td>
            <td class="col-date">
              {formatDate(asset.createdAt)}
            </td>
            <td class="col-status">
              <span class="status-dot" class:status-dot--active={asset.statusSlug === 'active' || asset.statusSlug === 'published'}></span>
              {asset.statusSlug || 'draft'}
            </td>
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>

<style>
  .asset-list {
    overflow-x: auto;
  }

  .asset-list--loading {
    opacity: 0.6;
    pointer-events: none;
  }

  .list-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface, #111827);
  }

  .list-table__head {
    background: var(--smrt-color-surface-container, #f3f4f6);
  }

  .list-table__head tr {
    border-bottom: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
  }

  .list-table__head th {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    text-align: left;
    font-weight: 600;
    white-space: nowrap;
    color: var(--smrt-color-on-surface, #111827);
  }

  .list-table__row {
    border-bottom: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    cursor: pointer;
    transition: background 150ms ease;
  }

  .list-table__row:hover {
    background: var(--smrt-color-surface-container-low, #f9fafb);
  }

  .list-table__row--selected {
    background: var(--smrt-color-primary-container, #dbeafe) !important;
  }

  .list-table__row td {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    vertical-align: middle;
  }

  .col-checkbox {
    width: 40px;
    text-align: center;
  }

  .col-checkbox input {
    width: 16px;
    height: 16px;
    cursor: pointer;
    accent-color: var(--smrt-color-primary, #005ac1);
  }

  .col-thumb {
    width: 48px;
  }

  .row-thumb {
    width: 40px;
    height: 40px;
    object-fit: cover;
    border-radius: var(--smrt-radius-small, 0.25rem);
  }

  .row-thumb-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    background: var(--smrt-color-surface-container, #f3f4f6);
    border-radius: var(--smrt-radius-small, 0.25rem);
    font-size: 0.6rem;
    font-weight: 700;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .col-name {
    min-width: 150px;
  }

  .row-name {
    display: block;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 250px;
  }

  .row-desc {
    display: block;
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 250px;
  }

  .type-badge {
    display: inline-block;
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    background: var(--smrt-color-surface-container, #f3f4f6);
    color: var(--smrt-color-on-surface-variant, #6b7280);
    border-radius: var(--smrt-radius-small, 0.25rem);
    letter-spacing: 0.05em;
  }

  .col-date {
    white-space: nowrap;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .col-status {
    white-space: nowrap;
    text-transform: capitalize;
  }

  .status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--smrt-color-outline, #9ca3af);
    margin-right: var(--smrt-spacing-1, 4px);
    vertical-align: middle;
  }

  .status-dot--active {
    background: var(--smrt-color-success, #22c55e);
  }

  /* Sort */
  .sort-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 4px);
    padding: 0;
    border: none;
    background: transparent;
    font: inherit;
    font-weight: 600;
    color: inherit;
    cursor: pointer;
  }

  .sort-btn:hover {
    color: var(--smrt-color-primary, #005ac1);
  }

  .sort-indicator {
    font-size: 0.75rem;
    opacity: 0.5;
  }

  /* Loading / Empty */
  .asset-list__loading {
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

  .list-table__row:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }
</style>
