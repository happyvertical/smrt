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
  ASSET_ROLES,
  type AssetExtractionStatus,
  type AssetRole,
} from './asset-conventions';
import {
  AssetStore,
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
   * Optional collection instance. If omitted, one is created from `db`.
   * Useful in tests or when the caller already has a configured
   * collection (e.g. from `ObjectRegistry`).
   */
  collection?: AssetCollection;

  /**
   * Optional associations collection. If omitted, one is created from `db`.
   */
  associations?: AssetAssociationCollection;
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
   * `assetId=source.id`, `metaType=<sourceMetaType>`, `metaId=<newId>`,
   * `role=<role>` so the provenance link is queryable independent of
   * `parentId`.
   *
   * Set to `false` if you only want the hierarchical `parentId` link.
   */
  linkAssociation?: boolean;

  /**
   * `metaType` string to use when creating the association. Defaults to
   * `'Asset'`. Callers with STI subclasses (e.g. `Image`) should pass
   * the subclass name here.
   */
  sourceMetaType?: string;
}

/**
 * Options for `AssetRuntime.linkDerivation()`.
 */
export interface LinkDerivationOptions {
  role?: AssetRole | string;
  sourceMetaType?: string;
}

/**
 * Convenience runtime for `smrt-assets` callers. See the package
 * `CLAUDE.md` for the full "source vs derived" vocabulary.
 */
export class AssetRuntime implements AssetRuntimeLike {
  constructor(
    public readonly collection: AssetCollection,
    public readonly associations: AssetAssociationCollection,
    public readonly store: AssetStore,
  ) {}

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
      sourceMetaType = 'Asset',
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
        sourceMetaType,
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
    const sourceMetaType = opts.sourceMetaType ?? 'Asset';
    return this.associations.associate(
      source.id,
      sourceMetaType,
      derivative.id,
      role,
    );
  }

  /**
   * Update the standard extraction-status metadata on an asset's
   * `description` JSON sidecar. This is a thin convenience over the
   * convention in `asset-conventions.ts` — callers that store
   * metadata elsewhere can ignore it.
   */
  async setExtractionStatus(
    asset: Asset,
    status: AssetExtractionStatus,
    extra: { error?: string; extractedAt?: Date } = {},
  ): Promise<void> {
    const existing = safeParseMetadata(asset.description);
    const next: Record<string, unknown> = {
      ...existing,
      extractionStatus: status,
    };
    if (extra.error !== undefined) {
      next.extractionError = extra.error;
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
  const store = await new AssetStore(options.storage, collection).initialize();
  return new AssetRuntime(collection, associations, store);
}

function safeParseMetadata(description: string): Record<string, unknown> {
  if (!description) return {};
  try {
    const parsed = JSON.parse(description);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
