/**
 * Assets Module UI Slot Declarations
 *
 * This file defines the UI extension points for the assets module.
 * UI components are implemented in the ./svelte subpath.
 */

import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

/**
 * Assets module UI slots
 */
export const ASSETS_UI_SLOTS: Record<string, ModuleUISlot> = {
  'asset-manager': {
    id: 'asset-manager',
    label: 'Asset Manager',
    description:
      'Combined asset management surface with toolbar, grid/list view, detail, and selection',
    icon: 'folder-image',
    category: 'admin',
    order: 1,
    propsInterface: 'AssetManagerProps',
  },
  'asset-grid': {
    id: 'asset-grid',
    label: 'Asset Grid',
    description: 'Grid view of asset thumbnails with selection',
    icon: 'grid',
    category: 'list',
    order: 2,
    propsInterface: 'AssetGridProps',
  },
  'asset-list': {
    id: 'asset-list',
    label: 'Asset List',
    description: 'Sortable list view of assets with metadata columns',
    icon: 'list',
    category: 'list',
    order: 3,
    propsInterface: 'AssetListProps',
  },
  'asset-detail': {
    id: 'asset-detail',
    label: 'Asset Detail',
    description: 'Detailed view of a single asset with metadata and preview',
    icon: 'file-text',
    category: 'detail',
    order: 4,
    propsInterface: 'AssetDetailProps',
  },
  'asset-toolbar': {
    id: 'asset-toolbar',
    label: 'Asset Toolbar',
    description: 'Toolbar with view toggle, filters, sort, and upload action',
    icon: 'sliders',
    category: 'action',
    order: 5,
    propsInterface: 'AssetToolbarProps',
  },
  'asset-action-bar': {
    id: 'asset-action-bar',
    label: 'Asset Action Bar',
    description: 'Bulk action bar shown when assets are selected',
    icon: 'more-horizontal',
    category: 'action',
    order: 6,
    propsInterface: 'ActionBarProps',
  },
  'asset-create-modal': {
    id: 'asset-create-modal',
    label: 'Create Asset Modal',
    description: 'Modal dialog for uploading and creating a new asset',
    icon: 'upload',
    category: 'form',
    order: 7,
    propsInterface: 'CreateAssetModalProps',
  },
};

/**
 * Assets module metadata
 */
export const ASSETS_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-assets',
  displayName: 'Assets',
  description:
    'Provider-agnostic asset management with versioning, metadata, folders, and associations',
  uiSlots: ASSETS_UI_SLOTS,
  models: ['Asset', 'AssetType', 'AssetStatus', 'AssetMetafield', 'Folder'],
  collections: [
    'AssetCollection',
    'AssetTypeCollection',
    'AssetStatusCollection',
    'AssetMetafieldCollection',
    'AssetAssociationCollection',
    'FolderCollection',
  ],
};
