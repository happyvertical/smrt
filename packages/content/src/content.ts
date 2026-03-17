import {
  type Asset,
  AssetAssociationCollection,
  AssetCollection,
} from '@happyvertical/smrt-assets';
import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { Image } from '@happyvertical/smrt-images';
import { ImageCollection } from '@happyvertical/smrt-images';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ThumbnailOptions } from './thumbnail-generator';
import { ThumbnailGenerator } from './thumbnail-generator';

/**
 * Options for Content initialization
 */
export interface ContentOptions extends SmrtObjectOptions {
  /**
   * Content type classification
   */
  type?: string | null;

  /**
   * Content variant for namespaced classification within types
   * Format: generator:domain:specific-type
   * Example: "praeco:meeting:upcoming"
   */
  variant?: string | null;

  /**
   * Reference to file storage key
   */
  fileKey?: string | null;

  /**
   * Author of the content
   */
  author?: string | null;

  /**
   * Content title
   */
  title?: string | null;

  /**
   * Short description or summary
   */
  description?: string | null;

  /**
   * Main content body text
   */
  body?: string | null;

  /**
   * Date when content was published
   */
  publish_date?: Date | null;

  /**
   * URL source of the content
   */
  url?: string | null;

  /**
   * Original source identifier
   */
  source?: string | null;

  /**
   * Publication status
   */
  status?: 'published' | 'draft' | 'review' | 'archived' | 'deleted' | null;

  /**
   * Content state flag
   */
  state?: 'deprecated' | 'active' | 'highlighted' | null;

  /**
   * Original URL of the content
   */
  original_url?: string | null;

  /**
   * Content language
   */
  language?: string | null;

  /**
   * Content tags
   */
  tags?: string[];

  /**
   * Hierarchical category path for URL routing
   * Format: 'parent/child' (e.g., 'politics/local')
   * Each content belongs to exactly ONE category
   */
  category?: string | null;

  /**
   * Additional metadata
   */
  metadata?: Record<string, any>;

  /**
   * ID of the thumbnail asset for this content
   */
  thumbnailAssetId?: string | null;

  /**
   * Tenant ID for multi-tenant isolation
   */
  tenantId?: string | null;
}

/**
 * Structured content object with metadata and body text
 *
 * Content represents any text-based content with metadata such as
 * title, author, description, and publishing information. It supports
 * referencing related content objects.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: {
    include: ['list', 'get', 'create', 'update', 'delete'], // Full CRUD operations
  },
  mcp: {
    include: ['list', 'get', 'create', 'update'], // AI tools for content management
  },
  cli: true, // Enable CLI commands for content management
})
export class Content extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global content
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Array of referenced content objects
   */
  protected references: Content[] = [];

  /**
   * Content type classification
   */
  public type: string | null = null;

  /**
   * Content variant for namespaced classification within types
   * Format: generator:domain:specific-type
   * Example: "praeco:meeting:upcoming"
   */
  public variant: string | null = null;

  /**
   * Reference to file storage key
   */
  public fileKey: string | null = null;

  /**
   * Author of the content
   */
  public author: string | null = null;

  /**
   * Human-readable name for SMRT framework compatibility
   */
  @field({ required: true })
  public name: string = '';

  /**
   * Content title
   */
  public title = '';

  /**
   * Short description or summary
   */
  public description: string | null = null;

  /**
   * Main content body text
   */
  public body = '';

  /**
   * Date when content was published
   */
  public publish_date: Date | null = null;

  /**
   * URL source of the content
   */
  public url: string | null = null;

  /**
   * Original source identifier
   */
  public source: string | null = null;

  /**
   * Original URL of the content
   */
  public original_url: string | null = null;

  /**
   * Content language
   */
  public language: string | null = null;

  /**
   * Content tags
   */
  public tags: string[] = [];

  /**
   * Hierarchical category path for URL routing
   * Format: 'parent/child' (e.g., 'politics/local')
   * Each content belongs to exactly ONE category
   */
  public category: string | null = null;

  /**
   * Publication status
   */
  public status: 'published' | 'draft' | 'review' | 'archived' | 'deleted' =
    'draft';

  /**
   * Content state flag
   */
  public state: 'deprecated' | 'active' | 'highlighted' = 'active';

  /**
   * Additional JSON metadata for flexible schema extension
   */
  public metadata: Record<string, any> = {};

  /**
   * ID of the thumbnail asset for this content
   */
  public thumbnailAssetId: string | null = null;

  /**
   * Creates a new Content instance
   */
  constructor(options: ContentOptions = {}) {
    super(options);
    this.type = options.type || null;
    this.variant = options.variant || null;
    this.fileKey = options.fileKey || null;
    this.author = options.author || null;
    if (options.name) this.name = options.name;
    this.title = options.title || '';
    this.description = options.description || null;
    this.body = options.body || '';
    this.publish_date = options.publish_date || null;
    this.source = options.source || null;
    this.original_url = options.original_url || null;
    this.language = options.language || null;
    this.status = options.status || 'draft';
    this.tags = options.tags || [];
    this.category = options.category || null;
    this.state = options.state || 'active';
    this.metadata = options.metadata || {};
    this.thumbnailAssetId = options.thumbnailAssetId ?? null;
  }

  /**
   * Initializes this content object
   *
   * @returns Promise that resolves to this instance
   */
  async initialize(): Promise<this> {
    await super.initialize();
    return this;
  }

  private async getReferenceCollection() {
    const { ContentReferences } = await import('./content-references');
    return ContentReferences.create({ db: this.db });
  }

  private async getContentsCollection() {
    const { Contents } = await import('./contents');
    const contents = new Contents({ db: this.db });
    await contents.initialize();
    return contents;
  }

  private async getAssetCollection() {
    const assets = new AssetCollection({ db: this.db } as any);
    await assets.initialize();
    const ensureStorageReady = (assets as any).ensureStorageReady;
    if (typeof ensureStorageReady === 'function') {
      await ensureStorageReady.call(assets);
    } else {
      await assets.count();
    }
    return assets;
  }

  private async getAssetAssociationCollection() {
    const associations = new AssetAssociationCollection({ db: this.db } as any);
    await associations.initialize();
    const ensureStorageReady = (associations as any).ensureStorageReady;
    if (typeof ensureStorageReady === 'function') {
      await ensureStorageReady.call(associations);
    } else {
      await associations.count();
    }
    return associations;
  }

  private getAssetAssociationMetaType(): string {
    return (this as any)._meta_type || this.constructor.name;
  }

  private async resolveReferenceTarget(content: Content | string) {
    if (typeof content !== 'string') {
      return content;
    }

    const contents = await this.getContentsCollection();

    return (await contents.getOrUpsert(
      {
        url: content,
        tenantId: this.tenantId,
      },
      {
        name: content,
        title: content,
        type: 'reference',
        tenantId: this.tenantId,
      },
    )) as Content;
  }

  /**
   * Loads referenced content objects
   *
   * @returns Promise that resolves when references are loaded
   */
  public async loadReferences() {
    this.references = await this.getReferences();
  }

  /**
   * Adds a reference to another content object
   *
   * @param content - Content object or URL to reference
   * @returns Promise that resolves when the reference is added
   */
  public async addReference(content: Content | string) {
    if (!this.id) {
      throw new Error('Cannot add reference to unsaved content');
    }

    const target = await this.resolveReferenceTarget(content);

    if (!target.id) {
      throw new Error('Cannot add reference to unsaved content');
    }
    if (this.id === target.id) {
      return;
    }

    const references = await this.getReferenceCollection();
    await references.link(this.id, target.id, this.tenantId);
    this.references = await this.getReferences();
  }

  /**
   * Removes a reference to another content object
   *
   * @param targetId - ID of the referenced content to remove
   */
  public async removeReference(targetId: string) {
    if (!this.id) {
      return;
    }

    const references = await this.getReferenceCollection();
    await references.unlink(this.id, targetId);
    this.references = this.references.filter(
      (reference) => reference.id !== targetId,
    );
  }

  /**
   * Gets all referenced content objects
   *
   * @returns Promise resolving to an array of referenced Content objects
   */
  public async getReferences() {
    if (!this.id) {
      return [];
    }

    const references = await this.getReferenceCollection();
    const linkedReferences = await references.getForSource(this.id);
    const targetIds = linkedReferences.map((reference) => reference.targetId);

    if (targetIds.length === 0) {
      this.references = [];
      return this.references;
    }

    const contents = await this.getContentsCollection();
    const resolved = await contents.listByIds(targetIds);
    const referencesById = new Map(
      resolved
        .filter((content) => content.id)
        .map((content) => [content.id as string, content]),
    );

    this.references = targetIds
      .map((targetId) => referencesById.get(targetId))
      .filter(Boolean) as Content[];
    return this.references;
  }

  /**
   * Note: toJSON() is inherited from SmrtObject
   *
   * The parent implementation handles:
   * - STI discriminator (_meta_type) for polymorphic queries
   * - Meta field extraction (_meta_data) for child-specific fields
   * - Automatic serialization of all fields from manifest
   *
   * DO NOT override toJSON() unless you call super.toJSON() first.
   * See issue #377 for details on why this override was removed.
   */

  // ============================================
  // Category Helper Methods
  // ============================================

  /**
   * Get category segments as array
   * @example 'politics/local' -> ['politics', 'local']
   */
  getCategorySegments(): string[] {
    if (!this.category) return [];
    return this.category.split('/').filter(Boolean);
  }

  /**
   * Get parent category path
   * @example 'politics/local/town' -> 'politics/local'
   * @example 'politics' -> null
   */
  getParentCategory(): string | null {
    const segments = this.getCategorySegments();
    if (segments.length <= 1) return null;
    return segments.slice(0, -1).join('/');
  }

  /**
   * Get root (top-level) category
   * @example 'politics/local/town' -> 'politics'
   */
  getRootCategory(): string | null {
    const segments = this.getCategorySegments();
    return segments[0] || null;
  }

  /**
   * Get all ancestor category paths (for breadcrumbs)
   * @example 'politics/local' -> ['politics', 'politics/local']
   */
  getAncestorPaths(): string[] {
    const segments = this.getCategorySegments();
    return segments.map((_, i) => segments.slice(0, i + 1).join('/'));
  }

  /**
   * Check if content belongs to a category (optionally including subcategories)
   * @param categoryPath - Category to check
   * @param includeChildren - If true, matches 'politics' for content in 'politics/local'
   */
  isInCategory(categoryPath: string, includeChildren = true): boolean {
    if (!this.category) return false;
    if (includeChildren) {
      return (
        this.category === categoryPath ||
        this.category.startsWith(`${categoryPath}/`)
      );
    }
    return this.category === categoryPath;
  }

  // ============================================
  // Asset Relationship Methods
  // ============================================

  /**
   * Get all assets associated with this content
   * @param relationship - Optional filter by relationship type (e.g., 'thumbnail', 'attachment')
   * @returns Promise resolving to array of assets
   */
  async getAssets(relationship?: string): Promise<Asset[]> {
    if (!this.id) {
      return [];
    }

    const associations = await this.getAssetAssociationCollection();
    const linkedAssets = relationship
      ? await associations.getForObjectByRole(
          this.getAssetAssociationMetaType(),
          this.id,
          relationship,
        )
      : await associations.getForObject(
          this.getAssetAssociationMetaType(),
          this.id,
        );
    const assetIds = linkedAssets.map((association) => association.assetId);

    if (assetIds.length === 0) {
      return [];
    }

    const assets = await this.getAssetCollection();
    const resolved = await assets.listByIds(assetIds);
    const assetsById = new Map(
      resolved
        .filter((asset) => asset.id)
        .map((asset) => [asset.id as string, asset]),
    );

    return assetIds
      .map((assetId) => assetsById.get(assetId))
      .filter(Boolean) as Asset[];
  }

  /**
   * Add an asset to this content with a relationship type
   * @param asset - The asset to associate
   * @param relationship - Relationship type (e.g., 'thumbnail', 'attachment', 'inline')
   * @param sortOrder - Optional sort order for display
   */
  async addAsset(
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    if (!this.id || !asset.id) {
      throw new Error('Cannot associate unsaved content or asset');
    }

    // Validate relationship - must start with letter/underscore, contain only alphanumeric and underscores
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(relationship)) {
      throw new Error(
        `Invalid relationship type "${relationship}"; must start with a letter or underscore and contain only letters, digits, and underscores`,
      );
    }

    // Validate sortOrder is a reasonable integer
    if (
      !Number.isInteger(sortOrder) ||
      sortOrder < 0 ||
      sortOrder > 2147483647
    ) {
      throw new Error(
        `Invalid sortOrder "${sortOrder}"; must be a non-negative integer`,
      );
    }

    const associations = await this.getAssetAssociationCollection();
    await associations.associate(
      asset.id,
      this.getAssetAssociationMetaType(),
      this.id,
      relationship,
      sortOrder,
    );
  }

  /**
   * Remove an asset from this content
   * @param assetId - ID of the asset to remove
   * @param relationship - Optional specific relationship to remove (removes all if not specified)
   */
  async removeAsset(assetId: string, relationship?: string): Promise<void> {
    if (!this.id) {
      return;
    }

    const associations = await this.getAssetAssociationCollection();
    await associations.dissociate(
      assetId,
      this.getAssetAssociationMetaType(),
      this.id,
      relationship,
    );
  }

  // ============================================
  // Thumbnail Convenience Methods
  // ============================================

  /**
   * Get the thumbnail image for this content
   * @returns Promise resolving to the thumbnail Image or null
   */
  async getThumbnail(): Promise<Image | null> {
    if (!this.thumbnailAssetId) {
      return null;
    }

    const images = await (ImageCollection as any).create({
      db: (this as any).options?.db,
    });

    return images.get({ id: this.thumbnailAssetId });
  }

  /**
   * Set the thumbnail image for this content
   * @param image - The image to set as thumbnail
   */
  async setThumbnail(image: Image): Promise<void> {
    // Add as asset with 'thumbnail' relationship
    await this.addAsset(image, 'thumbnail', 0);

    // Update thumbnailAssetId
    this.thumbnailAssetId = image.id ?? null;
    await this.save();
  }

  /**
   * Generate a thumbnail for this content using the specified strategy
   *
   * @param options - Thumbnail generation options including strategy
   * @returns Promise resolving to the generated Image
   *
   * @example Headline card thumbnail
   * ```typescript
   * const thumbnail = await content.generateThumbnail({
   *   strategy: 'headline-card',
   *   brandColor: '#1a56db',
   *   logoUrl: 'https://example.com/logo.png'
   * });
   * ```
   *
   * @example Static map thumbnail (requires metadata.latitude/longitude)
   * ```typescript
   * const thumbnail = await content.generateThumbnail({
   *   strategy: 'static-map',
   *   mapProvider: 'mapbox'
   * });
   * ```
   *
   * @example AI-generated thumbnail
   * ```typescript
   * const thumbnail = await content.generateThumbnail({
   *   strategy: 'ai-generate'
   * });
   * ```
   */
  async generateThumbnail(options: ThumbnailOptions): Promise<Image> {
    const generator = new ThumbnailGenerator(this, (this as any).options);
    const image = await generator.generate(options);
    await this.setThumbnail(image);
    return image;
  }
}
