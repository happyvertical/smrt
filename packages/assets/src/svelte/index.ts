/**
 * smrt-assets Svelte components
 *
 * Reusable Asset Manager UI for embedding in downstream SMRT sites.
 */

// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import '../__smrt-register__.js';

// Components
export { default as ActionBar } from './ActionBar.svelte';
export { default as AssetDetail } from './AssetDetail.svelte';
export { default as AssetGrid } from './AssetGrid.svelte';
export { default as AssetList } from './AssetList.svelte';
export { default as AssetManager } from './AssetManager.svelte';
export { default as AssetToolbar } from './AssetToolbar.svelte';
export { default as CreateAssetModal } from './CreateAssetModal.svelte';

// Types
export type {
  ActionBarProps,
  AssetAction,
  AssetFilters,
  AssetGridProps,
  AssetListProps,
  AssetManagerMode,
  AssetManagerProps,
  AssetSort,
  AssetSortDirection,
  AssetSortField,
  AssetToolbarProps,
  AssetViewMode,
} from './types';
