<script lang="ts">
/**
 * AssetManager - Main shell component for the Asset Manager
 *
 * Orchestrates the toolbar, grid/list views, action bar, detail drawer,
 * and create modal. Can operate in 'manage' mode (full CRUD) or 'pick'
 * mode (selection-only for embedding as a picker).
 *
 * @example
 * ```svelte
 * <AssetManager
 *   tenantId={tenant.id}
 *   domain="products"
 *   mode="manage"
 *   customActions={[
 *     { label: 'Set as Cover', action: (selected) => setCover(selected[0]) }
 *   ]}
 * />
 * ```
 */

import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import ActionBar from './ActionBar.svelte';
import AssetDetail from './AssetDetail.svelte';
import AssetGrid from './AssetGrid.svelte';
import AssetList from './AssetList.svelte';
import AssetToolbar from './AssetToolbar.svelte';
import CreateAssetModal from './CreateAssetModal.svelte';
import { M } from './i18n.js';
import type {
  AssetFilters,
  AssetManagerProps,
  AssetSort,
  AssetViewMode,
  PersistedAsset,
} from './types';

const { t } = useI18n();

let {
  tenantId,
  dbFilters = {},
  mode = 'manage',
  accept,
  customActions = [],
  uploader,
  onSelect,
  onselect,
  onConfirm,
  onconfirm,
  initialView = 'grid',
  showFolders = false,
}: AssetManagerProps = $props();

function getInitialManagerState() {
  return {
    view: initialView,
  };
}

const initialManagerState = getInitialManagerState();
let view = $state<AssetViewMode>(initialManagerState.view);
let selectedIds = $state<Set<string>>(new Set());
let assets = $state<PersistedAsset[]>([]);
let loading = $state(false);
let showCreateModal = $state(false);
let showDetail = $state(false);
let detailAsset = $state<PersistedAsset | null>(null);
let pastedFile = $state<File | null>(null);
let filters = $state<AssetFilters>({
  search: '',
  types: [],
  tags: [],
  mimePatterns: [],
});
let sort = $state<AssetSort>({
  field: 'createdAt',
  direction: 'desc',
});
let managerDragOver = $state(false);

$effect(() => {
  const nextMimePatterns = accept ? [accept] : [];
  if (
    filters.mimePatterns.length !== nextMimePatterns.length ||
    filters.mimePatterns.some(
      (pattern, index) => pattern !== nextMimePatterns[index],
    )
  ) {
    filters = { ...filters, mimePatterns: nextMimePatterns };
  }
});

const selectedAssets = $derived(
  assets.filter((asset) => selectedIds.has(asset.id)),
);

function handleViewChange(newView: AssetViewMode) {
  view = newView;
}

function handleFilterChange(newFilters: AssetFilters) {
  filters = newFilters;
}

function handleSortChange(newSort: AssetSort) {
  sort = newSort;
}

function handleSelectionChange(ids: Set<string>) {
  selectedIds = ids;
  (onSelect ?? onselect)?.(assets.filter((asset) => ids.has(asset.id)));
}

function handleClearSelection() {
  selectedIds = new Set();
  (onSelect ?? onselect)?.([]);
}

function handleAssetClick(asset: PersistedAsset) {
  if (mode === 'pick') {
    const next = new Set(selectedIds);
    if (next.has(asset.id)) {
      next.delete(asset.id);
    } else {
      next.add(asset.id);
    }
    handleSelectionChange(next);
    return;
  }

  detailAsset = asset;
  showDetail = true;
}

function handleDetailClose() {
  showDetail = false;
  detailAsset = null;
}

async function handleDetailSave(
  asset: PersistedAsset,
  updates: {
    name?: string;
    description?: string;
    alt?: string;
    title?: string;
    caption?: string;
  },
) {
  Object.assign(asset, updates);
  console.log('Save asset:', asset.id, updates);
}

function handleAssetDblClick(asset: PersistedAsset) {
  if (mode === 'pick') {
    (onConfirm ?? onconfirm)?.([asset]);
  }
}

function handleUploaderClose() {
  showCreateModal = false;
  pastedFile = null;
}

function handleUpload() {
  pastedFile = null;
  showCreateModal = true;
}

function handleCreate(data: {
  file: File;
  name: string;
  description: string;
  altText: string;
}) {
  console.log('Create asset:', data);
  showCreateModal = false;
}

function handleDelete(toDelete: PersistedAsset[]) {
  assets = assets.filter(
    (asset) => !toDelete.some((item) => item.id === asset.id),
  );
  console.log(
    'Delete assets:',
    toDelete.map((asset) => asset.id),
  );
  selectedIds = new Set();
}

function handlePaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items;
  if (!items) return;

  for (const item of Array.from(items)) {
    if (!item.type.startsWith('image/')) continue;

    const file = item.getAsFile();
    if (!file) continue;

    event.preventDefault();
    pastedFile = file;
    showCreateModal = true;
    break;
  }
}

function handleManagerDragOver(event: DragEvent) {
  event.preventDefault();
  managerDragOver = true;
}

function handleManagerDragLeave(event: DragEvent) {
  const relatedTarget = event.relatedTarget as Node | null;
  const currentTarget = event.currentTarget as Node;
  if (relatedTarget && currentTarget.contains(relatedTarget)) return;
  managerDragOver = false;
}

function handleManagerDrop(event: DragEvent) {
  event.preventDefault();
  managerDragOver = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    pastedFile = file;
    showCreateModal = true;
  }
}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="asset-manager"
  class:asset-manager--drag-over={managerDragOver}
  onpaste={handlePaste}
  ondragover={handleManagerDragOver}
  ondragleave={handleManagerDragLeave}
  ondrop={handleManagerDrop}
>
  <!-- Toolbar -->
  <AssetToolbar
    {view}
    {filters}
    {sort}
    onViewChange={handleViewChange}
    onFilterChange={handleFilterChange}
    onSortChange={handleSortChange}
    onUpload={handleUpload}
  />

  <!-- Action Bar (visible when items selected) -->
  <ActionBar
    selectedAssets={selectedAssets}
    {customActions}
    onClearSelection={handleClearSelection}
    onDelete={handleDelete}
  />

  <!-- Main content area -->
  <div class="asset-manager__content">
    {#if view === 'grid'}
      <AssetGrid
        {assets}
        {selectedIds}
        {loading}
        {mode}
        onSelectionChange={handleSelectionChange}
        onAssetClick={handleAssetClick}
        onAssetDblClick={handleAssetDblClick}
      />
    {:else if view === 'list'}
      <AssetList
        {assets}
        {selectedIds}
        {sort}
        {loading}
        onSelectionChange={handleSelectionChange}
        onAssetClick={handleAssetClick}
        onSortChange={handleSortChange}
      />
    {/if}
  </div>

  <!-- Asset Detail Drawer -->
  <AssetDetail
    asset={detailAsset}
    open={showDetail}
    onclose={handleDetailClose}
    onsave={handleDetailSave}
    ondelete={(asset) => {
      handleDelete([asset as PersistedAsset]);
      handleDetailClose();
    }}
  />

  <!-- Drag overlay indicator -->
  {#if managerDragOver}
    <div class="drag-overlay">
      <div class="drag-overlay__content">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path>
          <polyline points="17 8 12 3 7 8"></polyline>
          <line x1="12" y1="3" x2="12" y2="15"></line>
        </svg>
        <p>{t(M['assets.asset_manager.drop_file_to_upload'])}</p>
      </div>
    </div>
  {/if}

  <!-- Create modal or custom uploader -->
  {#if uploader}
    {@render uploader({
      open: showCreateModal,
      initialFile: pastedFile,
      onClose: handleUploaderClose,
      onclose: handleUploaderClose,
      onCreate: handleCreate,
      oncreate: handleCreate
    })}
  {:else}
    <CreateAssetModal
      open={showCreateModal}
      initialFile={pastedFile}
      oncreate={handleCreate}
      onclose={handleUploaderClose}
    />
  {/if}
</div>

<style>
  .asset-manager {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 400px;
    background: var(--smrt-color-surface, #ffffff);
    border: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    border-radius: var(--smrt-radius-large, 0.75rem);
    overflow: hidden;
    font-family: var(--smrt-font-family, inherit);
  }

  .asset-manager--drag-over {
    border-color: var(--smrt-color-primary, #005ac1);
  }

  .asset-manager__content {
    flex: 1;
    overflow-y: auto;
  }

  /* Drag overlay */
  .drag-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--smrt-color-primary) 8%, transparent);
    border: 2px dashed var(--smrt-color-primary, #005ac1);
    border-radius: var(--smrt-radius-large, 0.75rem);
    z-index: 10;
    pointer-events: none;
  }

  .drag-overlay__content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    color: var(--smrt-color-primary, #005ac1);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .drag-overlay__content p {
    margin: 0;
    font-size: var(--smrt-typography-body-large-size, 1.1rem);
  }
</style>
