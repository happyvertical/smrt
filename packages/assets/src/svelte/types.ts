/**
 * Asset Manager Svelte component types
 *
 * Shared type definitions for the Asset Manager UI components.
 */

import type { Snippet } from 'svelte';
import type { Asset } from '../asset';

/** View modes for the asset manager */
export type AssetViewMode = 'grid' | 'list';

/** Asset with a guaranteed ID (persisted in DB) */
export interface PersistedAsset extends Asset {
  id: string;
}

/** Operating mode — manage (full CRUD) or pick (select and return) */
export type AssetManagerMode = 'manage' | 'pick';

/** Sort options */
export type AssetSortField = 'name' | 'createdAt' | 'updatedAt' | 'mimeType';
export type AssetSortDirection = 'asc' | 'desc';

export interface AssetSort {
  field: AssetSortField;
  direction: AssetSortDirection;
}

/** Filter state */
export interface AssetFilters {
  /** Search query (matched against name, description, alt text) */
  search: string;
  /** Filter by asset type slugs (e.g., 'image', 'video', 'document') */
  types: string[];
  /** Filter by tag slugs */
  tags: string[];
  /** Filter by MIME type patterns (e.g., 'image/*') */
  mimePatterns: string[];
}

/** Custom action that consumers can add to the toolbar */
export interface AssetAction {
  /** Display label */
  label: string;
  /** Optional icon snippet */
  icon?: Snippet;
  /** Whether this action is destructive (shown in red) */
  destructive?: boolean;
  /** Whether this action supports multiple selected assets */
  multi?: boolean;
  /** Callback when the action is triggered */
  action: (selected: PersistedAsset[]) => void | Promise<void>;
}

/**
 * Arbitrary database-level filters passed to AssetCollection queries.
 * Any key/value pairs here are forwarded as WHERE conditions.
 *
 * @example
 * ```ts
 * // Show only active images in the 'products' domain
 * dbFilters={{ domain: 'products', statusSlug: 'active', typeSlug: 'image' }}
 *
 * // Show assets owned by a specific profile
 * dbFilters={{ ownerProfileId: profile.id }}
 * ```
 */
export type AssetDbFilters = Record<string, unknown>;

export interface AssetManagerUploaderProps {
  /** Whether the uploader modal should be open */
  open: boolean;
  /** Pre-loaded file from a drag-and-drop or paste event on the manager */
  initialFile: File | null;
  /** Callback to close the uploader */
  onClose: () => void;
  /** @deprecated Use onClose */
  onclose?: () => void;
  /** Callback when asset creation/selection is complete */
  onCreate: (data: any) => void;
  /** @deprecated Use onCreate */
  oncreate?: (data: any) => void;
}

/** Props for the main AssetManager component */
export interface AssetManagerProps {
  /** Tenant ID to scope assets to */
  tenantId?: string;
  /** Arbitrary database-level query filters forwarded to AssetCollection */
  dbFilters?: AssetDbFilters;
  /** Operating mode */
  mode?: AssetManagerMode;
  /** MIME type filter (e.g., 'image/*' to only show images) */
  accept?: string;
  /** Custom actions added to the action bar */
  customActions?: AssetAction[];
  /** Optional custom uploader snippet (e.g., to inject ImageUploader from smrt-images) */
  uploader?: Snippet<[AssetManagerUploaderProps]>;
  /** Callback when assets are selected (useful in pick mode) */
  onSelect?: (assets: PersistedAsset[]) => void;
  /** @deprecated Use onSelect */
  onselect?: (assets: PersistedAsset[]) => void;
  /** Callback when an asset is double-clicked or "confirmed" in pick mode */
  onConfirm?: (assets: PersistedAsset[]) => void;
  /** @deprecated Use onConfirm */
  onconfirm?: (assets: PersistedAsset[]) => void;
  /** Initial view mode */
  initialView?: AssetViewMode;
  /** Whether to show folder navigation */
  showFolders?: boolean;
}

/** Props for AssetToolbar */
export interface AssetToolbarProps {
  /** Current view mode */
  view: AssetViewMode;
  /** Current filters */
  filters: AssetFilters;
  /** Current sort */
  sort: AssetSort;
  /** Callback when view changes */
  onViewChange: (view: AssetViewMode) => void;
  /** @deprecated Use onViewChange */
  onviewchange?: (view: AssetViewMode) => void;
  /** Callback when filters change */
  onFilterChange: (filters: AssetFilters) => void;
  /** @deprecated Use onFilterChange */
  onfilterchange?: (filters: AssetFilters) => void;
  /** Callback when sort changes */
  onSortChange: (sort: AssetSort) => void;
  /** @deprecated Use onSortChange */
  onsortchange?: (sort: AssetSort) => void;
  /** Callback when upload is requested */
  onUpload: () => void;
  /** @deprecated Use onUpload */
  onupload?: () => void;
}

/** Props for AssetGrid */
export interface AssetGridProps {
  /** Assets to display */
  assets: PersistedAsset[];
  /** Currently selected asset IDs */
  selectedIds: Set<string>;
  /** Callback when selection changes */
  onSelectionChange: (ids: Set<string>) => void;
  /** Callback when an asset is clicked for detail view */
  onAssetClick: (asset: PersistedAsset) => void;
  /** Callback when an asset is double-clicked */
  onAssetDblClick?: (asset: PersistedAsset) => void;
  /** Whether the grid is loading */
  loading?: boolean;
}

/** Props for AssetList */
export interface AssetListProps {
  /** Assets to display */
  assets: PersistedAsset[];
  /** Currently selected asset IDs */
  selectedIds: Set<string>;
  /** Current sort state */
  sort: AssetSort;
  /** Callback when selection changes */
  onSelectionChange: (ids: Set<string>) => void;
  /** Callback when an asset is clicked for detail view */
  onAssetClick: (asset: PersistedAsset) => void;
  /** Callback when sort changes */
  onSortChange: (sort: AssetSort) => void;
  /** Whether the list is loading */
  loading?: boolean;
}

/** Props for ActionBar */
export interface ActionBarProps {
  /** Currently selected assets */
  selectedAssets: PersistedAsset[];
  /** Custom actions from the consumer */
  customActions?: AssetAction[];
  /** Callback to clear selection */
  onClearSelection: () => void;
  /** @deprecated Use onClearSelection */
  onclearselection?: () => void;
  /** Callback for delete action */
  onDelete: (assets: PersistedAsset[]) => void | Promise<void>;
  /** @deprecated Use onDelete */
  ondelete?: (assets: PersistedAsset[]) => void | Promise<void>;
}
