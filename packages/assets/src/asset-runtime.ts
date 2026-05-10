/**
 * AssetRuntime - shared asset runtime surface
 *
 * Bundles the pieces an app or agent needs to work with `smrt-assets`
 * consistently:
 *
 *  - `AssetCollection` for records
 *  - `AssetAssociationCollection` for generic/provenance links
 *  - `AssetStore` for provider-agnostic byte storage
 *  - a single `ProviderOptions` that wires storage in one place
 *
 * Agents that want to accept a shared asset runtime should take an
 * `AssetRuntime` (or `AssetRuntimeLike`) in their options, rather than
 * asking callers to hand-wire a collection + store.
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import type { Asset } from './asset';
import type { AssetAssociation } from './asset-association';
import { AssetAssociationCollection } from './asset-associations';
import {
  type AssetCapabilityName,
  type AssetCapabilityProvider,
  AssetCapabilitySkippedError,
  AssetCapabilityUnavailableError,
  type AssetExternalSourceRef,
  type AssetExternalSyncResult,
  type AssetNearbySearchInput,
  type AssetProcessResult,
  type AssetSearchResult,
  type AssetVariantRequest,
  type AssetVariantResult,
  type AssetWorkflowInput,
  type AssetWorkflowResult,
} from './asset-capabilities';
import {
  ASSET_ROLES,
  type AssetExtractionStatus,
  type AssetRole,
} from './asset-conventions';
import {
  AssetStore,
  type AssetStoreOptions,
  type ProviderOptions,
  type StoreOptions,
} from './asset-store';
import { AssetCollection } from './assets';

/**
 * DB configuration accepted by the runtime — mirrors the shape
 * `SmrtCollection.create({ db })` already accepts.
 */
export type AssetRuntimeDb = NonNullable<SmrtClassOptions['db']>;

/**
 * Options for constructing an `AssetRuntime` via `createAssetRuntime()`.
 */
export interface AssetRuntimeOptions {
  /**
   * Database used for `AssetCollection` and `AssetAssociationCollection`.
   *
   * Accepts anything `SmrtCollection.create({ db })` accepts — a string
   * URL, a config object, or a live `DatabaseInterface`.
   */
  db: AssetRuntimeDb;

  /**
   * Storage provider for `AssetStore`.
   *
   * A string is treated as a local filesystem `basePath`; otherwise
   * forwarded to `@happyvertical/files`.
   */
  storage: ProviderOptions;

  /**
   * Optional behavior for the underlying `AssetStore`.
   *
   * Use this to provide a storage resolver while keeping the convenience
   * runtime factory.
   */
  storeOptions?: AssetStoreOptions;

  /**
   * Optional collection instance. If omitted, one is created from `db`.
   * Useful in tests or when the caller already has a configured
   * collection (e.g. from `ObjectRegistry`).
   */
  collection?: AssetCollection;

  /**
   * Optional associations collection. If omitted, one is created from `db`.
   */
  associations?: AssetAssociationCollection;

  /**
   * Optional asset capability providers.
   *
   * Providers let callers keep one app-facing asset runtime while
   * delegating processing, variant generation, search, external sync, or
   * workflow submission to local processors or external systems.
   */
  capabilityProviders?: AssetCapabilityProvider[];
}

/**
 * Structural shape of the runtime. Agents and serving helpers should
 * depend on `AssetRuntimeLike` rather than the concrete class so tests
 * can pass in a minimal object.
 */
export interface AssetRuntimeLike {
  readonly collection: AssetCollection;
  readonly associations: AssetAssociationCollection;
  readonly store: AssetStore;
  readonly capabilityProviders?: readonly AssetCapabilityProvider[];
}

/**
 * Options for `AssetRuntime.storeDerivedAsset()`.
 */
export interface StoreDerivedAssetOptions
  extends Omit<StoreOptions, 'parentId'> {
  /**
   * Relationship role for the derivation link.
   *
   * Defaults to `ASSET_ROLES.DERIVATION_SOURCE` when `linkAssociation`
   * is true (the default). Set explicitly for roles like
   * `document_image` or `thumbnail` when a derivative has a more
   * specific semantic than "came from".
   */
  role?: AssetRole | string;

  /**
   * If true (default), also create an `AssetAssociation` record with
   * `assetId=source.id`, `metaType=<derivativeMetaType>`,
   * `metaId=<newAssetId>`, `role=<role>` so the provenance link is
   * queryable independent of `parentId`.
   *
   * Set to `false` if you only want the hierarchical `parentId` link.
   */
  linkAssociation?: boolean;

  /**
   * `metaType` string stored on the `AssetAssociation`. This describes
   * the *derivative* object (the target of `metaId`), not the source.
   *
   * Defaults to `'Asset'`. Callers whose derivatives are STI subclasses
   * — e.g. an `Image` produced from a PDF — should pass the subclass
   * name here so consumers can distinguish subtype derivatives from
   * plain assets. This matches the convention used by
   * `smrt-images`' `ImageDeriver.deriveWithAssociations()`.
   */
  derivativeMetaType?: string;
}

/**
 * Options for `AssetRuntime.linkDerivation()`.
 */
export interface LinkDerivationOptions {
  role?: AssetRole | string;
  /**
   * `metaType` describing the derivative object (target of `metaId`).
   * See `StoreDerivedAssetOptions.derivativeMetaType`.
   */
  derivativeMetaType?: string;
}

/**
 * Convenience runtime for `smrt-assets` callers. See the package
 * `CLAUDE.md` for the full "source vs derived" vocabulary.
 */
export class AssetRuntime implements AssetRuntimeLike {
  readonly capabilityProviders: AssetCapabilityProvider[];

  constructor(
    public readonly collection: AssetCollection,
    public readonly associations: AssetAssociationCollection,
    public readonly store: AssetStore,
    capabilityProviders: AssetCapabilityProvider[] = [],
  ) {
    this.capabilityProviders = [...capabilityProviders];
  }

  registerCapabilityProvider(provider: AssetCapabilityProvider): this {
    this.capabilityProviders.push(provider);
    return this;
  }

  private providersFor(
    capability: AssetCapabilityName,
  ): AssetCapabilityProvider[] {
    const providers = this.capabilityProviders.filter(
      (candidate) => typeof candidate[capability] === 'function',
    );
    if (providers.length === 0) {
      throw new AssetCapabilityUnavailableError(capability);
    }
    return providers;
  }

  async processAsset(
    asset: Asset,
    input: {
      variants?: AssetVariantRequest[];
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<AssetProcessResult> {
    let skipped: Error | null = null;
    for (const provider of this.providersFor('processAsset')) {
      const processAsset = provider.processAsset;
      if (!processAsset) continue;
      try {
        return await processAsset({
          runtime: this,
          asset,
          ...input,
        });
      } catch (cause) {
        if (cause instanceof AssetCapabilitySkippedError) {
          skipped = cause;
          continue;
        }
        throw cause;
      }
    }
    throw new AssetCapabilityUnavailableError('processAsset', skipped?.message);
  }

  async ensureVariant(
    asset: Asset,
    request: AssetVariantRequest,
  ): Promise<AssetVariantResult> {
    let skipped: Error | null = null;
    for (const provider of this.providersFor('ensureVariant')) {
      const ensureVariant = provider.ensureVariant;
      if (!ensureVariant) continue;
      try {
        return await ensureVariant({
          runtime: this,
          asset,
          request,
        });
      } catch (cause) {
        if (cause instanceof AssetCapabilitySkippedError) {
          skipped = cause;
          continue;
        }
        throw cause;
      }
    }
    throw new AssetCapabilityUnavailableError(
      'ensureVariant',
      skipped?.message,
    );
  }

  async searchNearbyAssets(
    input: Omit<AssetNearbySearchInput, 'runtime'>,
  ): Promise<AssetSearchResult> {
    let skipped: Error | null = null;
    for (const provider of this.providersFor('searchNearbyAssets')) {
      const searchNearbyAssets = provider.searchNearbyAssets;
      if (!searchNearbyAssets) continue;
      try {
        return await searchNearbyAssets({
          runtime: this,
          ...input,
        });
      } catch (cause) {
        if (cause instanceof AssetCapabilitySkippedError) {
          skipped = cause;
          continue;
        }
        throw cause;
      }
    }
    throw new AssetCapabilityUnavailableError(
      'searchNearbyAssets',
      skipped?.message,
    );
  }

  async syncExternalAsset(
    asset: Asset,
    input: {
      externalId?: string | null;
      sourceRef?: AssetExternalSourceRef | null;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<AssetExternalSyncResult> {
    let skipped: Error | null = null;
    for (const provider of this.providersFor('syncExternalAsset')) {
      const syncExternalAsset = provider.syncExternalAsset;
      if (!syncExternalAsset) continue;
      try {
        return await syncExternalAsset({
          runtime: this,
          asset,
          ...input,
        });
      } catch (cause) {
        if (cause instanceof AssetCapabilitySkippedError) {
          skipped = cause;
          continue;
        }
        throw cause;
      }
    }
    throw new AssetCapabilityUnavailableError(
      'syncExternalAsset',
      skipped?.message,
    );
  }

  async submitAssetWorkflow(
    asset: Asset,
    input: Omit<AssetWorkflowInput, 'runtime' | 'asset'>,
  ): Promise<AssetWorkflowResult> {
    let skipped: Error | null = null;
    for (const provider of this.providersFor('submitAssetWorkflow')) {
      const submitAssetWorkflow = provider.submitAssetWorkflow;
      if (!submitAssetWorkflow) continue;
      try {
        return await submitAssetWorkflow({
          runtime: this,
          asset,
          ...input,
        });
      } catch (cause) {
        if (cause instanceof AssetCapabilitySkippedError) {
          skipped = cause;
          continue;
        }
        throw cause;
      }
    }
    throw new AssetCapabilityUnavailableError(
      'submitAssetWorkflow',
      skipped?.message,
    );
  }

  /**
   * Create a new source asset with both a record and bytes on disk.
   *
   * This is the same as `AssetStore.store()`, but exposed on the runtime
   * so callers only need one handle.
   */
  storeSourceAsset(
    name: string,
    data: Buffer,
    opts: StoreOptions,
  ): Promise<Asset> {
    return this.store.store(name, data, opts);
  }

  /**
   * Create a derivative of `source`, persist its bytes, and optionally
   * record a provenance association.
   *
   * The new asset's `parentId` always points at `source.id`. When
   * `linkAssociation` is true (the default), the runtime also writes
   * an `AssetAssociation` so queries by role (e.g. "all `document_image`
   * derivatives for this `source_document`") work without scanning
   * `parent_id` chains.
   */
  async storeDerivedAsset(
    source: Asset,
    name: string,
    data: Buffer,
    opts: StoreDerivedAssetOptions,
  ): Promise<Asset> {
    if (!source.id) {
      throw new Error(
        'storeDerivedAsset: source asset must be persisted (missing id)',
      );
    }

    const {
      role: rawRole,
      linkAssociation = true,
      derivativeMetaType = 'Asset',
      ...storeOpts
    } = opts;
    const role = rawRole ?? ASSET_ROLES.DERIVATION_SOURCE;

    const derived = await this.store.store(name, data, {
      ...storeOpts,
      parentId: source.id,
    });

    if (linkAssociation && derived.id) {
      await this.associations.associate(
        source.id,
        derivativeMetaType,
        derived.id,
        role,
      );
    }

    return derived;
  }

  /**
   * Record a provenance association between an existing source asset
   * and an existing derivative asset without touching bytes.
   */
  async linkDerivation(
    source: Asset,
    derivative: Asset,
    opts: LinkDerivationOptions = {},
  ): Promise<AssetAssociation> {
    if (!source.id || !derivative.id) {
      throw new Error(
        'linkDerivation: both source and derivative must be persisted (missing id)',
      );
    }
    const role = opts.role ?? ASSET_ROLES.DERIVATION_SOURCE;
    const derivativeMetaType = opts.derivativeMetaType ?? 'Asset';
    return this.associations.associate(
      source.id,
      derivativeMetaType,
      derivative.id,
      role,
    );
  }

  /**
   * Update the standard extraction-status metadata on an asset's
   * `description` JSON sidecar. This is a thin convenience over the
   * convention in `asset-conventions.ts` — callers that store
   * metadata elsewhere can ignore it.
   *
   * **How existing descriptions are handled**:
   * - Empty / unset → fresh JSON object.
   * - Valid JSON object → merged into; existing keys preserved.
   * - Free-form prose or non-object JSON → preserved under the
   *   reserved `text` key of the resulting object (e.g.
   *   `{ text: "original prose", extractionStatus: "..." }`). No prose
   *   is discarded.
   *
   * Callers that already use `text` for something else, or that need
   * an entirely separate metadata surface, should either round-trip
   * the JSON themselves or skip this helper — its only job is the
   * `extractionStatus` / `extractionError` / `extractedAt` triple.
   *
   * Error handling: when `status` transitions away from `failed`
   * without a new `extra.error`, the stale `extractionError` is
   * cleared so downstream consumers don't misread the current state.
   * When `status === 'succeeded'`, `extractedAt` is stamped to now
   * unless the caller provides one.
   */
  async setExtractionStatus(
    asset: Asset,
    status: AssetExtractionStatus,
    extra: { error?: string; extractedAt?: Date } = {},
  ): Promise<void> {
    const existing = parseDescriptionSidecar(asset.description);
    const next: Record<string, unknown> = {
      ...existing,
      extractionStatus: status,
    };
    if (extra.error !== undefined) {
      next.extractionError = extra.error;
    } else if (status !== 'failed') {
      // Transitioning out of a prior failure — drop the stale error
      // so consumers don't misread it as still-failing.
      delete next.extractionError;
    }
    if (status === 'succeeded') {
      next.extractedAt = (extra.extractedAt ?? new Date()).toISOString();
    }
    asset.description = JSON.stringify(next);
    await asset.save();
  }
}

/**
 * Factory — lazily creates a shared asset runtime from DB + storage
 * config. Initializes the store's filesystem adapter before returning.
 *
 * @example
 * ```ts
 * import { createAssetRuntime, ASSET_ROLES } from '@happyvertical/smrt-assets';
 *
 * const runtime = await createAssetRuntime({
 *   db: { type: 'sqlite', url: 'app.db' },
 *   storage: { type: 's3', bucket: 'my-app' },
 * });
 *
 * const pdf = await runtime.storeSourceAsset('agenda.pdf', bytes, {
 *   mimeType: 'application/pdf',
 *   typeSlug: 'document',
 * });
 *
 * await runtime.storeDerivedAsset(pdf, 'agenda-p1.png', pageBytes, {
 *   mimeType: 'image/png',
 *   typeSlug: 'image',
 *   role: ASSET_ROLES.DOCUMENT_IMAGE,
 * });
 * ```
 */
export async function createAssetRuntime(
  options: AssetRuntimeOptions,
): Promise<AssetRuntime> {
  const collection =
    options.collection ?? (await AssetCollection.create({ db: options.db }));
  const associations =
    options.associations ??
    (await AssetAssociationCollection.create({ db: options.db }));
  const store = await new AssetStore(
    options.storage,
    collection,
    options.storeOptions,
  ).initialize();
  return new AssetRuntime(
    collection,
    associations,
    store,
    options.capabilityProviders,
  );
}

/**
 * Parse the `description` field as a JSON sidecar object used by
 * `setExtractionStatus()`. Free-form prose and non-object JSON values
 * are preserved under the reserved `text` key so the helper is
 * non-destructive on assets whose descriptions were authored as
 * human-readable text.
 */
function parseDescriptionSidecar(description: string): Record<string, unknown> {
  if (!description) return {};
  try {
    const parsed = JSON.parse(description);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    // Non-object JSON (number, string, array, null) — treat the whole
    // value as prose-equivalent and stash it under `text`.
    return { text: description };
  } catch {
    // Not JSON — preserve the original prose under `text`.
    return { text: description };
  }
}
