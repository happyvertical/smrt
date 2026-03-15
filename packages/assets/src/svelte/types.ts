/**
 * Asset Manager Svelte component types
 *
 * Shared type definitions for the Asset Manager UI components.
 */

import type { Snippet } from 'svelte';
import type { Asset } from '../asset';

/** View modes for the asset manager */
export type AssetViewMode = 'grid' | 'list' | 'detail';

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
  action: (selected: Asset[]) => void | Promise<void>;
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
  onclose: () => void;
  /** Callback when asset creation/selection is complete */
  oncreate: (data: any) => void;
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
  onselect?: (assets: Asset[]) => void;
  /** Callback when an asset is double-clicked or "confirmed" in pick mode */
  onconfirm?: (assets: Asset[]) => void;
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
  onviewchange: (view: AssetViewMode) => void;
  /** Callback when filters change */
  onfilterchange: (filters: AssetFilters) => void;
  /** Callback when sort changes */
  onsortchange: (sort: AssetSort) => void;
  /** Callback when upload is requested */
  onupload: () => void;
}

/** Props for AssetGrid */
export interface AssetGridProps {
  /** Assets to display */
  assets: Asset[];
  /** Currently selected asset IDs */
  selectedIds: Set<string>;
  /** Callback when selection changes */
  onselectionchange: (ids: Set<string>) => void;
  /** Callback when an asset is clicked for detail view */
  onassetclick: (asset: Asset) => void;
  /** Callback when an asset is double-clicked */
  onassetdblclick?: (asset: Asset) => void;
  /** Whether the grid is loading */
  loading?: boolean;
}

/** Props for AssetList */
export interface AssetListProps {
  /** Assets to display */
  assets: Asset[];
  /** Currently selected asset IDs */
  selectedIds: Set<string>;
  /** Current sort state */
  sort: AssetSort;
  /** Callback when selection changes */
  onselectionchange: (ids: Set<string>) => void;
  /** Callback when an asset is clicked for detail view */
  onassetclick: (asset: Asset) => void;
  /** Callback when sort changes */
  onsortchange: (sort: AssetSort) => void;
  /** Whether the list is loading */
  loading?: boolean;
}

/** Props for ActionBar */
export interface ActionBarProps {
  /** Currently selected assets */
  selectedAssets: Asset[];
  /** Custom actions from the consumer */
  customActions?: AssetAction[];
  /** Callback to clear selection */
  onclearselection: () => void;
  /** Callback for delete action */
  ondelete: (assets: Asset[]) => void;
}
