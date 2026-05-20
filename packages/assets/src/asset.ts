/**
 * Asset model - Core entity for asset management
 *
 * Represents a digital asset with versioning, metadata, and tag support.
 * Supports multi-tenancy with optional tenant scoping.
 *
 * Post R3-D: `parentId` was renamed to `sourceAssetId` to reflect what
 * the column actually means — a derivation pointer ("this asset was
 * produced from that source asset"), not a structural-hierarchy edge.
 * Folder, which used `parent_id` for actual hierarchy via STI on this
 * table, has moved to its own `folders` table. See `folder.ts` and the
 * `R3-D` changeset for the migration.
 */

import {
  ObjectRegistry,
  type SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { Tag } from '@happyvertical/smrt-tags';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { AssetAssociation } from './asset-association';
import { AssetAssociationCollection } from './asset-associations';
import { AssetStatus } from './asset-status';
import { AssetType } from './asset-type';
import type { AssetOptions } from './types';

export interface AssetExternalReference {
  provider: string;
  assetId?: string | null;
  externalId?: string | null;
  sourceRef?: Record<string, unknown> | null;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
  syncedAt?: string | null;
  [key: string]: unknown;
}

function parseAssetRecord(
  value: string | Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== 'string') return value;
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringifyAssetRecord(
  value: Record<string, unknown> | null | undefined,
): string {
  if (!value || Object.keys(value).length === 0) return '';
  return JSON.stringify(value);
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
})
export class Asset extends SmrtObject {
  // Tenant isolation (optional - assets can be global or tenant-specific)
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  // Core fields
  name = ''; // User-friendly name
  // slug is inherited as an accessor from SmrtObject
  sourceUri = ''; // URI to the actual file (e.g., 's3://bucket/key', 'file:///path')
  mimeType = ''; // MIME type (e.g., 'image/jpeg', 'video/mp4')
  description = ''; // Optional description
  metadata = ''; // JSON metadata owned by SMRT asset processors
  version = 1; // Version number

  // Foreign key references (stored as IDs/slugs)
  primaryVersionId: string | null = null; // Points to first version's ID
  typeSlug = ''; // FK to AssetType.slug
  statusSlug = ''; // FK to AssetStatus.slug
  ownerProfileId: string | null = null; // FK to Profile.id (nullable)
  /**
   * FK to the source Asset this one was derived from (e.g. thumbnail
   * derived from an original image, transcoded video, AI variation).
   *
   * Renamed from `parentId` in R3-D to make the derivation semantics
   * explicit and free `parentId` to mean exactly structural hierarchy
   * (SmrtHierarchical) across the framework. The column on the assets
   * table is `source_asset_id`.
   */
  sourceAssetId: string | null = null;
  folderId: string | null = null; // FK to Folder.id

  // Provenance fields
  sourceType = ''; // 'local', 'shutterstock', 'google-photos', 'upstream-smrt'
  externalId = ''; // Original ID in upstream source
  externalRefs = ''; // JSON map of provider references, keyed by provider slug

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: AssetOptions = {}) {
    super(options);
    if (options.name) this.name = options.name;
    if (options.slug) this.slug = options.slug;
    if (options.sourceUri) this.sourceUri = options.sourceUri;
    if (options.mimeType) this.mimeType = options.mimeType;
    if (options.description) this.description = options.description;
    if (options.metadata !== undefined)
      this.metadata =
        typeof options.metadata === 'string'
          ? options.metadata
          : stringifyAssetRecord(options.metadata);
    if (options.version !== undefined) this.version = options.version;
    if (options.primaryVersionId !== undefined)
      this.primaryVersionId = options.primaryVersionId;
    if (options.typeSlug) this.typeSlug = options.typeSlug;
    if (options.statusSlug) this.statusSlug = options.statusSlug;
    if (options.ownerProfileId !== undefined)
      this.ownerProfileId = options.ownerProfileId;
    if (options.sourceAssetId !== undefined)
      this.sourceAssetId = options.sourceAssetId;
    if (options.folderId !== undefined) this.folderId = options.folderId;
    if (options.sourceType) this.sourceType = options.sourceType;
    if (options.externalId) this.externalId = options.externalId;
    if (options.externalRefs !== undefined)
      this.externalRefs =
        typeof options.externalRefs === 'string'
          ? options.externalRefs
          : stringifyAssetRecord(options.externalRefs);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId as any;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }

  getMetadata(): Record<string, unknown> {
    return parseAssetRecord(this.metadata);
  }

  setMetadata(metadata: Record<string, unknown>): void {
    this.metadata = stringifyAssetRecord(metadata);
  }

  mergeMetadata(metadata: Record<string, unknown>): void {
    this.setMetadata({
      ...this.getMetadata(),
      ...metadata,
    });
  }

  getExternalRefs(): Record<string, AssetExternalReference> {
    const refs = parseAssetRecord(this.externalRefs);
    const normalized: Record<string, AssetExternalReference> = {};
    for (const [provider, value] of Object.entries(refs)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        normalized[provider] = {
          ...(value as Record<string, unknown>),
          provider,
        } as AssetExternalReference;
      }
    }
    return normalized;
  }

  getExternalRef(provider: string): AssetExternalReference | null {
    return this.getExternalRefs()[provider] ?? null;
  }

  setExternalRef(
    provider: string,
    reference: Omit<AssetExternalReference, 'provider'> & { provider?: string },
  ): void {
    this.externalRefs = stringifyAssetRecord({
      ...this.getExternalRefs(),
      [provider]: {
        ...(this.getExternalRef(provider) ?? {}),
        ...reference,
        provider: reference.provider ?? provider,
      },
    });
  }

  /**
   * Get all tags for this asset from @happyvertical/smrt-tags
   *
   * @returns Array of Tag instances from @happyvertical/smrt-tags package
   */
  async getTags(): Promise<Tag[]> {
    // Query asset_tags join table and retrieve Tag instances
    const db = this.db;
    const rows = await db.list('asset_tags', {
      where: { asset_id: this.id },
    });

    const tags: Tag[] = [];

    for (const row of rows as { tag_slug: string }[]) {
      const tag = await Tag.getBySlug(row.tag_slug);
      if (tag) tags.push(tag);
    }

    return tags;
  }

  /**
   * Check if this asset has a specific tag
   *
   * @param tagSlug - The slug of the tag to check
   * @returns True if the asset has this tag
   */
  async hasTag(tagSlug: string): Promise<boolean> {
    const db = this.db;
    const rows = await db.list('asset_tags', {
      where: { asset_id: this.id, tag_slug: tagSlug },
    });

    return rows.length > 0;
  }

  /**
   * Resolve the AssetCollection lazily. Going through `ObjectRegistry`
   * mirrors the pattern used by `SmrtHierarchical._hierarchyCollection`
   * so source/derivative lookups inherit tenant scoping and ORM
   * hydration without hard-coding an import of `./assets` (which would
   * create a module-import cycle).
   *
   * The return type is `SmrtCollection<Asset>` (the framework base, type-
   * only import from core) rather than the concrete `AssetCollection` —
   * importing the concrete class is what would create the cycle, but the
   * base-class shape gives callers full `.get()` / `.list()` type
   * safety here.
   *
   * R5-canon: use the qualified-name lookup so a different package
   * also registering a class called `Asset` can't be picked by
   * `findClass`'s multi-strategy fallback. The constructor-side
   * `_smrtQualifiedName` static (set at registration) is read off
   * `this.constructor`; falls back to the literal package-qualified
   * key for the early-construction path before registration completes.
   */
  private async _assetCollection(): Promise<SmrtCollection<Asset>> {
    const lookupKey =
      (this.constructor as unknown as { _smrtQualifiedName?: string })
        ._smrtQualifiedName ?? '@happyvertical/smrt-assets:Asset';
    return await ObjectRegistry.getCollection<Asset>(lookupKey, this.options);
  }

  /**
   * Get the source asset this one was derived from, if any.
   *
   * Renamed from `getParent` in R3-D. The relationship is "I was produced
   * from that asset" (e.g. a thumbnail's source is its original image),
   * not a structural-hierarchy parent.
   *
   * Goes through the AssetCollection so tenant interceptors and ORM
   * hydration apply — important because a tenant-scoped consumer with
   * cross-tenant derivative chains would otherwise return assets from
   * tenants the caller cannot see, and a raw `db.get` returns
   * snake_case rows that leave camelCase props (e.g. `sourceUri`) at
   * their constructor defaults.
   *
   * @returns Source Asset instance, or null if this asset has no source
   */
  async getSource(): Promise<Asset | null> {
    if (!this.sourceAssetId) return null;
    const collection = await this._assetCollection();
    return (await collection.get({ id: this.sourceAssetId })) as Asset | null;
  }

  /**
   * Get all assets derived from this one (e.g. thumbnails, variants,
   * transcodes, AI edits).
   *
   * Renamed from `getChildren` in R3-D to match the derivation
   * semantics. Goes through the AssetCollection so tenant interceptors
   * and ORM hydration apply (see `getSource` for why this matters —
   * the pre-R3-D `getChildren` used raw `db.list`, which both bypassed
   * tenant scoping and dropped camelCase property hydration; that
   * latent breakage is fixed here).
   *
   * @returns Array of derivative Asset instances
   */
  async getDerivatives(): Promise<Asset[]> {
    if (!this.id) return [];
    const collection = await this._assetCollection();
    return (await collection.list({
      where: { sourceAssetId: this.id },
    })) as Asset[];
  }

  /**
   * Get the type of this asset
   *
   * @returns AssetType instance or null
   */
  async getType(): Promise<AssetType | null> {
    if (!this.typeSlug) return null;

    return await AssetType.getBySlug(this.typeSlug);
  }

  /**
   * Get the status of this asset
   *
   * @returns AssetStatus instance or null
   */
  async getStatus(): Promise<AssetStatus | null> {
    if (!this.statusSlug) return null;

    return await AssetStatus.getBySlug(this.statusSlug);
  }

  /**
   * Get all associations for this asset
   *
   * @returns Array of AssetAssociation instances
   */
  async getAssociations(): Promise<AssetAssociation[]> {
    const associations = await AssetAssociationCollection.create({
      db: this.db,
    });
    return await associations.byRight(this.id!);
  }

  /**
   * Associate this asset with a target object
   *
   * @param metaType - Target class name or qualified name (e.g., 'Article' or '@pkg:Article')
   * @param metaId - Target object ID
   * @param role - Association role (default: 'default')
   * @returns The created AssetAssociation
   */
  async associateWith(
    metaType: string,
    metaId: string,
    role = 'default',
  ): Promise<AssetAssociation> {
    const associations = await AssetAssociationCollection.create({
      db: this.db,
    });
    return await associations.attach(metaType, metaId, this.id!, { role });
  }

  /**
   * Get asset by slug
   *
   * @param slug - The slug to search for
   * @returns Asset instance or null
   */
  static async getBySlug(_slug: string): Promise<Asset | null> {
    // Will be auto-implemented by SMRT
    return null;
  }
}
