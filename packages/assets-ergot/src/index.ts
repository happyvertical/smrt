import type {
  Asset,
  AssetCapabilityProvider,
  AssetExternalSourceRef,
  AssetExternalSyncInput,
  AssetExternalSyncResult,
  AssetNearbySearchInput,
  AssetProcessInput,
  AssetProcessResult,
  AssetSearchResult,
  AssetWorkflowInput,
  AssetWorkflowResult,
} from '@happyvertical/smrt-assets';

export interface ErgotAssetSourceRef {
  system: string;
  id: string;
  kind?: string | null;
}

export interface ErgotAssetSummary {
  id: string;
  name: string;
  mimeType: string;
  typeSlug: string;
  status: string;
  updatedAt: string | null;
  sourceUri: string;
  /**
   * Derivation source on the Ergot side. Mirrors the field Ergot returns
   * over its wire API; do not conflate with `Asset.sourceAssetId` on the
   * local SMRT side. Renaming this would desync this adapter from the
   * upstream service's response shape.
   */
  parentId: string | null;
  version: number;
  width: number;
  height: number;
  alt: string | null;
  thumbnailUri?: string | null;
  sizeBytes?: number | null;
  durationMs?: number | null;
  externalId?: string | null;
  location?: {
    latitude: number;
    longitude: number;
    distanceMeters: number | null;
    recordedAt: string | null;
  } | null;
  tags?: Array<Record<string, unknown>>;
  lineage?: Array<{ objectType: string; objectId: string; role: string }>;
  metadata?: Record<string, unknown> | null;
  deliveryUrl?: string;
  deliveryUrlExpiresAt?: string;
}

export interface ErgotAssetListResult {
  items: ErgotAssetSummary[];
  nextCursor: string | null;
}

export interface ErgotWorkflowInputSelection {
  slotKey: string;
  assetIds: string[];
}

export interface ErgotJobSummary {
  id: string;
  status: string;
  outputAssetIds?: string[];
  [key: string]: unknown;
}

export interface ErgotConsumerAssetClient {
  listAssets(options?: {
    status?: string;
    limit?: number;
    cursor?: string;
    includeCandidates?: boolean;
    externalId?: string;
    sourceRef?: ErgotAssetSourceRef;
  }): Promise<ErgotAssetListResult>;
  listNearbyAssets(options: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
    limit?: number;
  }): Promise<ErgotAssetListResult>;
  uploadAsset(input: {
    file: Blob;
    filename?: string;
    name?: string;
    description?: string | null;
    alt?: string | null;
    typeSlug?: string | null;
    mimeType?: string | null;
    externalId?: string | null;
    sourceRef?: ErgotAssetSourceRef | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<ErgotAssetSummary>;
  submitJob(input: {
    workflowSlug: string;
    clientRequestId?: string | null;
    name?: string;
    inputSelections?: ErgotWorkflowInputSelection[];
    sourceAssetIds?: string[];
    parameters?: Record<string, unknown>;
    requestContext?: Record<string, unknown>;
    requestedPlacement?: string | null;
    priority?: number | null;
  }): Promise<{ job: ErgotJobSummary; idempotent: boolean }>;
}

export interface ErgotAssetProcessorOptions {
  client: ErgotConsumerAssetClient;
  sourceSystem?: string;
}

function requireAssetId(asset: Asset): string {
  if (!asset.id) {
    throw new Error('Ergot asset sync requires a persisted SMRT asset.');
  }
  return asset.id;
}

function defaultSourceRef(
  asset: Asset,
  sourceSystem: string,
): AssetExternalSourceRef {
  return {
    system: sourceSystem,
    kind: asset.typeSlug || 'asset',
    id: requireAssetId(asset),
  };
}

function defaultExternalId(asset: Asset, sourceSystem: string): string {
  const sourceRef = defaultSourceRef(asset, sourceSystem);
  return externalIdFromSourceRef(sourceRef);
}

function externalIdFromSourceRef(sourceRef: AssetExternalSourceRef): string {
  return [sourceRef.system, sourceRef.kind ?? 'asset', sourceRef.id].join(':');
}

type AssetWithExternalRefs = Asset & {
  externalRefs?: string;
  getExternalRefs?: () => Record<string, Record<string, unknown>>;
  setExternalRef?: (
    provider: string,
    reference: Record<string, unknown>,
  ) => void;
};

function parseAssetRecord(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function writeErgotMapping(
  asset: Asset,
  external: ErgotAssetSummary,
  externalId: string,
  sourceRef: AssetExternalSourceRef,
): Promise<void> {
  const structuredAsset = asset as AssetWithExternalRefs;
  const reference = {
    assetId: external.id,
    externalId,
    sourceRef,
    status: external.status,
    thumbnailUri: external.thumbnailUri ?? null,
    deliveryUrl: external.deliveryUrl ?? null,
    syncedAt: new Date().toISOString(),
  };
  if (structuredAsset.setExternalRef) {
    structuredAsset.setExternalRef('ergot', reference);
  } else {
    structuredAsset.externalRefs = JSON.stringify({
      ...(structuredAsset.getExternalRefs?.() ??
        parseAssetRecord(structuredAsset.externalRefs)),
      ergot: {
        provider: 'ergot',
        ...reference,
      },
    });
  }
  await asset.save();
}

function normalizeSourceRef(
  value: AssetExternalSourceRef,
): ErgotAssetSourceRef {
  return {
    system: value.system,
    id: value.id,
    kind: value.kind ?? null,
  };
}

function assetSummaryToSearchItem(asset: ErgotAssetSummary) {
  return {
    assetId: asset.id,
    origin: 'ergot',
    title: asset.name,
    previewUrl:
      asset.thumbnailUri ?? asset.deliveryUrl ?? asset.sourceUri ?? null,
    deliveryUrl: asset.deliveryUrl ?? asset.sourceUri ?? null,
    mimeType: asset.mimeType ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
    distanceMeters: asset.location?.distanceMeters ?? null,
    metadata: asset.metadata ?? null,
  };
}

export function createErgotAssetProcessor(
  options: ErgotAssetProcessorOptions,
): AssetCapabilityProvider {
  const sourceSystem = options.sourceSystem ?? 'smrt-assets';

  async function syncExternalAsset(
    input: AssetExternalSyncInput,
  ): Promise<AssetExternalSyncResult> {
    const assetId = requireAssetId(input.asset);
    const sourceRef =
      input.sourceRef ?? defaultSourceRef(input.asset, sourceSystem);
    const externalId = input.externalId ?? externalIdFromSourceRef(sourceRef);
    const existing = await options.client.listAssets({
      externalId,
      sourceRef: normalizeSourceRef(sourceRef),
      limit: 1,
    });
    let external = existing.items[0] ?? null;
    if (!external) {
      const data = await input.runtime.store.read(input.asset);
      const body = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer;
      external = await options.client.uploadAsset({
        file: new Blob([body], {
          type: input.asset.mimeType || 'application/octet-stream',
        }),
        filename: input.asset.name || assetId,
        name: input.asset.name || assetId,
        description: input.asset.description || null,
        typeSlug: input.asset.typeSlug || null,
        mimeType: input.asset.mimeType || null,
        externalId,
        sourceRef: normalizeSourceRef(sourceRef),
        metadata: {
          ...(input.metadata ?? {}),
          smrt: {
            assetId,
            tenantId: input.asset.tenantId ?? null,
            sourceUri: input.asset.sourceUri,
          },
        },
      });
    }

    await writeErgotMapping(input.asset, external, externalId, sourceRef);
    return {
      asset: input.asset,
      provider: 'ergot',
      status: external.status === 'ready' ? 'ready' : 'pending',
      externalAssetId: external.id,
      externalId,
      metadata: external.metadata ?? null,
    };
  }

  return {
    name: 'smrt-assets-ergot',
    async processAsset(input: AssetProcessInput): Promise<AssetProcessResult> {
      const synced = await syncExternalAsset(input);
      return {
        asset: input.asset,
        metadata: {
          ergot: synced,
        },
      };
    },
    syncExternalAsset,
    async searchNearbyAssets(
      input: AssetNearbySearchInput,
    ): Promise<AssetSearchResult> {
      const result = await options.client.listNearbyAssets({
        latitude: input.latitude,
        longitude: input.longitude,
        radiusMeters: input.radiusMeters ?? 1_500,
        limit: input.limit,
      });
      return {
        items: result.items.map(assetSummaryToSearchItem),
        nextCursor: result.nextCursor,
      };
    },
    async submitAssetWorkflow(
      input: AssetWorkflowInput,
    ): Promise<AssetWorkflowResult> {
      const synced = await syncExternalAsset(input);
      const externalAssetId = synced.externalAssetId;
      if (!externalAssetId) {
        throw new Error(
          'Ergot workflow submission requires a synced Ergot asset.',
        );
      }
      async function syncWorkflowAssetId(assetId: string): Promise<string> {
        const sourceAsset = (await input.runtime.collection.get({
          id: assetId,
        })) as Asset | null;
        if (!sourceAsset?.id) {
          return assetId;
        }
        const ownerTenantId = input.asset.tenantId ?? null;
        if (
          ownerTenantId &&
          sourceAsset.tenantId &&
          sourceAsset.tenantId !== ownerTenantId
        ) {
          throw new Error(
            'Ergot workflow source asset belongs to another tenant.',
          );
        }
        const sourceSync = await syncExternalAsset({
          runtime: input.runtime,
          asset: sourceAsset,
        });
        if (!sourceSync.externalAssetId) {
          throw new Error(
            `Ergot workflow source asset ${assetId} could not be synced.`,
          );
        }
        return sourceSync.externalAssetId;
      }

      const sourceAssetIds = input.sourceAssetIds?.length
        ? await Promise.all(input.sourceAssetIds.map(syncWorkflowAssetId))
        : [externalAssetId];
      if (!sourceAssetIds.includes(externalAssetId)) {
        sourceAssetIds.unshift(externalAssetId);
      }

      const inputSelections = input.inputSelections
        ? await Promise.all(
            input.inputSelections.map(async (selection) => ({
              ...selection,
              assetIds: await Promise.all(
                selection.assetIds.map(syncWorkflowAssetId),
              ),
            })),
          )
        : undefined;

      const job = await options.client.submitJob({
        workflowSlug: input.workflowSlug,
        clientRequestId: input.clientRequestId,
        name: input.name,
        inputSelections: inputSelections as
          | ErgotWorkflowInputSelection[]
          | undefined,
        sourceAssetIds,
        parameters: input.parameters,
        requestContext: {
          ...(input.requestContext ?? {}),
          smrtAssetId: input.asset.id,
          tenantId: input.asset.tenantId ?? undefined,
        },
        requestedPlacement: input.requestedPlacement,
        priority: input.priority,
      });
      return {
        provider: 'ergot',
        jobId: job.job.id,
        status: job.job.status,
        idempotent: job.idempotent,
        metadata: job.job,
      };
    },
  };
}
