# @have/assets SPEC.md

## Design Notes

This document outlines the database schema for the `@have/assets` package. The architecture is designed for consistency, extensibility, and robust management of digital assets.

The key architectural decisions are:
1.  **A Central `assets` Table**: A single table holds all primary asset records, which are logical pointers to digital files. This table is linked to lookup tables to define an asset's nature and status.
2.  **Controlled EAV for Metadata**: We use a controlled Entity-Attribute-Value model. The `asset_metafields` table defines a vocabulary of allowed keys (e.g., 'width', 'duration'), ensuring data consistency, while the `asset_metadata` table stores the corresponding values.
3.  **Slug-Based Primary Keys**: For all lookup tables (`asset_types`, `asset_statuses`, `asset_metafields`), we use a human-readable `slug` as the primary key. This improves database readability and simplifies queries.
4.  **Tagging via @have/tags**: Assets use the reusable `@have/tags` package for tagging. The `asset_tags` join table connects assets to tags.
5.  **Ownership & Permissions**: Every asset has an `owner_profile_id` (nullable), linking it to the `@have/profiles` package. For more granular control, an `asset_permissions` table can be used to grant access to specific profiles or groups, though this is not a default requirement.
6.  **Lifecycle and Versioning**: Assets have a `status_slug` (e.g., 'draft', 'published') to manage their lifecycle. A comprehensive versioning system is included to track an asset's history.
7.  **Derivatives**: The `parent_id` field allows for linking derivative assets (e.g., a thumbnail) to their original source asset.

---

## Core Tables

### Lookup Tables

#### `asset_types`
Defines the high-level type of an asset.
-   `slug`: (String, Primary Key) - e.g., 'image', 'video', 'document', 'folder'.
-   `name`: (String) - e.g., 'Image', 'Video'.
-   `description`: (Text, Nullable).

#### `asset_statuses`
Defines the lifecycle status of an asset.
-   `slug`: (String, Primary Key) - e.g., 'draft', 'published', 'archived'.
-   `name`: (String) - e.g., 'Draft', 'Published'.
-   `description`: (Text, Nullable).

#### Tagging Integration
Assets use the `@have/tags` package for tagging functionality. See `@have/tags` SPEC.md for full details.

Tags are referenced via the `tag_slug` field in the `asset_tags` join table, which references `tags.slug` from the `@have/tags` package.

#### `asset_metafields`
Defines the controlled vocabulary for metadata keys.
-   `slug`: (String, Primary Key) - e.g., 'width', 'height', 'duration', 'author'.
-   `name`: (String) - e.g., 'Width', 'Height'.
-   `validation`: (JSON, Nullable) - e.g., `{ "type": "integer", "min": 0 }`.

### Primary and Join Tables

#### `assets`
The core table for storing asset records.
-   `id`: (UUID, Primary Key) - The unique identifier for the asset record.
-   `type_slug`: (String, FK to `asset_types.slug`) - The asset's high-level type.
-   `status_slug`: (String, FK to `asset_statuses.slug`) - The asset's current lifecycle status.
-   `owner_profile_id`: (UUID, FK to `profiles.id`, Nullable) - The profile that owns this asset. Can be NULL for system-owned or unassigned assets.
-   `name`: (String) - A user-friendly name for the asset (e.g., "My Vacation Photo").
-   `slug`: (String, Unique) - A URL-friendly slug for the asset.
-   `source_uri`: (String) - The URI of the actual file blob (e.g., 's3://bucket/key', 'file:///path/to/file').
-   `mime_type`: (String) - The specific MIME type of the file (e.g., 'image/jpeg').
-   `description`: (Text, Nullable).
-   `parent_id`: (UUID, FK to `assets.id`, Nullable) - Points to the original asset if this is a derivative (e.g., a thumbnail).
-   `version`: (Integer, Default: 1) - The version number for this asset.
-   `primary_version_id`: (UUID, FK to `assets.id`) - The stable identifier for an asset. For the first version, this is set to its own `id`. For subsequent versions, it points to the `id` of the first version. This ID is used to retrieve the latest version of an asset.
-   `created_at`: (Datetime).
-   `updated_at`: (Datetime).

#### `asset_tags`
The join table connecting assets to tags from `@have/tags`.
-   `asset_id`: (UUID, FK to `assets.id`, ON DELETE CASCADE) - The asset being tagged.
-   `tag_slug`: (String, FK to `tags.slug` from `@have/tags`, ON DELETE CASCADE) - The tag applied to the asset.
-   `created_at`: (Datetime) - Timestamp when tag was applied.
-   **Primary Key**: Composite on `(asset_id, tag_slug)` to prevent duplicates.

#### `asset_metadata`
Stores the actual metadata values for each asset.
-   `id`: (UUID, Primary Key).
-   `asset_id`: (UUID, FK to `assets.id`).
-   `metafield_slug`: (String, FK to `asset_metafields.slug`).
-   `value`: (Text).

#### `asset_permissions`
A join table for managing granular asset permissions for profiles.
-   `id`: (UUID, Primary Key).
-   `asset_id`: (UUID, FK to `assets.id`).
-   `profile_id`: (UUID, FK to `profiles.id`) - The profile being granted permission.
-   `permission_level`: (String) - e.g., 'read', 'write', 'admin'.
-   *Constraint*: A `UNIQUE` constraint should be placed on `(asset_id, profile_id)`.

---

## SMRT Integration

The `@have/assets` package will be built on the `@have/smrt` framework, leveraging its AI-first object model, ORM capabilities, and code generation tools. This section outlines how the database schema and core functions translate into a SMRT implementation.

### 1. SMRT Object Implementation

The database tables will be represented as `SmrtObject` classes, with table columns mapped to typed fields.

```typescript
import { SmrtObject, SmrtCollection, smrt, type SmrtObjectOptions } from '@have/smrt';
import type { Tag } from '@have/tags';

/**
 * Options for AssetType initialization
 */
export interface AssetTypeOptions extends SmrtObjectOptions {
  slug?: string;
  name?: string;
  description?: string;
}

/**
 * Options for AssetStatus initialization
 */
export interface AssetStatusOptions extends SmrtObjectOptions {
  slug?: string;
  name?: string;
  description?: string;
}

/**
 * Options for AssetMetafield initialization
 */
export interface AssetMetafieldOptions extends SmrtObjectOptions {
  slug?: string;
  name?: string;
  validation?: string;
}

/**
 * Options for Asset initialization
 */
export interface AssetOptions extends SmrtObjectOptions {
  name?: string;
  slug?: string;
  sourceUri?: string;
  mimeType?: string;
  description?: string;
  version?: number;
  primaryVersionId?: string | null;
  typeSlug?: string;
  statusSlug?: string;
  ownerProfileId?: string | null;
  parentId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

// Lookup Objects
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class AssetType extends SmrtObject {
  slug = ''; // Primary key (human-readable identifier)
  name = ''; // Display name
  description = ''; // Optional description

  constructor(options: AssetTypeOptions = {}) {
    super(options);
    if (options.slug) this.slug = options.slug;
    if (options.name) this.name = options.name;
    if (options.description) this.description = options.description;
  }
}

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class AssetStatus extends SmrtObject {
  slug = ''; // Primary key (human-readable identifier)
  name = ''; // Display name
  description = ''; // Optional description

  constructor(options: AssetStatusOptions = {}) {
    super(options);
    if (options.slug) this.slug = options.slug;
    if (options.name) this.name = options.name;
    if (options.description) this.description = options.description;
  }
}

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class AssetMetafield extends SmrtObject {
  slug = ''; // Primary key (human-readable identifier)
  name = ''; // Display name
  validation = ''; // JSON validation rules stored as text

  constructor(options: AssetMetafieldOptions = {}) {
    super(options);
    if (options.slug) this.slug = options.slug;
    if (options.name) this.name = options.name;
    if (options.validation) this.validation = options.validation;
  }
}

// Core Asset Object
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
})
export class Asset extends SmrtObject {
  // Core fields
  name = ''; // User-friendly name
  slug = ''; // URL-friendly identifier
  sourceUri = ''; // URI to the actual file (e.g., 's3://bucket/key')
  mimeType = ''; // MIME type (e.g., 'image/jpeg')
  description = ''; // Optional description
  version = 1; // Version number

  // Foreign key references (stored as IDs/slugs)
  primaryVersionId: string | null = null; // Points to first version's ID
  typeSlug = ''; // FK to AssetType.slug
  statusSlug = ''; // FK to AssetStatus.slug
  ownerProfileId: string | null = null; // FK to Profile.id (nullable)
  parentId: string | null = null; // FK to Asset.id (for derivatives)

  // Note: Tags are managed via asset_tags join table, not direct relationship
  // Use addTag(), removeTag(), getTags() methods from AssetCollection

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
    if (options.version !== undefined) this.version = options.version;
    if (options.primaryVersionId !== undefined) this.primaryVersionId = options.primaryVersionId;
    if (options.typeSlug) this.typeSlug = options.typeSlug;
    if (options.statusSlug) this.statusSlug = options.statusSlug;
    if (options.ownerProfileId !== undefined) this.ownerProfileId = options.ownerProfileId;
    if (options.parentId !== undefined) this.parentId = options.parentId;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }

  /**
   * Get all tags for this asset from @have/tags
   *
   * @returns Array of Tag instances from @have/tags package
   */
  async getTags(): Promise<Tag[]> {
    // Query asset_tags join table and retrieve Tag instances
    const collection = this.getCollection();
    if (!collection) return [];

    const db = await collection.getDb();
    const rows = await db.prepare(
      'SELECT tag_slug FROM asset_tags WHERE asset_id = ?'
    ).all(this.id);

    // Import Tag and TagCollection dynamically to avoid circular dependencies
    const { Tag } = await import('@have/tags');
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
    const collection = this.getCollection();
    if (!collection) return false;

    const db = await collection.getDb();
    const result = await db.prepare(
      'SELECT COUNT(*) as count FROM asset_tags WHERE asset_id = ? AND tag_slug = ?'
    ).get(this.id, tagSlug) as { count: number };

    return result.count > 0;
  }
}
```

### 2. Collection Implementation

The `AssetCollection` extends `SmrtCollection` to provide collection-level operations including tag management from `@have/tags`.

```typescript
import { SmrtCollection } from '@have/smrt';
import { Asset } from './asset';

export class AssetCollection extends SmrtCollection<Asset> {
  static readonly objectClass = Asset;

  /**
   * Add a tag to an asset (uses @have/tags)
   *
   * @param assetId - The asset ID to tag
   * @param tagSlug - The tag slug from @have/tags
   */
  async addTag(assetId: string, tagSlug: string): Promise<void> {
    const db = await this.getDb();
    await db.prepare(
      'INSERT OR IGNORE INTO asset_tags (asset_id, tag_slug, created_at) VALUES (?, ?, ?)'
    ).run(assetId, tagSlug, new Date().toISOString());
  }

  /**
   * Remove a tag from an asset
   *
   * @param assetId - The asset ID
   * @param tagSlug - The tag slug to remove
   */
  async removeTag(assetId: string, tagSlug: string): Promise<void> {
    const db = await this.getDb();
    await db.prepare(
      'DELETE FROM asset_tags WHERE asset_id = ? AND tag_slug = ?'
    ).run(assetId, tagSlug);
  }

  /**
   * Get all assets with a specific tag
   *
   * @param tagSlug - The tag slug to filter by
   * @returns Array of assets with this tag
   */
  async getByTag(tagSlug: string): Promise<Asset[]> {
    const db = await this.getDb();
    const rows = await db.prepare(
      'SELECT asset_id FROM asset_tags WHERE tag_slug = ?'
    ).all(tagSlug) as { asset_id: string }[];

    const assets: Asset[] = [];
    for (const row of rows) {
      const asset = await this.get({ id: row.asset_id });
      if (asset) assets.push(asset);
    }

    return assets;
  }

  /**
   * Get assets by type
   *
   * @param typeSlug - The asset type slug (e.g., 'image', 'video')
   * @returns Array of assets matching the type
   */
  async getByType(typeSlug: string): Promise<Asset[]> {
    return this.list({ where: { typeSlug } });
  }

  /**
   * Get assets by status
   *
   * @param statusSlug - The asset status slug (e.g., 'published', 'draft')
   * @returns Array of assets matching the status
   */
  async getByStatus(statusSlug: string): Promise<Asset[]> {
    return this.list({ where: { statusSlug } });
  }
}
```

**Filesystem Integration Note**: The `sourceUri` field can reference any storage backend via `@have/files` package (local filesystem, S3, Google Cloud Storage, etc.). Applications should use `@have/files` adapters for all file operations, keeping the Asset model storage-agnostic.

### 3. AI-Powered Operations

SMRT's `is()` and `do()` methods enable intelligent asset management capabilities.

-   **Auto-tagging**: Use `is()` to determine if an image contains certain features
-   **Description Generation**: Use `do()` to generate descriptions from image content
-   **Content Moderation**: Use `is()` to check for inappropriate content
-   **Smart Organization**: AI-powered categorization and metadata extraction

```typescript
// Asset class can use inherited SMRT AI methods
const asset = await assets.get({ id: assetId });

// Generate description from image content
if (asset.mimeType.startsWith('image/')) {
  asset.description = await asset.do('Generate a brief, descriptive caption for this image.');
  await asset.save();
}

// Check for specific features
const hasFeature = await asset.is('Does this image contain a person?');

// Auto-suggest tags based on content
const suggestedTags = await asset.do('Suggest 3-5 relevant tags for this asset as a JSON array');

// Content moderation
const isSafe = await asset.is('Is this image safe for work and appropriate for all audiences?');
```

### 4. Automatic Code Generation

The `@smrt()` decorator automatically generates multiple interfaces:

-   **REST API**: Automatic endpoint generation for web applications
-   **CLI Commands**: Built-in command-line interface for administrative tasks
-   **MCP Tools**: AI-accessible tools for intelligent asset management

These are generated automatically via the `@smrt()` decorator configuration:

```typescript
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },  // REST API endpoints
  mcp: { include: ['list', 'get', 'create', 'update'] },            // AI tools
  cli: true                                                          // CLI commands
})
export class Asset extends SmrtObject {
  // ... class definition
}
```

**Generated Endpoints**:
- `GET /api/assets` - List assets with filtering
- `GET /api/assets/:id` - Get specific asset
- `POST /api/assets` - Create new asset
- `PUT /api/assets/:id` - Update asset
- `DELETE /api/assets/:id` - Delete asset

**Generated CLI Commands**:
- `smrt assets list [options]` - List assets
- `smrt assets get <id>` - Get asset details
- `smrt assets create <data>` - Create new asset
- `smrt assets update <id> <data>` - Update asset

**Generated MCP Tools**:
- `list_assets(filters)` - AI-accessible asset listing
- `get_asset(id)` - AI-accessible asset retrieval
- `create_asset(data)` - AI-accessible asset creation
- `update_asset(id, data)` - AI-accessible asset updates

---

## Core Functions

### Asset Lifecycle & Versioning
-   `createAsset(data)`: Creates a new asset (version 1). Requires `ownerProfileId`, `typeSlug`, `name`, `sourceUri`. Returns the new asset record, including its `primary_version_id`.
-   `getAsset(primary_version_id)`: Retrieves the latest version of an asset.
-   `listAssetVersions(primary_version_id)`: Retrieves the complete history of an asset, ordered by version.
-   `createNewAssetVersion(primary_version_id, newSourceUri)`: Creates a new version of an existing asset.
-   `updateAsset(version_id, data)`: Updates non-content fields (e.g., `name`, `description`) on a *specific* version of an asset.
-   `deleteAssetVersion(version_id)`: Deletes a single, specific version of an asset.
-   `deleteAllAssetVersions(primary_version_id)`: Permanently deletes all versions of an asset.

### Metadata & Status
-   `setAssetStatus(version_id, statusSlug)`: Changes the lifecycle status of a specific asset version.
-   `getAssetMetadata(version_id)`: Retrieves all metadata for a specific asset version.
-   `setAssetMetadata(version_id, metafieldSlug, value)`: Sets a single metadata value on a specific asset version.

### Tagging (via @have/tags integration)
-   `addTag(tagSlug)`: Associates a tag with this asset (uses `@have/tags` package).
-   `removeTag(tagSlug)`: Removes a tag from this asset.
-   `getTags()`: Retrieves all tags for this asset as Tag objects.
-   `hasTag(tagSlug)`: Checks if asset has a specific tag.

**Note**: Tags are managed through the `@have/tags` package. The `asset_tags` join table connects assets to tags. See `@have/tags` SPEC.md for tag hierarchy, aliases, and multi-language support.

### Permissions
-   `grantPermission(primary_version_id, profile_id, permission_level)`: Grants a profile permission to an asset.
-   `revokePermission(primary_version_id, profile_id)`: Revokes a profile's permission from an asset.
