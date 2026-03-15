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

import type { Asset } from '../asset';
import ActionBar from './ActionBar.svelte';
import AssetDetail from './AssetDetail.svelte';
import AssetGrid from './AssetGrid.svelte';
import AssetList from './AssetList.svelte';
import AssetToolbar from './AssetToolbar.svelte';
import CreateAssetModal from './CreateAssetModal.svelte';
import type {
  AssetAction,
  AssetDbFilters,
  AssetFilters,
  AssetManagerProps,
  AssetSort,
  AssetViewMode,
} from './types';

let {
  tenantId,
  dbFilters = {},
  mode = 'manage',
  accept,
  customActions = [],
  uploader,
  onselect,
  onconfirm,
  initialView = 'grid',
  showFolders = false,
}: AssetManagerProps = $props();

// ─── State ──────────────────────────────────────────────────────────────

let view: AssetViewMode = $state(initialView);
let selectedIds: Set<string> = $state(new Set());
let assets: Asset[] = $state([]);
let loading = $state(false);
let showCreateModal = $state(false);
let showDetail = $state(false);
let detailAsset: Asset | null = $state(null);
let pastedFile: File | null = $state(null);

let filters: AssetFilters = $state({
  search: '',
  types: [],
  tags: [],
  mimePatterns: accept ? [accept] : [],
});

let sort: AssetSort = $state({
  field: 'createdAt',
  direction: 'desc',
});

// ─── Derived ────────────────────────────────────────────────────────────

const selectedAssets = $derived(assets.filter((a) => selectedIds.has(a.id!)));

const hasSelection = $derived(selectedIds.size > 0);

// ─── Handlers ───────────────────────────────────────────────────────────

function handleViewChange(newView: AssetViewMode) {
  view = newView;
}

function handleFilterChange(newFilters: AssetFilters) {
  filters = newFilters;
  // TODO: Trigger data fetch with new filters
}

function handleSortChange(newSort: AssetSort) {
  sort = newSort;
  // TODO: Trigger data re-sort or re-fetch
}

function handleSelectionChange(ids: Set<string>) {
  selectedIds = ids;
  onselect?.(assets.filter((a) => ids.has(a.id!)));
}

function handleClearSelection() {
  selectedIds = new Set();
  onselect?.([]);
}

function handleAssetClick(asset: Asset) {
  // In pick mode, toggle selection on click
  if (mode === 'pick') {
    const next = new Set(selectedIds);
    if (next.has(asset.id!)) {
      next.delete(asset.id!);
    } else {
      next.add(asset.id!);
    }
    handleSelectionChange(next);
  } else {
    // In manage mode, open detail view
    detailAsset = asset;
    showDetail = true;
  }
}

function handleDetailClose() {
  showDetail = false;
  detailAsset = null;
}

async function handleDetailSave(asset: Asset, updates: any) {
  // TODO: Save via collection
  Object.assign(asset, updates);
  console.log('Save asset:', asset.id, updates);
}

function handleAssetDblClick(asset: Asset) {
  if (mode === 'pick') {
    onconfirm?.([asset]);
  }
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
  // TODO: Upload via AssetStore + create record
  showCreateModal = false;
  console.log('Create asset:', data);
}

function handleDelete(toDelete: Asset[]) {
  // TODO: Delete via AssetStore + remove records
  assets = assets.filter((a) => !toDelete.some((d) => d.id === a.id));
  selectedIds = new Set();
  console.log(
    'Delete assets:',
    toDelete.map((a) => a.id),
  );
}

// ─── Paste handler ──────────────────────────────────────────────────────

function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        pastedFile = file;
        showCreateModal = true;
        break;
      }
    }
  }
}

// ─── Drag over the whole manager (delegating to create modal) ───────────

let managerDragOver = $state(false);

function handleManagerDragOver(e: DragEvent) {
  e.preventDefault();
  managerDragOver = true;
}

function handleManagerDragLeave(e: DragEvent) {
  // Only leave if truly exiting the manager container
  const relatedTarget = e.relatedTarget as Node | null;
  const currentTarget = e.currentTarget as Node;
  if (relatedTarget && currentTarget.contains(relatedTarget)) return;
  managerDragOver = false;
}

function handleManagerDrop(e: DragEvent) {
  e.preventDefault();
  managerDragOver = false;
  const file = e.dataTransfer?.files?.[0];
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
    onviewchange={handleViewChange}
    onfilterchange={handleFilterChange}
    onsortchange={handleSortChange}
    onupload={handleUpload}
  />

  <!-- Action Bar (visible when items selected) -->
  <ActionBar
    selectedAssets={selectedAssets}
    {customActions}
    onclearselection={handleClearSelection}
    ondelete={handleDelete}
  />

  <!-- Main content area -->
  <div class="asset-manager__content">
    {#if view === 'grid'}
      <AssetGrid
        {assets}
        {selectedIds}
        {loading}
        onselectionchange={handleSelectionChange}
        onassetclick={handleAssetClick}
        onassetdblclick={handleAssetDblClick}
      />
    {:else if view === 'list'}
      <AssetList
        {assets}
        {selectedIds}
        {sort}
        {loading}
        onselectionchange={handleSelectionChange}
        onassetclick={handleAssetClick}
        onsortchange={handleSortChange}
      />
    {/if}
  </div>

  <!-- Asset Detail Drawer -->
  <AssetDetail
    asset={detailAsset}
    open={showDetail}
    onclose={handleDetailClose}
    onsave={handleDetailSave}
    ondelete={(a) => { handleDelete([a]); handleDetailClose(); }}
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
        <p>Drop file to upload</p>
      </div>
    </div>
  {/if}

  <!-- Create modal or custom uploader -->
  {#if uploader}
    {@render uploader({
      open: showCreateModal,
      initialFile: pastedFile,
      onclose: () => { showCreateModal = false; pastedFile = null; },
      oncreate: handleCreate
    })}
  {:else}
    <CreateAssetModal
      open={showCreateModal}
      initialFile={pastedFile}
      oncreate={handleCreate}
      onclose={() => { showCreateModal = false; pastedFile = null; }}
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
    background: rgba(0, 90, 193, 0.08);
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
    font-weight: 500;
  }

  .drag-overlay__content p {
    margin: 0;
    font-size: 1.1rem;
  }
</style>
