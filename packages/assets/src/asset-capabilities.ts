import type { Asset } from './asset';
import type { AssetAssociationCollection } from './asset-associations';
import type { AssetStore, StoreOptions } from './asset-store';
import type { AssetCollection } from './assets';

export type AssetVariantFit = 'cover' | 'contain' | 'inside';
export type AssetCapabilitySource = 'cached' | 'generated' | 'external';

export interface AssetCapabilityRuntime {
  readonly collection: AssetCollection;
  readonly associations: AssetAssociationCollection;
  readonly store: AssetStore;
  storeDerivedAsset(
    source: Asset,
    name: string,
    data: Buffer,
    opts: Omit<StoreOptions, 'sourceAssetId'> & {
      role?: string;
      derivativeMetaType?: string;
      linkAssociation?: boolean;
    },
  ): Promise<Asset>;
}

export interface AssetVariantRequest {
  variant: string;
  width?: number;
  height?: number;
  fit?: AssetVariantFit;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export interface AssetVariantResult {
  asset: Asset;
  variant: string;
  source: AssetCapabilitySource;
  url?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AssetProcessInput {
  runtime: AssetCapabilityRuntime;
  asset: Asset;
  variants?: AssetVariantRequest[];
  metadata?: Record<string, unknown>;
}

export interface AssetProcessResult {
  asset: Asset;
  metadata?: Record<string, unknown> | null;
  variants?: AssetVariantResult[];
  warnings?: string[];
}

export interface AssetEnsureVariantInput {
  runtime: AssetCapabilityRuntime;
  asset: Asset;
  request: AssetVariantRequest;
}

export interface AssetNearbySearchInput {
  runtime: AssetCapabilityRuntime;
  tenantId?: string | null;
  latitude: number;
  longitude: number;
  radiusMeters?: number;
  limit?: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface AssetSearchItem {
  asset?: Asset | null;
  assetId: string;
  origin: string;
  title?: string | null;
  previewUrl?: string | null;
  deliveryUrl?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  distanceMeters?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface AssetSearchResult {
  items: AssetSearchItem[];
  nextCursor?: string | null;
}

export interface AssetExternalSyncInput {
  runtime: AssetCapabilityRuntime;
  asset: Asset;
  externalId?: string | null;
  sourceRef?: AssetExternalSourceRef | null;
  metadata?: Record<string, unknown>;
}

export interface AssetExternalSourceRef {
  system: string;
  id: string;
  kind?: string | null;
}

export interface AssetExternalSyncResult {
  asset: Asset;
  provider: string;
  status: 'ready' | 'pending' | 'skipped';
  externalAssetId?: string | null;
  externalId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AssetWorkflowInputSelection {
  slotKey: string;
  assetIds: string[];
}

export interface AssetWorkflowInput {
  runtime: AssetCapabilityRuntime;
  asset: Asset;
  workflowSlug: string;
  clientRequestId?: string | null;
  name?: string;
  inputSelections?: AssetWorkflowInputSelection[];
  sourceAssetIds?: string[];
  parameters?: Record<string, unknown>;
  requestContext?: Record<string, unknown>;
  requestedPlacement?: string | null;
  priority?: number | null;
}

export interface AssetWorkflowResult {
  provider: string;
  jobId: string;
  status: string;
  idempotent?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface AssetCapabilityProvider {
  readonly name: string;
  processAsset?(input: AssetProcessInput): Promise<AssetProcessResult>;
  ensureVariant?(input: AssetEnsureVariantInput): Promise<AssetVariantResult>;
  searchNearbyAssets?(
    input: AssetNearbySearchInput,
  ): Promise<AssetSearchResult>;
  syncExternalAsset?(
    input: AssetExternalSyncInput,
  ): Promise<AssetExternalSyncResult>;
  submitAssetWorkflow?(input: AssetWorkflowInput): Promise<AssetWorkflowResult>;
}

export type AssetCapabilityName =
  | 'processAsset'
  | 'ensureVariant'
  | 'searchNearbyAssets'
  | 'syncExternalAsset'
  | 'submitAssetWorkflow';

export class AssetCapabilityUnavailableError extends Error {
  constructor(
    public readonly capability: AssetCapabilityName,
    message = `No asset capability provider is registered for ${capability}.`,
  ) {
    super(message);
    this.name = 'AssetCapabilityUnavailableError';
  }
}

export class AssetCapabilitySkippedError extends Error {
  constructor(
    public readonly capability: AssetCapabilityName,
    message: string,
  ) {
    super(message);
    this.name = 'AssetCapabilitySkippedError';
  }
}
