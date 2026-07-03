/**
 * smrt-assets Svelte components
 *
 * Reusable Asset Manager UI for embedding in downstream SMRT sites.
 * Auto-registers components with ModuleUIRegistry on import so chat
 * (and other registry-driven consumers) can discover them.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import { ASSETS_MODULE_META } from '../ui.js';

// Import components
import ActionBar from './ActionBar.svelte';
import AssetDetail from './AssetDetail.svelte';
import AssetGrid from './AssetGrid.svelte';
import AssetList from './AssetList.svelte';
import AssetManager from './AssetManager.svelte';
import AssetToolbar from './AssetToolbar.svelte';
import CreateAssetModal from './CreateAssetModal.svelte';

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
// Components
export {
  ActionBar,
  AssetDetail,
  AssetGrid,
  AssetList,
  AssetManager,
  AssetToolbar,
  CreateAssetModal,
};

// Auto-register with ModuleUIRegistry
ModuleUIRegistry.registerModule(ASSETS_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-assets',
  'asset-manager',
  AssetManager,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-assets',
  'asset-grid',
  AssetGrid,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-assets',
  'asset-list',
  AssetList,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-assets',
  'asset-detail',
  AssetDetail,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-assets',
  'asset-toolbar',
  AssetToolbar,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-assets',
  'asset-action-bar',
  ActionBar,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-assets',
  'asset-create-modal',
  CreateAssetModal,
);
