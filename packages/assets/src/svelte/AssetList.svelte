<script lang="ts">
/**
 * AssetList - Table/list view for assets
 *
 * Displays assets in a sortable table with selection, thumbnail previews,
 * type badges, and metadata columns.
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from './i18n.js';
import type {
  AssetListProps,
  AssetSort,
  AssetSortField,
  PersistedAsset,
} from './types';

const { t } = useI18n();

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

<div class="smrt-asset-list__root" class:smrt-asset-list__loading={loading} data-smrt-component="AssetList">
  <table class="smrt-asset-list__table" data-smrt-part="list">
    <thead class="smrt-asset-list__head" data-smrt-part="header">
      <tr>
        <th class="smrt-asset-list__col-checkbox" data-smrt-part="cell">
          <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
          <input
            type="checkbox"
            checked={allSelected}
            use:setIndeterminate={someSelected}
            onchange={toggleSelectAll}
            aria-label={t(M['assets.asset_list.select_all'])}
          />
        </th>
        <th class="smrt-asset-list__col-thumb" data-smrt-part="cell">Preview</th>
        <th class="smrt-asset-list__col-name" data-smrt-part="cell">
          <Button variant="ghost" size="sm" onclick={() => handleSort('name')}>
            Name <span class="smrt-asset-list__sort-indicator" data-smrt-part="icon">{getSortIndicator('name')}</span>
          </Button>
        </th>
        <th class="smrt-asset-list__col-type" data-smrt-part="cell">Type</th>
        <th class="smrt-asset-list__col-date" data-smrt-part="cell">
          <Button variant="ghost" size="sm" onclick={() => handleSort('createdAt')}>
            Created <span class="smrt-asset-list__sort-indicator" data-smrt-part="icon">{getSortIndicator('createdAt')}</span>
          </Button>
        </th>
        <th class="smrt-asset-list__col-status" data-smrt-part="cell">Status</th>
      </tr>
    </thead>
    <tbody class="smrt-asset-list__body" data-smrt-part="body">
      {#if loading}
        <tr>
          <td colspan="6" class="smrt-asset-list__empty-cell" data-smrt-part="empty">
            <div class="smrt-asset-list__loading-panel" data-smrt-part="status">
              <span class="smrt-asset-list__spinner" data-smrt-part="spinner"></span>
              <span>{t(M['assets.asset_list.loading'])}</span>
            </div>
          </td>
        </tr>
      {:else if assets.length === 0}
        <tr>
          <td colspan="6" class="smrt-asset-list__empty-cell" data-smrt-part="empty">
            <div class="smrt-asset-list__empty" data-smrt-part="empty">
              <div class="smrt-asset-list__empty-icon" data-smrt-part="icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="8" y1="6" x2="21" y2="6"></line>
                  <line x1="8" y1="12" x2="21" y2="12"></line>
                  <line x1="8" y1="18" x2="21" y2="18"></line>
                  <line x1="3" y1="6" x2="3.01" y2="6"></line>
                  <line x1="3" y1="12" x2="3.01" y2="12"></line>
                  <line x1="3" y1="18" x2="3.01" y2="18"></line>
                </svg>
              </div>
              <p class="smrt-asset-list__empty-title" data-smrt-part="title">{t(M['assets.asset_list.no_assets_found'])}</p>
              <p class="smrt-asset-list__empty-desc" data-smrt-part="description">{t(M['assets.asset_list.empty_hint'])}</p>
            </div>
          </td>
        </tr>
      {:else}
        {#each assets as asset (asset.id)}
          {@const selected = selectedIds.has(asset.id)}
          <tr
            class="smrt-asset-list__row"
            class:smrt-asset-list__row-selected={selected}
            data-smrt-part="row"
          >
            <td class="smrt-asset-list__col-checkbox" data-smrt-part="cell">
              <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
              <input
                type="checkbox"
                checked={selected}
                onchange={(e) => toggleSelection(asset, e)}
                onclick={(e) => e.stopPropagation()}
                aria-label={t(M['assets.asset_list.select_named'], { name: asset.name })}
              />
            </td>
            <td class="smrt-asset-list__col-thumb" data-smrt-part="cell">
              {#if isImage(asset) && asset.sourceUri}
                <img src={asset.sourceUri} alt={(asset as any).alt || asset.name} class="smrt-asset-list__row-thumb" data-smrt-part="media" loading="lazy" />
              {:else}
                <span class="smrt-asset-list__row-thumb-placeholder" data-smrt-part="media">{getTypeBadge(asset)}</span>
              {/if}
            </td>
            <td class="smrt-asset-list__col-name" data-smrt-part="cell">
              <!-- The name is the row's open action (a button, not a
                   role="button" on the row nesting the checkbox, which avoids axe
                   nested-interactive). -->
              <Button
                variant="ghost"
                class="smrt-asset-list__row-name"
                onclick={() => onAssetClick(asset)}
              >
                {asset.name || 'Untitled'}
              </Button>
              {#if asset.description}
                <span class="smrt-asset-list__row-desc" data-smrt-part="body">{asset.description}</span>
              {/if}
            </td>
            <td class="smrt-asset-list__col-type" data-smrt-part="cell">
              <span class="smrt-asset-list__type-badge" data-smrt-part="badge">{getTypeBadge(asset)}</span>
            </td>
            <td class="smrt-asset-list__col-date" data-smrt-part="cell">
              {formatDate(asset.createdAt)}
            </td>
            <td class="smrt-asset-list__col-status" data-smrt-part="cell">
              <span class="smrt-asset-list__status-dot" class:smrt-asset-list__status-dot-active={asset.statusSlug === 'active' || asset.statusSlug === 'published'} data-smrt-part="status"></span>
              {asset.statusSlug || 'draft'}
            </td>
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-asset-list__root {
    overflow-x: auto;
  }
  /* Loading state blocks interaction while a fetch is in flight. */
  .smrt-asset-list__loading {
    pointer-events: none;
  }
  .smrt-asset-list__table {
    width: 100%;
  }
  .smrt-asset-list__head th {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    white-space: nowrap;
  }
  .smrt-asset-list__row td {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-asset-list__col-checkbox {
    width: 40px;
  }
  .smrt-asset-list__col-checkbox input {
    width: 16px;
    height: 16px;
    cursor: pointer;
  }
  .smrt-asset-list__col-thumb {
    width: 48px;
  }
  .smrt-asset-list__row-thumb {
    width: 40px;
    height: 40px;
    object-fit: cover;
  }
  .smrt-asset-list__row-thumb-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
  }
  .smrt-asset-list__col-name {
    min-width: 150px;
  }
  /* The row name renders via <Button> (issue #1589). The overrides reset it to
  inline name text and must reach the child-rendered <button> through :global()
  scoping. */
  .smrt-asset-list__col-name :global(.smrt-asset-list__row-name) {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 250px;
    /* Reset the open-action button so it renders as the row's name text. */
    margin: 0;
    padding: 0;
    cursor: pointer;
  }
  .smrt-asset-list__row-desc {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 250px;
  }
  .smrt-asset-list__type-badge {
    display: inline-block;
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
  }
  .smrt-asset-list__col-date {
    white-space: nowrap;
  }
  .smrt-asset-list__col-status {
    white-space: nowrap;
  }
  .smrt-asset-list__status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: var(--smrt-spacing-1);
  }
  /* Sort — renders via <Button> (issue #1589). Overrides reset it to an inline
  header-text button and reach the child <button> via :global(). */
  .smrt-asset-list__head :global([data-smrt-component="Button"]) {
    gap: var(--smrt-spacing-1);
    padding: 0;
  }
  /* Loading / Empty */
  .smrt-asset-list__loading-panel {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-8, 2rem);
  }
  .smrt-asset-list__spinner {
    width: 20px;
    height: 20px;
  }
}

@layer smrt.theme {
  .smrt-asset-list__loading {
    opacity: 0.6;
  }
  .smrt-asset-list__table {
    border-collapse: collapse;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface);
  }
  .smrt-asset-list__head {
    background: var(--smrt-color-surface-container);
  }
  .smrt-asset-list__head tr {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-asset-list__head th {
    text-align: left;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface);
  }
  .smrt-asset-list__row {
    border-bottom: var(--smrt-hairline);
    transition: background 150ms ease;
  }
  .smrt-asset-list__row:hover {
    background: var(--smrt-color-surface-container-low);
  }
  /* Doubled class: ties :hover above on specificity and wins by source order. */
  .smrt-asset-list__row.smrt-asset-list__row-selected {
    background: var(--smrt-color-primary-container);
  }
  .smrt-asset-list__row td {
    vertical-align: middle;
  }
  .smrt-asset-list__col-checkbox {
    text-align: center;
  }
  .smrt-asset-list__col-checkbox input {
    accent-color: var(--smrt-color-primary);
  }
  .smrt-asset-list__row-thumb {
    border-radius: var(--smrt-radius-small, 0.25rem);
  }
  .smrt-asset-list__row-thumb-placeholder {
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-small, 0.25rem);
    font-size: var(--smrt-typography-label-small-size, 0.6rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface-variant);
  }
  /* The row name renders via <Button> (issue #1589). The overrides reset it to
  inline name text and must reach the child-rendered <button> through :global()
  scoping. */
  .smrt-asset-list__col-name :global(.smrt-asset-list__row-name) {
    font-weight: var(--smrt-typography-weight-medium, 500);
    border: none;
    background: none;
    font-family: inherit;
    font-size: inherit;
    color: inherit;
    text-align: left;
  }
  .smrt-asset-list__col-name :global(.smrt-asset-list__row-name:hover) {
    text-decoration: underline;
  }
  .smrt-asset-list__row-desc {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-asset-list__type-badge {
    font-size: var(--smrt-typography-label-small-size, 0.65rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    text-transform: uppercase;
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
    border-radius: var(--smrt-radius-small, 0.25rem);
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.05em);
  }
  .smrt-asset-list__col-date {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-asset-list__col-status {
    text-transform: capitalize;
  }
  .smrt-asset-list__status-dot {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-outline);
    vertical-align: middle;
  }
  .smrt-asset-list__status-dot-active {
    background: var(--smrt-color-success);
  }
  /* Sort — renders via <Button> (issue #1589). Overrides reset it to an inline
  header-text button and reach the child <button> via :global(). */
  .smrt-asset-list__head :global([data-smrt-component="Button"]) {
    border: none;
    background: transparent;
    font: inherit;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: inherit;
  }
  .smrt-asset-list__head :global([data-smrt-component="Button"]:hover) {
    color: var(--smrt-color-primary);
  }
  .smrt-asset-list__sort-indicator {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    opacity: 0.5;
  }
  /* Loading / Empty */
  .smrt-asset-list__loading-panel {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-asset-list__spinner {
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
    .smrt-asset-list__spinner {
      animation: none;
    }
  }
}

</style>
